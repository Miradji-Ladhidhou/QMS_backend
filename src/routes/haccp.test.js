import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function makePlan(token, overrides = {}) {
  const res = await request(app)
    .post('/api/haccp/plans')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Fabrication de yaourt nature', ...overrides });
  return res;
}

async function makeStep(token, planId, overrides = {}) {
  const res = await request(app)
    .post(`/api/haccp/plans/${planId}/steps`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Pasteurisation', ...overrides });
  return res;
}

async function makeHazard(token, stepId, overrides = {}) {
  const res = await request(app)
    .post(`/api/haccp/steps/${stepId}/hazards`)
    .set('Authorization', `Bearer ${token}`)
    .send({ hazard_type: 'biological', description: 'Survie de Listeria', likelihood: 2, severity: 5, ...overrides });
  return res;
}

async function makeCcp(token, hazardId, overrides = {}) {
  const res = await request(app)
    .post(`/api/haccp/hazards/${hazardId}/ccps`)
    .set('Authorization', `Bearer ${token}`)
    .send({ critical_limits: '≥ 85°C pendant 15 secondes', monitoring_procedure: 'Sonde de température en continu', ...overrides });
  return res;
}

describe('POST /api/haccp/plans — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makePlan(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makePlan(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.status).toBe('draft');
  });
});

describe('GET /api/haccp/plans — visible à tous les rôles', () => {
  it('un member voit un plan créé par un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const plan = await makePlan(tenant.admin.token);

    const res = await request(app).get('/api/haccp/plans').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((p) => p.id === plan.body.id)).toBe(true);
  });
});

describe('Chaîne complète plan -> étape -> danger -> CCP -> surveillance', () => {
  it("assemble correctement l'arborescence dans GET /plans/:id", async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    expect(step.status).toBe(201);
    expect(step.body.step_number).toBe(1);

    const hazard = await makeHazard(tenant.admin.token, step.body.id);
    expect(hazard.status).toBe(201);
    expect(hazard.body.risk_score).toBe(10);
    expect(hazard.body.is_significant).toBe(false);

    const detail = await request(app).get(`/api/haccp/plans/${plan.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.steps).toHaveLength(1);
    expect(detail.body.steps[0].hazards).toHaveLength(1);
    expect(detail.body.steps[0].hazards[0].id).toBe(hazard.body.id);
    expect(detail.body.steps[0].hazards[0].ccp).toBeNull();
  });

  it("refuse la création d'un CCP sur un danger non marqué significatif", async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);

    const ccpAttempt = await makeCcp(tenant.admin.token, hazard.body.id);
    expect(ccpAttempt.status).toBe(400);
  });

  it("accepte la création d'un CCP une fois le danger marqué significatif, et l'assemble dans GET /plans/:id", async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);

    await request(app)
      .patch(`/api/haccp/hazards/${hazard.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_significant: true, justification: 'Pathogène critique en cas de sous-pasteurisation.' })
      .expect(200);

    const ccp = await makeCcp(tenant.admin.token, hazard.body.id);
    expect(ccp.status).toBe(201);

    const detail = await request(app).get(`/api/haccp/plans/${plan.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.steps[0].hazards[0].ccp.id).toBe(ccp.body.id);
  });

  it('un member peut saisir un relevé de surveillance, mais pas le supprimer', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);
    await request(app)
      .patch(`/api/haccp/hazards/${hazard.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_significant: true })
      .expect(200);
    const ccp = await makeCcp(tenant.admin.token, hazard.body.id);

    const log = await request(app)
      .post(`/api/haccp/ccps/${ccp.body.id}/monitoring-logs`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ recorded_value: '92°C', within_limits: true });
    expect(log.status).toBe(201);
    expect(log.body.recorded_by_user.id).toBe(member.id);

    const deleteAttempt = await request(app)
      .delete(`/api/haccp/monitoring-logs/${log.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(deleteAttempt.status).toBe(403);

    const list = await request(app)
      .get(`/api/haccp/ccps/${ccp.body.id}/monitoring-logs`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  it("crée une CAPA à partir d'une dérive de surveillance, liée dans les deux sens", async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);
    await request(app)
      .patch(`/api/haccp/hazards/${hazard.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_significant: true })
      .expect(200);
    const ccp = await makeCcp(tenant.admin.token, hazard.body.id);

    const log = await request(app)
      .post(`/api/haccp/ccps/${ccp.body.id}/monitoring-logs`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ recorded_value: '78°C', within_limits: false });

    const capa = await request(app)
      .post(`/api/haccp/monitoring-logs/${log.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Investiguer la sous-pasteurisation du 78°C' });
    expect(capa.status).toBe(201);
    expect(capa.body.haccp_monitoring_log_id).toBe(log.body.id);
    expect(capa.body.origin).toContain('Dérive de surveillance HACCP');

    const { data: logAfter } = await admin.from('haccp_monitoring_logs').select('linked_capa_id').eq('id', log.body.id).single();
    expect(logAfter.linked_capa_id).toBe(capa.body.id);
  });
});

describe('DELETE /api/haccp/plans/:id — cascade sur étapes/dangers/CCP/surveillance', () => {
  it('supprime tout le sous-arbre, la CAPA liée survit avec haccp_monitoring_log_id à null', async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);
    await request(app)
      .patch(`/api/haccp/hazards/${hazard.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_significant: true })
      .expect(200);
    const ccp = await makeCcp(tenant.admin.token, hazard.body.id);
    const log = await request(app)
      .post(`/api/haccp/ccps/${ccp.body.id}/monitoring-logs`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ recorded_value: '78°C', within_limits: false });
    const capa = await request(app)
      .post(`/api/haccp/monitoring-logs/${log.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Investiguer' });

    const del = await request(app).delete(`/api/haccp/plans/${plan.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const { data: stepAfter } = await admin.from('haccp_process_steps').select('id').eq('id', step.body.id).maybeSingle();
    expect(stepAfter).toBeNull();
    const { data: hazardAfter } = await admin.from('haccp_hazards').select('id').eq('id', hazard.body.id).maybeSingle();
    expect(hazardAfter).toBeNull();
    const { data: ccpAfter } = await admin.from('haccp_ccps').select('id').eq('id', ccp.body.id).maybeSingle();
    expect(ccpAfter).toBeNull();
    const { data: logAfter } = await admin.from('haccp_monitoring_logs').select('id').eq('id', log.body.id).maybeSingle();
    expect(logAfter).toBeNull();

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.haccp_monitoring_log_id).toBeNull();
  });
});

describe('DELETE /api/haccp/plans/bulk — suppression en masse', () => {
  it('403 pour un member, supprime plusieurs plans pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const planA = await makePlan(tenant.admin.token, { title: 'Plan A' });
    const planB = await makePlan(tenant.admin.token, { title: 'Plan B' });

    const memberAttempt = await request(app)
      .delete('/api/haccp/plans/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [planA.body.id, planB.body.id] });
    expect(memberAttempt.status).toBe(403);

    const res = await request(app)
      .delete('/api/haccp/plans/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [planA.body.id, planB.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
  });
});

// POST /api/haccp/steps/:stepId/hazard-suggestion appelle Groq en direct : comme pour
// POST /api/ai/capa-suggestion, aucun test automatisé ne couvre le chemin qui appelle
// réellement l'IA (vérifié manuellement). On couvre ici uniquement permission et 404.
describe('POST /api/haccp/steps/:stepId/hazard-suggestion — permissions et validation', () => {
  it('403 pour un member, 404 pour une étape inexistante côté admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);

    const memberAttempt = await request(app)
      .post(`/api/haccp/steps/${step.body.id}/hazard-suggestion`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberAttempt.status).toBe(403);

    const notFound = await request(app)
      .post('/api/haccp/steps/00000000-0000-0000-0000-000000000000/hazard-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(notFound.status).toBe(404);
  });
});

describe('Export PDF — GET /api/haccp/plans/:id/pdf et POST /api/haccp/plans/pdf', () => {
  it("GET /plans/:id/pdf renvoie un PDF pour un plan avec dangers/CCP/surveillance, 404 pour un plan inexistant", async () => {
    tenant = await createTenant();
    const plan = await makePlan(tenant.admin.token);
    const step = await makeStep(tenant.admin.token, plan.body.id);
    const hazard = await makeHazard(tenant.admin.token, step.body.id);
    await request(app)
      .patch(`/api/haccp/hazards/${hazard.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_significant: true })
      .expect(200);
    const ccp = await makeCcp(tenant.admin.token, hazard.body.id);
    await request(app)
      .post(`/api/haccp/ccps/${ccp.body.id}/monitoring-logs`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ recorded_value: '92°C', within_limits: true });

    const res = await request(app).get(`/api/haccp/plans/${plan.body.id}/pdf`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.length).toBeGreaterThan(1000);

    const notFound = await request(app)
      .get('/api/haccp/plans/00000000-0000-0000-0000-000000000000/pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(notFound.status).toBe(404);
  });

  it('POST /plans/pdf sans ids exporte tous les plans visibles ; avec ids, seulement ceux-là', async () => {
    tenant = await createTenant();
    const planA = await makePlan(tenant.admin.token, { title: 'Plan A' });
    await makePlan(tenant.admin.token, { title: 'Plan B' });

    const all = await request(app).post('/api/haccp/plans/pdf').set('Authorization', `Bearer ${tenant.admin.token}`).send({});
    expect(all.status).toBe(200);
    expect(all.headers['content-type']).toBe('application/pdf');

    const scoped = await request(app)
      .post('/api/haccp/plans/pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [planA.body.id] });
    expect(scoped.status).toBe(200);
    // Le contenu texte n'est pas trivialement inspectable dans un buffer PDF compressé ; on se
    // contente ici de vérifier que la restriction ne fait pas échouer la requête et produit un
    // document plus léger qu'avec les deux plans (signal indirect que moins de contenu a été
    // généré).
    expect(scoped.body.length).toBeLessThan(all.body.length);

    const empty = await request(app)
      .post('/api/haccp/plans/pdf')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: ['00000000-0000-0000-0000-000000000000'] });
    expect(empty.status).toBe(404);
  });
});
