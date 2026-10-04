import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import { createTenant, admin } from '../test-utils/tenant.js';
import app from '../app.js';
import { supabase } from '../services/supabase.js';
import { getAiQuota } from '../services/aiQuota.js';
import { aiScopeKey } from '../services/aiGenerations.js';
import { seedHaccpHazards } from '../test-utils/haccp.js';

const mocks = vi.hoisted(() => ({ capa: vi.fn(), pdca: vi.fn() }));
vi.mock('../services/groq.js', async (importOriginal) => ({
  ...(await importOriginal()),
  generateCapaSuggestion: mocks.capa,
  generatePdcaPhaseSuggestion: mocks.pdca,
}));

const tenants = [];
async function fixture(options) {
  const tenant = await createTenant(options);
  tenants.push(tenant);
  return tenant;
}
const endpoint = '/api/ai/capa-suggestion';
const input = { context: 'Des défauts de traçabilité sont constatés sur les lots.' };
const suggestion = {
  title: 'Défaut de traçabilité', synthesis: 'La traçabilité des lots est incomplète.',
  root_causes: ['Contrôle absent'], suggested_actions: [{ title: 'Vérifier', description: 'Contrôler chaque lot.', suggested_priority: 'high' }],
  preventive_actions: ['Former les équipes'], overall_priority: 'high',
};
function generate(tenant, { id = randomUUID(), regenerate = false, body = input } = {}) {
  return request(app).post(endpoint).set('Authorization', `Bearer ${tenant.admin.token}`)
    .set('X-AI-Request-ID', id).set('X-AI-Regenerate', String(regenerate)).send(body);
}
function read(tenant, token = tenant.admin.token) {
  return request(app).get(`${endpoint}/saved`).set('Authorization', `Bearer ${token}`)
    .query({ input: JSON.stringify(input) });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const tenant of tenants.splice(0)) await tenant.cleanup();
});

describe('Persistance durable des générations IA', () => {
  it('réutilise après navigation, nouvelle session, réouverture et rechargements sans quota ni IA', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    const firstGeneration = await generate(tenant);
    expect(firstGeneration.status).toBe(200);
    const { data: stored, error } = await admin.from('ai_generations').select('*').eq('tenant_id', tenant.tenantId);
    expect(error).toBeNull();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: 'completed', result: suggestion, origin: 'ai' });
    expect(stored[0].quota_action_id).toBeTruthy();
    expect(firstGeneration.headers['x-ai-generation-id']).toBe(stored[0].id);
    const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }).auth;
    const firstSession = await auth.signInWithPassword({ email: tenant.admin.email, password: 'TestPassword123' });
    expect(firstSession.error).toBeNull();
    expect((await read(tenant, firstSession.data.session.access_token)).body.result).toEqual(suggestion);
    await auth.signOut();
    const newSession = await auth.signInWithPassword({ email: tenant.admin.email, password: 'TestPassword123' });
    expect(newSession.error).toBeNull();
    const newSessionToken = newSession.data.session.access_token;
    for (let i = 0; i < 5; i++) {
      const response = await read(tenant, newSessionToken);
      expect(response.status).toBe(200);
      expect(response.body.result).toEqual(suggestion);
    }
    expect((await generate(tenant)).body).toEqual(suggestion);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
    expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 1, pending: 0 });
    await auth.signOut();
  });

  it('affiche une absence sans appeler IA et conserve la lecture quand le quota est épuisé', async () => {
    const tenant = await fixture();
    expect((await read(tenant)).body.result).toBeNull();
    expect(mocks.capa).not.toHaveBeenCalled();
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant).expect(200);
    const { error } = await admin.from('tenants').update({ ai_monthly_limit: 0 }).eq('id', tenant.tenantId);
    expect(error).toBeNull();
    expect((await read(tenant)).body.result).toEqual(suggestion);
    expect((await generate(tenant)).status).toBe(200);
    expect((await generate(tenant, { regenerate: true })).status).toBe(429);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
  });

  it('enregistre les corrections manuelles et leur provenance sans appeler IA ni doubler la sauvegarde', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant).expect(200);
    const edited = { ...suggestion, synthesis: 'Synthèse corrigée par le responsable qualité.' };
    const changes = await Promise.all([1, 2].map(() => request(app).patch(`${endpoint}/saved`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send({ input, result: edited })));
    expect(changes.map((response) => response.status)).toEqual([200, 200]);
    expect(changes[0].body.id).toBe(changes[1].body.id);
    expect((await read(tenant)).body.result).toEqual(edited);
    const { data } = await admin.from('ai_generations').select('origin, previous_id').eq('tenant_id', tenant.tenantId);
    expect(data).toHaveLength(2);
    expect(data.find((row) => row.origin === 'manual').previous_id).toBeTruthy();
    expect(mocks.capa).toHaveBeenCalledTimes(1);
    expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant.used).toBe(1);
  });

  it('régénère uniquement sur demande, conserve la version précédente et rejoue une requête sans tokens', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValueOnce(suggestion);
    await generate(tenant).expect(200);
    const changed = { ...suggestion, synthesis: 'Nouvelle proposition volontaire.' };
    mocks.capa.mockResolvedValueOnce(changed);
    const id = randomUUID();
    expect((await generate(tenant, { id, regenerate: true })).body).toEqual(changed);
    expect((await generate(tenant, { id, regenerate: true })).body).toEqual(changed);
    expect((await read(tenant)).body.result).toEqual(changed);
    const { data } = await admin.from('ai_generations').select('*').eq('tenant_id', tenant.tenantId).order('created_at');
    expect(data).toHaveLength(2);
    expect(data[1].previous_id).toBe(data[0].id);
    expect(mocks.capa).toHaveBeenCalledTimes(2);
  });

  it('empêche huit clics concurrents de produire plusieurs appels ou sauvegardes', async () => {
    const tenant = await fixture();
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    mocks.capa.mockImplementation(async () => { await pending; return suggestion; });
    const id = randomUUID();
    const first = generate(tenant, { id }).then((response) => response);
    await vi.waitFor(() => expect(mocks.capa).toHaveBeenCalledTimes(1));
    const repeats = await Promise.all(Array.from({ length: 7 }, (_, index) =>
      generate(tenant, { id: index % 2 ? id : randomUUID() })));
    expect(repeats.every((response) => response.status === 409)).toBe(true);
    finish();
    expect((await first).status).toBe(200);
    const { data } = await admin.from('ai_generations').select('id').eq('tenant_id', tenant.tenantId);
    expect(data).toHaveLength(1);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
  });

  it('supprime le résultat sans IA et ne ressuscite aucune ancienne version', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant).expect(200);
    await generate(tenant, { regenerate: true }).expect(200);
    await request(app).delete(`${endpoint}/saved`).set('Authorization', `Bearer ${tenant.admin.token}`)
      .query({ input: JSON.stringify(input) }).expect(200);
    expect((await read(tenant)).body.result).toBeNull();
    expect(mocks.capa).toHaveBeenCalledTimes(2);
  });

  it('isole les résultats entre deux tenants et deux comptes, même avec contexte et identifiant identiques', async () => {
    const a = await fixture({ extraUsers: [{ role: 'member' }] });
    const b = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    const id = randomUUID();
    await generate(a, { id }).expect(200);
    expect((await read(b)).body.result).toBeNull();
    expect((await read(a, a.users[0].token)).body.result).toBeNull();
    await generate(b, { id }).expect(200);
    expect(mocks.capa).toHaveBeenCalledTimes(2);
    expect((await getAiQuota(a.tenantId, a.admin.id)).tenant.used).toBe(1);
    expect((await getAiQuota(b.tenantId, b.admin.id)).tenant.used).toBe(1);
    expect((await request(app).get(`${endpoint}/saved`)).status).toBe(401);
  });

  it('ne sauvegarde pas une réponse vide ou invalide et conserve un ancien résultat après un échec', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValueOnce(suggestion);
    await generate(tenant).expect(200);
    mocks.capa.mockResolvedValueOnce({});
    const invalid = await generate(tenant, { regenerate: true });
    expect(invalid.status).toBe(503);
    expect(invalid.body.code).toBe('AI_INVALID_RESULT');
    mocks.capa.mockRejectedValueOnce(new Error('IA indisponible'));
    expect((await generate(tenant, { regenerate: true })).status).toBe(503);
    expect((await read(tenant)).body.result).toEqual(suggestion);
    const { data } = await admin.from('ai_generations').select('*').eq('tenant_id', tenant.tenantId).eq('status', 'completed');
    expect(data).toHaveLength(1);
  });

  it('signale un échec de sauvegarde après génération et ne rappelle pas IA sur retry de la même action', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    const original = supabase.from.bind(supabase);
    vi.spyOn(supabase, 'from').mockImplementation((table) => {
      const builder = original(table);
      if (table === 'ai_generations') {
        const update = builder.update.bind(builder);
        builder.update = (patch) => {
          if (patch.status !== 'completed') return update(patch);
          return {
            eq() { return this; },
            then(resolve) { return Promise.resolve({ error: { message: 'Stockage indisponible (test)' } }).then(resolve); },
          };
        };
      }
      return builder;
    });
    const id = randomUUID();
    const response = await generate(tenant, { id });
    expect(response.status).toBe(500);
    expect(response.body.code).toBe('AI_RESULT_SAVE_FAILED');
    expect((await generate(tenant, { id })).status).toBe(409);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
    expect((await read(tenant)).body.result).toBeNull();
  });

  it('sépare les phases PDCA et ne remplace pas une correction métier au retour', async () => {
    const tenant = await fixture();
    const created = await request(app).post('/api/pdca').set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Améliorer la traçabilité' });
    expect(created.status).toBe(201);
    const path = `/api/pdca/${created.body.id}`;
    mocks.pdca.mockResolvedValue({ content: 'Plan généré.' });
    await request(app).post(`${path}/generate`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(200);
    await request(app).patch(path).set('Authorization', `Bearer ${tenant.admin.token}`).send({ plan_content: 'Correction manuelle.' }).expect(200);
    expect((await request(app).get(path).set('Authorization', `Bearer ${tenant.admin.token}`)).body.plan_content).toBe('Correction manuelle.');
    expect((await request(app).get(`${path}/generate/saved`).set('Authorization', `Bearer ${tenant.admin.token}`)).body.result.content).toBe('Plan généré.');
    await request(app).post(`${path}/advance`).set('Authorization', `Bearer ${tenant.admin.token}`).expect(200);
    expect((await request(app).get(`${path}/generate/saved`).set('Authorization', `Bearer ${tenant.admin.token}`)).body.result).toBeNull();
    expect(mocks.pdca).toHaveBeenCalledTimes(1);
  });

  it('stabilise les clés des objets métier sans invalider les résultats lors d’une modification du contexte', () => {
    const id = randomUUID();
    expect(aiScopeKey(`/api/risks/${id}/generate`, { title: 'Ancien' }))
      .toBe(aiScopeKey(`/api/risks/${id}/generate`, { title: 'Nouveau' }));
    expect(aiScopeKey('/api/ai/risk-treatment-suggestion', { resourceId: id, title: 'Ancien' }))
      .toBe(aiScopeKey('/api/ai/risk-treatment-suggestion', { resourceId: id, title: 'Nouveau' }));
    expect(aiScopeKey('/api/ai/capa-suggestion', { context: 'A', details: 'B' }))
      .toBe(aiScopeKey('/api/ai/capa-suggestion', { details: 'B', context: 'A' }));
    expect(aiScopeKey('/api/procedures/generate-draft', { title: 'Procédure' }))
      .toBe(aiScopeKey('/api/procedures/generate-draft', { title: 'Procédure', process: '', optional: null }));
  });

  it('lit et modifie un résultat avec un contexte volumineux sans le placer dans une URL', async () => {
    const tenant = await fixture();
    const body = { context: 'Contexte qualité détaillé. '.repeat(2000) };
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant, { body }).expect(200);
    const loaded = await request(app).post(`${endpoint}/saved/read`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
    expect(loaded.status).toBe(200);
    expect(loaded.body.result).toEqual(suggestion);
    const edited = { ...suggestion, synthesis: 'Correction sans IA.' };
    await request(app).patch(`${endpoint}/saved`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send({ input: body, result: edited }).expect(200);
    const restored = await request(app).post(`${endpoint}/saved/read`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
    expect(restored.body.result).toEqual(edited);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
    expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant.used).toBe(1);
  });

  it('relie la suggestion CAPA à son objet et refuse un objet étranger ou inaccessible', async () => {
    const tenant = await fixture({ extraUsers: [{ role: 'member' }] });
    const other = await fixture();
    const create = (owner) => request(app).post('/api/pdca')
      .set('Authorization', `Bearer ${owner.admin.token}`).send({ title: 'Projet source CAPA' });
    const own = await create(tenant);
    const foreign = await create(other);
    expect(own.status).toBe(201);
    expect(foreign.status).toBe(201);
    const body = { ...input, source: { type: 'pdca', id: own.body.id } };
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant, { body }).expect(200);
    const changedContext = { ...body, context: 'Contexte corrigé manuellement, sans demande de régénération.' };
    const loaded = await request(app).post(`${endpoint}/saved/read`)
      .set('Authorization', `Bearer ${tenant.admin.token}`).send(changedContext);
    expect(loaded.body.result).toEqual(suggestion);
    expect(mocks.capa).toHaveBeenCalledTimes(1);
    expect((await generate(tenant, { body: { ...body, source: { type: 'pdca', id: foreign.body.id } } })).status).toBe(404);
    expect((await request(app).post(`${endpoint}/saved/read`)
      .set('Authorization', `Bearer ${tenant.users[0].token}`).send(body)).status).toBe(403);
    expect((await generate(tenant, { body: { ...body, source: { type: 'constructor', id: own.body.id } } })).status).toBe(400);
    const drafts = await request(app).get('/api/ai/drafts')
      .set('Authorization', `Bearer ${tenant.admin.token}`).query({ endpoint: '/ai/capa-suggestion' });
    expect(drafts.status).toBe(200);
    expect(drafts.body.draft).toBeNull();
  });

  it('retrouve les entrées d’un brouillon avant création et bloque tout accès direct depuis Supabase authentifié', async () => {
    const tenant = await fixture();
    mocks.capa.mockResolvedValue(suggestion);
    await generate(tenant).expect(200);
    const response = await request(app).get('/api/ai/drafts')
      .set('Authorization', `Bearer ${tenant.admin.token}`).query({ endpoint: '/ai/capa-suggestion' });
    expect(response.status).toBe(200);
    expect(response.body.draft.input).toEqual(input);
    expect(response.body.draft.result).toEqual(suggestion);
    const browserClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${tenant.admin.token}` } },
    });
    const direct = await browserClient.from('ai_generations').select('result');
    expect(direct.error?.code).toBe('42501');
  });

  it('applique les mêmes propositions une seule fois aux risques, dangers, actions et questions, y compris en concurrence', async () => {
    const tenant = await fixture();
    const persist = async (path, module, result, previousId) => {
      const { data, error } = await admin.from('ai_generations').insert({
        tenant_id: tenant.tenantId, user_id: tenant.admin.id, endpoint: path, module,
        scope_key: aiScopeKey(path, {}), request_id: randomUUID(), input: {}, result, status: 'completed',
        origin: previousId ? 'manual' : 'ai', previous_id: previousId,
      }).select('id').single();
      expect(error).toBeNull();
      return data.id;
    };
    const post = (path, body) => request(app).post(path).set('Authorization', `Bearer ${tenant.admin.token}`).send(body);
    const risk = { title: 'Risque appliqué', type: 'risk', likelihood: 2, impact: 3, ai_generated: true };
    const riskResult = { risks: [risk] };
    const riskGeneration = await persist('/api/risks/service-suggestion', 'risks', riskResult);
    const risks = await Promise.all([1, 2].map(() => post('/api/risks', { ...risk, ai_generation_id: riskGeneration })));
    expect(risks.map((response) => response.status)).toEqual([201, 201]);
    expect(risks[0].body.id).toBe(risks[1].body.id);
    const manualRevision = await persist('/api/risks/service-suggestion', 'risks', riskResult, riskGeneration);
    const retried = await post('/api/risks', { ...risk, ai_generation_id: manualRevision });
    expect(retried.body.id).toBe(risks[0].body.id);
    const { data: storedRisks } = await admin.from('risks').select('id').eq('tenant_id', tenant.tenantId);
    expect(storedRisks).toHaveLength(1);
    const { step } = await seedHaccpHazards(tenant.tenantId, [randomUUID()]);
    const hazard = { hazard_type: 'physical', description: 'Corps étranger', likelihood: 2, severity: 4, ai_generated: true };
    const hazardGeneration = await persist(`/api/haccp/steps/${step.id}/hazard-suggestion`, 'haccp', { hazards: [hazard] });
    const hazards = await Promise.all([1, 2].map(() => post(`/api/haccp/steps/${step.id}/hazards`,
      { ...hazard, ai_generation_id: hazardGeneration })));
    expect(hazards.map((response) => response.status)).toEqual([201, 201]);
    expect(hazards[0].body.id).toBe(hazards[1].body.id);
    const review = await post('/api/management-reviews', { title: 'Revue de test', review_date: '2026-08-01' });
    expect(review.status).toBe(201);
    const reviewGeneration = await persist(`/api/management-reviews/${review.body.id}/ai-draft`, 'management_reviews',
      { conclusions: 'Conclusion', improvement_opportunities: '', decisions: ['Former les équipes'] });
    const actions = await Promise.all([1, 2].map(() => post(`/api/management-reviews/${review.body.id}/actions`,
      { description: 'Former les équipes', source: 'ai', ai_generation_id: reviewGeneration })));
    expect(actions.map((response) => response.status)).toEqual([201, 201]);
    expect(actions[0].body.id).toBe(actions[1].body.id);
    const audit = await post('/api/audits', { title: 'Audit de test', audit_type: 'process', planned_date: '2026-08-01' });
    expect(audit.status).toBe(201);
    const auditGeneration = await persist(`/api/audits/${audit.body.id}/checklist/generate`, 'audits', { questions: ['Contrôle effectué ?'] });
    const questions = await Promise.all([1, 2].map(() => post(`/api/audits/${audit.body.id}/checklist/items/bulk`,
      { questions: ['Contrôle effectué ?'], source: 'ai', ai_generation_id: auditGeneration })));
    expect(questions.every((response) => [200, 201].includes(response.status))).toBe(true);
    const { data: storedQuestions } = await admin.from('audit_checklist_items').select('id').eq('audit_id', audit.body.id);
    expect(storedQuestions).toHaveLength(1);
    const other = await fixture();
    expect((await request(app).post('/api/risks').set('Authorization', `Bearer ${other.admin.token}`)
      .send({ ...risk, ai_generation_id: riskGeneration })).status).toBe(404);
    expect((await post('/api/risks', { ...risk, ai_generation_id: hazardGeneration })).status).toBe(404);
    expect((await getAiQuota(tenant.tenantId, tenant.admin.id)).tenant).toMatchObject({ used: 0, pending: 0 });
  });
});
