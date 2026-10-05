import { afterEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import app from '../app.js';
import { admin, createTenant } from '../test-utils/tenant.js';
import { AI_MODULES, aiModuleForRequest, effectiveAiModules } from '../services/aiModules.js';
import { getAiQuota } from '../services/aiQuota.js';

const tenants = [];
async function fixture() {
  const tenant = await createTenant();
  tenants.push(tenant);
  return tenant;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

const PATHS = {
  problem_guide: ['/ai/problem-guide-search'],
  capas: ['/ai/capa-suggestion'],
  qqoqccp: ['/qqoqccp/example/generate'],
  pdca: ['/pdca/example/generate'],
  risks: ['/risks/service-suggestion', '/ai/risk-treatment-suggestion'],
  haccp: ['/haccp/steps/example/hazard-suggestion', '/ai/haccp-surveillance-suggestion', '/ai/haccp-significance-suggestion', '/ai/haccp-ccp-suggestion'],
  audits: ['/audits/example/checklist/generate'],
  management_reviews: ['/management-reviews/example/ai-draft'],
  procedures: [
    '/procedures/generate-draft', '/procedures/generate-full-draft', '/procedures/generate-draft-from-qqoqccp',
    '/procedures/example/suggest-revision-from-capa',
    ...['check-compliance', 'compliance-fix', 'compare', 'distribution-sheet'].map((action) => `/procedures/example/versions/example/${action}`),
  ],
  kpis: ['/kpi-imports/example/ai-suggestion'],
};

it('ne considère que les endpoints POST IA et tolère la barre finale', () => {
  for (const [module, paths] of Object.entries(PATHS)) {
    for (const path of paths) {
      expect(aiModuleForRequest({ method: 'POST', baseUrl: '/api', path: `${path}/` })).toBe(module);
      expect(aiModuleForRequest({ method: 'GET', baseUrl: '/api', path })).toBeNull();
    }
  }
  expect(aiModuleForRequest({ method: 'POST', baseUrl: '/api', path: '/capas' })).toBeNull();
});

it('refuse les clés inconnues, valeurs null et les configurations non booléennes en base', async () => {
  const tenant = await fixture();
  for (const ai_modules of [{ extra: false }, { haccp: 'false' }, { haccp: null }, [], null]) {
    const result = await admin.from('tenants').update({ ai_modules }).eq('id', tenant.tenantId);
    expect(result.error?.code).toBe(ai_modules === null ? '23502' : '23514');
  }
});

it('active tous les modules par défaut et conserve les fonctions métier', async () => {
  const tenant = await fixture();
  const response = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenant.admin.token}`);
  expect(response.status).toBe(200);
  expect(effectiveAiModules(response.body.ai_modules)).toEqual(Object.fromEntries(AI_MODULES.map((key) => [key, true])));
  const changed = await admin.from('tenants').update({ ai_modules: Object.fromEntries(AI_MODULES.map((key) => [key, false])) }).eq('id', tenant.tenantId);
  if (changed.error) throw changed.error;
  expect((await request(app).get('/api/capas').set('Authorization', `Bearer ${tenant.admin.token}`)).status).toBe(200);
  expect((await request(app).get('/api/ai-quota').set('Authorization', `Bearer ${tenant.admin.token}`)).status).toBe(200);
});

it.each(AI_MODULES)('bloque tous les appels du module %s sans consommer de quota ni affecter un autre tenant', async (module) => {
  const tenant = await fixture();
  const changed = await admin.from('tenants').update({ ai_modules: { [module]: false } }).eq('id', tenant.tenantId);
  if (changed.error) throw changed.error;
  for (const path of PATHS[module]) {
    const response = await request(app).post(`/api${path}`).set('Authorization', `Bearer ${tenant.admin.token}`)
      .send(module === 'problem_guide' ? { query: 'Une situation métier ambiguë' } : {});
    expect(response.status, path).toBe(403);
    expect(response.body.code).toBe('AI_MODULE_DISABLED');
    expect(response.body.module).toBe(module);
  }
  expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 0, pending: 0 });
  const other = await fixture();
  const available = await request(app).post(`/api${PATHS[module][0]}`).set('Authorization', `Bearer ${other.admin.token}`).send({});
  if (module === 'problem_guide') {
    expect(available.body.code).toBe('AI_MODULE_DISABLED');
  } else {
    expect(available.body.code).not.toBe('AI_MODULE_DISABLED');
  }
  expect(available.status).not.toBe(200);
});

it('réserve les réglages au super-admin, valide les clés et journalise les changements', async () => {
  const tenant = await fixture();
  const path = `/api/ai-quota/tenants/${tenant.tenantId}/modules`;
  const settings = effectiveAiModules({ haccp: false, procedures: false });
  const patch = (body) => request(app).patch(path).set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
  expect((await patch(settings)).status).toBe(403);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${tenant.admin.token}` } },
  });
  const direct = await client.from('tenants').update({ ai_modules: settings }).eq('id', tenant.tenantId);
  expect(direct.error?.code).toBe('42501');
  const elevated = await admin.from('users').update({ is_super_admin: true }).eq('id', tenant.admin.id);
  if (elevated.error) throw elevated.error;
  expect((await request(app).get(path).set('Authorization', `Bearer ${tenant.admin.token}`)).body).toEqual(effectiveAiModules({}));
  for (const body of [{}, { ...settings, haccp: 'false' }, { ...settings, extra: false }, []]) {
    expect((await patch(body)).status).toBe(400);
  }
  expect((await patch(settings)).body).toEqual(settings);
  const stored = await request(app).get('/api/tenant').set('Authorization', `Bearer ${tenant.admin.token}`);
  expect(stored.body.ai_modules).toEqual(settings);
  expect((await patch(effectiveAiModules({}))).body.haccp).toBe(true);
  const audit = await admin.from('super_admin_audit_log').select('action').eq('actor_id', tenant.admin.id).eq('action', 'ai_modules_updated');
  expect(audit.data).toHaveLength(2);
});
