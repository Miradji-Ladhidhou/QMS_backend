import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import { effectiveAiModules } from '../services/aiModules.js';
import { aiUsageMonth, summarizeAiUsage } from '../services/aiCommercial.js';
import { getAiQuota, settleAiAction } from '../services/aiQuota.js';
import { reserveGroqCall, finishGroqCall } from '../services/groqQuota.js';
import { runWithRequestContext } from '../services/requestContext.js';

const tenants = [];
const callIds = [];
const userIds = [];
let originalPlan;
const defaults = { monthly_limit: 100, default_user_limit: 20, modules: effectiveAiModules({ haccp: false }) };
async function fixture(extraUsers = []) {
  const tenant = await createTenant({ extraUsers });
  tenants.push(tenant);
  return tenant;
}
async function elevate(tenant) {
  const { error } = await admin.from('users').update({ is_super_admin: true }).eq('id', tenant.admin.id);
  if (error) throw error;
}
async function configure(tenant, settings = defaults) {
  if (!originalPlan) {
    const { data, error } = await admin.from('ai_plans').select('*').eq('key', 'pro').single();
    if (error) throw error;
    originalPlan = data;
  }
  return request(app).patch('/api/ai-quota/plans/pro').set('Authorization', `Bearer ${tenant.admin.token}`).send(settings);
}
async function action(tenant, module, userId = tenant.admin.id) {
  const { data, error } = await admin.rpc('reserve_ai_module_action', { p_tenant_id: tenant.tenantId, p_user_id: userId, p_module: module });
  if (error) throw error;
  expect(data.allowed).toBe(true);
  return data.action_id;
}
const get = (tenant, path) => request(app).get(`/api/ai-quota${path}`).set('Authorization', `Bearer ${tenant.admin.token}`);
const apply = (tenant, id = tenant.tenantId) => request(app).post(`/api/ai-quota/tenants/${id}/plan`)
  .set('Authorization', `Bearer ${tenant.admin.token}`).send({ key: 'pro' });

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalPlan) {
    const { error } = await admin.from('ai_plans').upsert(originalPlan);
    if (error) throw error;
    originalPlan = undefined;
  }
  if (callIds.length) {
    const { error } = await admin.from('groq_quota_calls').delete().in('id', callIds.splice(0));
    if (error) throw error;
  }
  for (const id of userIds.splice(0)) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw error;
  }
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

it('valide les mois et additionne les appels sans multiplier le nombre d’actions', () => {
  expect(aiUsageMonth('2026-02')).toBe('2026-02');
  for (const month of ['', '2026-13', '2026-2', ['2026-02'], '2026-02-01']) expect(aiUsageMonth(month)).toBeNull();
  const metrics = { succeeded: 1, failed: 0, pending: 0, expired: 0, calls: 3, actual_tokens: 30, estimated_tokens: 20, pending_tokens: 10 };
  const report = summarizeAiUsage({ month: '2026-02-01', rows: [
    { module: 'capas', user_id: 'one', full_name: 'One', ...metrics },
    { module: 'risks', user_id: 'one', full_name: 'One', ...metrics },
  ] });
  expect(report.totals).toMatchObject({ succeeded: 2, calls: 6, actual_tokens: 60 });
  expect(report.users).toHaveLength(1);
  expect(report.modules).toHaveLength(2);
});

it('réserve la configuration commerciale au super-admin et interdit les accès SQL directs', async () => {
  const tenant = await fixture([{ role: 'member' }]);
  for (const path of ['/plans', '/alerts', `/tenants/${tenant.tenantId}/commercial`, `/tenants/${tenant.tenantId}/usage`]) {
    expect((await get(tenant, path)).status).toBe(403);
  }
  expect((await configure(tenant)).status).toBe(403);
  expect((await apply(tenant)).status).toBe(403);
  expect((await get(tenant, '/usage')).status).toBe(200);
  expect((await request(app).get('/api/ai-quota/usage').set('Authorization', `Bearer ${tenant.users[0].token}`)).status).toBe(403);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${tenant.admin.token}` } },
  });
  for (const [fn, args] of [
    ['apply_ai_plan', { p_tenant_id: tenant.tenantId, p_plan_key: 'pro' }],
    ['reserve_ai_module_action', { p_tenant_id: tenant.tenantId, p_user_id: tenant.admin.id, p_module: 'capas' }],
    ['reserve_groq_action_call', { p_model: 'test', p_token_budget: 10, p_action_id: tenant.tenantId }],
    ['ai_usage_breakdown', { p_tenant_id: tenant.tenantId, p_month: '2026-01-01' }],
    ['ai_tenant_quota_alerts', {}],
  ]) expect((await client.rpc(fn, args)).error?.code).toBe('42501');
  const direct = await client.from('tenants').update({ ai_default_user_limit: 10 }).eq('id', tenant.tenantId);
  expect(direct.error?.code).toBe('42501');
  expect((await client.from('ai_plans').select('*')).error?.code).toBe('42501');
});

it('exige une configuration valide avant attribution et journalise les changements', async () => {
  const tenant = await fixture();
  await elevate(tenant);
  await configure(tenant);
  const unconfigured = await admin.from('ai_plans').update({ configured: false }).eq('key', 'pro');
  if (unconfigured.error) throw unconfigured.error;
  expect((await apply(tenant)).status).toBe(409);
  for (const settings of [
    { ...defaults, monthly_limit: -1 }, { ...defaults, default_user_limit: 0.5 },
    { ...defaults, modules: { haccp: false } }, { ...defaults, unexpected: true },
  ]) expect((await configure(tenant, settings)).status).toBe(400);
  expect((await configure(tenant)).status).toBe(200);
  expect((await apply(tenant)).status).toBe(200);
  const audit = await admin.from('super_admin_audit_log').select('action').eq('actor_id', tenant.admin.id);
  if (audit.error) throw audit.error;
  expect(audit.data.map((row) => row.action)).toContain('ai_plan_applied');
  expect(audit.data.map((row) => row.action)).toContain('ai_plan_updated');
  expect((await get(tenant, '/tenants/invalid/commercial')).status).toBe(400);
  expect((await get(tenant, '/usage?month=2026-13')).status).toBe(400);
});

it('applique un forfait explicitement, conserve la consommation et les exceptions, sans modifier les autres entreprises', async () => {
  const tenant = await fixture([{ role: 'member' }]);
  const other = await fixture();
  await elevate(tenant);
  const changed = await admin.from('users').update({ ai_monthly_limit: 7 }).eq('id', tenant.users[0].id);
  if (changed.error) throw changed.error;
  const reserved = await action(tenant, 'capas');
  await settleAiAction(reserved, true);
  await configure(tenant);
  expect((await get(tenant, `/tenants/${tenant.tenantId}/commercial`)).body.ai_plan_key).toBeNull();
  const result = await apply(tenant);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ai_monthly_limit: 100, ai_default_user_limit: 20, ai_plan_key: 'pro' });
  const detail = await request(app).get(`/api/super-admin/tenants/${tenant.tenantId}`).set('Authorization', `Bearer ${tenant.admin.token}`);
  expect(detail.body.tenant).toMatchObject({ plan: 'pro', legacy_plan: 'free', ai_plan_key: 'pro' });
  const list = await request(app).get('/api/super-admin/tenants').set('Authorization', `Bearer ${tenant.admin.token}`);
  expect(list.body.find((item) => item.id === tenant.tenantId).plan).toBe('pro');
  expect(list.body.find((item) => item.id === other.tenantId).plan).toBe('manual');
  expect((await getAiQuota(tenant.tenantId, tenant.users[0].id)).user.limit).toBe(7);
  expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant.used).toBe(1);
  expect((await get(tenant, `/tenants/${other.tenantId}/commercial`)).body).toMatchObject({ ai_plan_key: null, ai_monthly_limit: null });
  await configure(tenant, { ...defaults, monthly_limit: 10 });
  expect((await getAiQuota(tenant.tenantId)).tenant.limit).toBe(100);
  expect((await apply(tenant)).body.ai_monthly_limit).toBe(10);
  expect((await getAiQuota(tenant.tenantId)).tenant.used).toBe(1);
  const disabled = await admin.rpc('reserve_ai_module_action', {
    p_tenant_id: tenant.tenantId, p_user_id: tenant.admin.id, p_module: 'haccp',
  });
  expect(disabled.data).toEqual({ allowed: false, scope: 'module' });
});

it('crée une entreprise avec le forfait unique et refuse les anciennes modifications de plan', async () => {
    const tenant = await fixture();
    await elevate(tenant);
    await configure(tenant);
    const auth = `Bearer ${tenant.admin.token}`;
    for (const body of [{ plan: 'enterprise' }, { ai_plan_key: 'pro' }]) {
      expect((await request(app).patch(`/api/super-admin/tenants/${tenant.tenantId}`).set('Authorization', auth).send(body)).status).toBe(400);
    }
    expect((await request(app).post('/api/super-admin/tenants').set('Authorization', auth).send({ name: 'Old plan', plan: 'free' })).status).toBe(400);
    const response = await request(app).post('/api/super-admin/tenants').set('Authorization', auth)
      .send({ name: 'Unified plan test', ai_plan_key: 'pro',
        admin: { email: `unified-founder-${crypto.randomUUID()}@example.com`, full_name: 'Unified founder' } });
    expect(response.status).toBe(201);
    userIds.push(response.body.admin.id);
    try {
      expect(response.body).toMatchObject({ plan: 'pro', ai_plan_key: 'pro', legacy_plan: 'free' });
      expect((await getAiQuota(response.body.id, response.body.admin.id)).user.limit).toBe(20);
      const settings = await get(tenant, `/tenants/${response.body.id}/commercial`);
      expect(settings.body).toMatchObject({ ai_monthly_limit: 100, ai_default_user_limit: 20, ai_modules: defaults.modules });
      const exported = await request(app).get(`/api/super-admin/tenants/${response.body.id}/export`).set('Authorization', auth);
      expect(exported.body.tenant).toMatchObject({ plan: 'pro', legacy_plan: 'free' });
      const stats = await request(app).get('/api/super-admin/stats').set('Authorization', auth);
      expect(stats.body.by_plan.pro).toBeGreaterThanOrEqual(1);
      expect(stats.body.by_plan.manual).toBeGreaterThanOrEqual(1);
      expect(stats.body.by_plan).not.toHaveProperty('free');
    } finally {
      const { error } = await admin.from('tenants').delete().eq('id', response.body.id);
      if (error) throw error;
    }
});

it('copie le quota par défaut sur tous les nouveaux profils, y compris zéro, et ne réécrit aucun ancien quota', async () => {
  const tenant = await fixture();
  await elevate(tenant);
  const patch = (limit) => request(app).patch(`/api/ai-quota/tenants/${tenant.tenantId}/default-user-limit`)
    .set('Authorization', `Bearer ${tenant.admin.token}`).send({ limit });
  for (const limit of [20, 0, null]) {
    expect((await patch(limit)).status).toBe(200);
    const { data, error } = await admin.auth.admin.createUser({ email: `default-limit-${crypto.randomUUID()}@example.com`, email_confirm: true });
    if (error) throw error;
    userIds.push(data.user.id);
    const profile = await admin.from('users').insert({ id: data.user.id, tenant_id: tenant.tenantId, full_name: 'New', role: 'member' })
      .select('ai_monthly_limit').single();
    if (profile.error) throw profile.error;
    expect(profile.data.ai_monthly_limit).toBe(limit);
    expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).user.limit).toBeNull();
  }
  await patch(20);
  const invitation = await request(app).post('/api/users/invite').set('Authorization', `Bearer ${tenant.admin.token}`)
    .send({ email: `default-invite-${crypto.randomUUID()}@example.com`, full_name: 'Invited', role: 'member' });
  expect(invitation.status).toBe(201);
  userIds.push(invitation.body.id);
  expect((await getAiQuota(tenant.tenantId, invitation.body.id)).user.limit).toBe(20);
  expect((await patch(-1)).status).toBe(400);
});

it('ventile actions, reprises, tokens réels/estimés et budgets en cours sans mélanger les entreprises ou les mois', async () => {
  const tenant = await fixture([{ role: 'member' }]);
  const other = await fixture();
  await elevate(tenant);
  const first = await action(tenant, 'capas');
  for (const [budget, tokens] of [[100, 25], [200, null], [300, undefined]]) {
    const id = await runWithRequestContext({ aiQuotaActionId: first }, () => reserveGroqCall('test-model', budget));
    callIds.push(id);
    if (tokens !== undefined) await finishGroqCall(id, tokens === null ? null : { total_tokens: tokens });
  }
  await settleAiAction(first, true);
  const failure = await action(tenant, 'risks', tenant.users[0].id);
  await settleAiAction(failure, false);
  const old = await admin.from('ai_quota_actions').insert({
    tenant_id: tenant.tenantId, user_id: tenant.admin.id, module: 'capas', month: '2000-01-01', status: 'succeeded',
  });
  if (old.error) throw old.error;
  const report = await get(tenant, `/tenants/${tenant.tenantId}/usage`);
  expect(report.status).toBe(200);
  expect(report.body.totals).toEqual({ succeeded: 1, failed: 1, pending: 0, expired: 0, calls: 3, actual_tokens: 25, estimated_tokens: 200, pending_tokens: 300 });
  expect(report.body.modules).toHaveLength(2);
  expect(report.body.users).toHaveLength(2);
  expect((await get(other, '/usage')).body.totals.calls).toBe(0);
  expect((await get(tenant, `/tenants/${tenant.tenantId}/usage?month=2000-01`)).body.totals.succeeded).toBe(1);
  const oldUser = await admin.from('users').delete().eq('id', tenant.users[0].id);
  if (oldUser.error) throw oldUser.error;
  expect((await get(tenant, `/tenants/${tenant.tenantId}/usage`)).body.users.find((user) => user.id === null).failed).toBe(1);
  await expect(runWithRequestContext({ aiQuotaActionId: first }, () => reserveGroqCall('test-model', 10))).rejects.toThrow('Aucun appel envoyé');
});

it('déclenche les alertes au seuil exact de 80 % avec les réservations et les libère après remboursement', async () => {
  const tenant = await fixture();
  await elevate(tenant);
  const changed = await admin.from('tenants').update({ ai_monthly_limit: 5 }).eq('id', tenant.tenantId);
  if (changed.error) throw changed.error;
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await action(tenant, 'capas'));
  expect((await get(tenant, '/alerts')).body.some((row) => row.id === tenant.tenantId)).toBe(false);
  ids.push(await action(tenant, 'capas'));
  const alerted = (await get(tenant, '/alerts')).body.find((row) => row.id === tenant.tenantId);
  expect(alerted).toMatchObject({ limit: 5, used: 0, pending: 4, ratio: 0.8 });
  await settleAiAction(ids[0], false);
  expect((await get(tenant, '/alerts')).body.some((row) => row.id === tenant.tenantId)).toBe(false);
});
