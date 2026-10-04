import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import { getAiQuota, isAiActionRequest, settleAiAction } from '../services/aiQuota.js';
import { supabase } from '../services/supabase.js';
import { seedHaccpHazards } from '../test-utils/haccp.js';
import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../services/groq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateHaccpSurveillanceSuggestion: mocks.generate,
}));
const tenants = [];
async function fixture(options) {
  const tenant = await createTenant(options);
  tenants.push(tenant);
  return { ...tenant, id: tenant.tenantId };
}
async function setLimit(table, id, limit) {
  const { error } = await admin.from(table).update({ ai_monthly_limit: limit }).eq('id', id);
  if (error) throw error;
}
async function reserve(tenant, userId = tenant.admin.id) {
  const { data, error } = await admin.rpc('reserve_ai_action', { p_tenant_id: tenant.id, p_user_id: userId });
  if (error) throw error;
  return data;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

describe('Quotas IA atomiques', () => {
  it('est illimité par défaut et sépare les quotas des entreprises et utilisateurs', async () => {
    const a = await fixture({ extraUsers: [{ role: 'member' }] });
    const b = await fixture();
    const snapshot = await getAiQuota(a.id, a.admin.id);
    expect(snapshot.tenant).toEqual({ limit: null, used: 0, pending: 0, remaining: null });
    expect(snapshot.user.limit).toBeNull();
    const action = await reserve(a);
    await settleAiAction(action.action_id, true);
    await settleAiAction(action.action_id, true);
    expect((await getAiQuota(a.id, a.admin.id)).tenant.used).toBe(1);
    expect((await getAiQuota(a.id, a.users[0].id)).user.used).toBe(0);
    expect((await getAiQuota(b.id, b.admin.id)).tenant.used).toBe(0);
    const foreign = await admin.rpc('reserve_ai_action', { p_tenant_id: a.id, p_user_id: b.admin.id });
    expect(foreign.error?.message).toContain('does not belong');
  });

  it('ne dépasse jamais la limite entreprise avec huit réservations simultanées', async () => {
    const tenant = await fixture();
    await setLimit('tenants', tenant.id, 3);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => reserve(tenant)));
    expect(attempts.filter((result) => result.allowed)).toHaveLength(3);
    expect(attempts.filter((result) => !result.allowed)).toHaveLength(5);
    expect(attempts.find((result) => !result.allowed).scope).toBe('tenant');
    const snapshot = await getAiQuota(tenant.id, tenant.admin.id);
    expect(snapshot.tenant).toEqual({ limit: 3, used: 0, pending: 3, remaining: 0 });
    for (const result of attempts.filter((result) => result.allowed)) await settleAiAction(result.action_id, false);
    expect((await reserve(tenant)).allowed).toBe(true);
  });

  it('bloque la limite utilisateur, rembourse les échecs et conserve la consommation après modification', async () => {
    const tenant = await fixture();
    await setLimit('users', tenant.admin.id, 1);
    const first = await reserve(tenant);
    expect((await reserve(tenant)).scope).toBe('user');
    await settleAiAction(first.action_id, false);
    const second = await reserve(tenant);
    await settleAiAction(second.action_id, true);
    await setLimit('users', tenant.admin.id, 0);
    expect((await getAiQuota(tenant.id, tenant.admin.id)).user.used).toBe(1);
    expect((await reserve(tenant)).allowed).toBe(false);
    await setLimit('users', tenant.admin.id, null);
    expect((await reserve(tenant)).allowed).toBe(true);
  });

  it('conserve la consommation entreprise quand un utilisateur est supprimé', async () => {
    const tenant = await fixture({ extraUsers: [{ role: 'member' }] });
    const action = await reserve(tenant, tenant.users[0].id);
    await settleAiAction(action.action_id, true);
    const { error } = await admin.from('users').delete().eq('id', tenant.users[0].id);
    if (error) throw error;
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.used).toBe(1);
  });

  it('ignore le mois précédent et les réservations expirées, sans valider un résultat expiré', async () => {
    const tenant = await fixture();
    await setLimit('tenants', tenant.id, 1);
    const first = await reserve(tenant);
    const { error } = await admin.from('ai_quota_actions').update({ expires_at: '2000-01-01T00:00:00Z' }).eq('id', first.action_id);
    if (error) throw error;
    await expect(settleAiAction(first.action_id, true)).rejects.toThrow('expired');
    const second = await reserve(tenant);
    await settleAiAction(second.action_id, true);
    const updated = await admin.from('ai_quota_actions').update({ month: '2000-01-01' }).eq('id', second.action_id);
    if (updated.error) throw updated.error;
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.used).toBe(0);
    expect((await reserve(tenant)).allowed).toBe(true);
  });

  it('interdit les RPC de quota aux clients publics Supabase', async () => {
    const tenant = await fixture();
    const publicClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${tenant.admin.token}` } },
    });
    const { error } = await publicClient.rpc('reserve_ai_action', { p_tenant_id: tenant.id, p_user_id: tenant.admin.id });
    expect(error?.code).toBe('42501');
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.pending).toBe(0);
    const change = await publicClient.from('users').update({ ai_monthly_limit: 100 }).eq('id', tenant.admin.id);
    expect(change.error?.code).toBe('42501');
    expect((await getAiQuota(tenant.id, tenant.admin.id)).user.limit).toBeNull();
    const company = await publicClient.from('tenants').update({ ai_monthly_limit: 100 }).eq('id', tenant.id);
    expect(company.error?.code).toBe('42501');
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.limit).toBeNull();
  });
});

describe('API de quota IA', () => {
  it('échoue explicitement sans appel IA lorsque le contrôle de quota est indisponible', async () => {
    const tenant = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValueOnce({ data: null, error: { message: 'Unavailable' } });
    const response = await request(app).post('/api/ai/capa-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`).send({ context: 'Un contexte suffisamment long.' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('AI_QUOTA_UNAVAILABLE');
    rpc.mockRestore();
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.pending).toBe(0);
  });

  it('montre uniquement le compte connecté et réserve les réglages au super-admin', async () => {
    const tenant = await fixture({ extraUsers: [{ role: 'member' }] });
    const user = tenant.users[0];
    const response = await request(app).get('/api/ai-quota').set('Authorization', `Bearer ${user.token}`);
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(user.id);
    expect(response.body).not.toHaveProperty('users');
    expect(JSON.stringify(response.body)).not.toContain(tenant.admin.id);
    const denied = await request(app).patch(`/api/ai-quota/tenants/${tenant.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send({ limit: 1 });
    expect(denied.status).toBe(403);
    expect((await request(app).get('/api/ai-quota')).status).toBe(401);
  });

  it('permet au super-admin de configurer les deux limites sans modifier un utilisateur étranger', async () => {
    const tenant = await fixture();
    const other = await fixture();
    const update = await admin.from('users').update({ is_super_admin: true }).eq('id', tenant.admin.id);
    if (update.error) throw update.error;
    const patch = (body) => request(app).patch(`/api/ai-quota/tenants/${tenant.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
    expect((await patch({ limit: 10 })).body.tenant.limit).toBe(10);
    expect((await patch({ limit: 2, user_id: tenant.admin.id })).body.users[0].limit).toBe(2);
    expect((await patch({ limit: null })).body.tenant.limit).toBeNull();
    for (const limit of [-1, 1.5, '2', 1000001, undefined]) {
      expect((await patch({ limit })).status).toBe(400);
    }
    expect((await patch({ limit: 0, user_id: other.admin.id })).status).toBe(404);
    expect((await getAiQuota(other.id, other.admin.id)).user.limit).toBeNull();
    const audit = await admin.from('super_admin_audit_log').select('action').eq('actor_id', tenant.admin.id).eq('action', 'ai_quota_updated');
    expect(audit.data).toHaveLength(3);
  });

  it('compte une seule action HACCP après reprise et rembourse une analyse refusée', async () => {
    const tenant = await fixture();
    const id = randomUUID();
    await seedHaccpHazards(tenant.id, [id]);
    const valid = {
      summary: 'Analyse', suggestions: [{
        hazard_id: id, is_significant: true, control_type: 'undetermined',
        decision_justification: 'Les preuves doivent être documentées.', justification: '',
        routine_monitoring: 'Compléter le dossier.', routine_frequency: 'Avant validation.',
        critical_limits: '', monitoring_procedure: '', monitoring_frequency: '',
        corrective_action_procedure: '', verification_procedure: '', verification_frequency: '', record_keeping_procedure: '',
      }],
    };
    const payload = { planTitle: 'Plan test', steps: [{ name: 'Stockage', hazards: [{
      id, hazard_type: 'biological', description: 'Listeria', likelihood: 2, severity: 4, is_significant: true, has_ccp: false,
    }] }] };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.generate.mockResolvedValueOnce(null).mockResolvedValueOnce(valid);
    const call = () => request(app).post('/api/ai/haccp-surveillance-suggestion')
      .set('X-AI-Regenerate', 'true').set('Authorization', `Bearer ${tenant.admin.token}`).send(payload);
    expect((await call()).status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.used).toBe(1);
    mocks.generate.mockResolvedValue(null);
    expect((await call()).status).toBe(503);
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant).toMatchObject({ used: 1, pending: 0 });
    await setLimit('tenants', tenant.id, 1);
    mocks.generate.mockClear();
    const blocked = await call();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('AI_QUOTA_EXCEEDED');
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('rembourse une requête invalide et bloque toutes les fonctionnalités IA quand la limite est zéro', async () => {
    const tenant = await fixture();
    expect((await request(app).post('/api/ai/capa-suggestion').set('Authorization', `Bearer ${tenant.admin.token}`).send({ context: 'court' })).status).toBe(400);
    expect((await getAiQuota(tenant.id, tenant.admin.id)).tenant.pending).toBe(0);
    await setLimit('tenants', tenant.id, 0);
    const paths = [
      '/ai/capa-suggestion', '/ai/risk-treatment-suggestion', '/ai/haccp-surveillance-suggestion',
      '/ai/haccp-significance-suggestion', '/ai/haccp-ccp-suggestion', '/risks/service-suggestion',
      '/qqoqccp/example/generate', '/pdca/example/generate', '/haccp/steps/example/hazard-suggestion',
      '/audits/example/checklist/generate', '/management-reviews/example/ai-draft',
      '/kpi-imports/example/ai-suggestion', '/procedures/generate-draft', '/procedures/generate-full-draft',
      '/procedures/generate-draft-from-qqoqccp', '/procedures/example/suggest-revision-from-capa',
      ...['check-compliance', 'compliance-fix', 'compare', 'distribution-sheet'].map((action) => `/procedures/example/versions/example/${action}`),
    ];
    for (const path of paths) {
      const response = await request(app).post(`/api${path}`).set('Authorization', `Bearer ${tenant.admin.token}`).send({});
      expect([400, 404], path).toContain(response.status);
      expect(isAiActionRequest({ method: 'POST', baseUrl: '/api', path })).toBe(true);
    }
    expect(isAiActionRequest({ method: 'GET', baseUrl: '/api/ai-quota', path: '/' })).toBe(false);
    expect(isAiActionRequest({ method: 'POST', baseUrl: '/api/procedures', path: '/example/versions' })).toBe(false);
    const blocked = await request(app).post('/api/ai/capa-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`).send({ context: 'Contexte valide de test qualité.' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.scope).toBe('tenant');
  });
});
