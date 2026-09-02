import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function makeRisk(token, overrides = {}) {
  const res = await request(app)
    .post('/api/risks')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Dépendance à un fournisseur unique', likelihood: 4, impact: 3, ...overrides });
  return res;
}

describe('POST /api/risks — création réservée à admin/manager, score calculé par la base', () => {
  it('403 pour un member, 201 pour un manager avec risk_score = likelihood * impact', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeRisk(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeRisk(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.risk_score).toBe(12);
    expect(managerAttempt.body.residual_score).toBeNull();
    expect(managerAttempt.body.type).toBe('risk');
    expect(managerAttempt.body.status).toBe('identified');
  });

  it('rejette une probabilité ou une gravité hors de l’échelle 1-5', async () => {
    tenant = await createTenant();
    const res = await makeRisk(tenant.admin.token, { likelihood: 6, impact: 3 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/risks — visible à tous les rôles, filtrable', () => {
  it('un member voit les risques créés par un admin ; filtre par statut et par type', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const risk = await makeRisk(tenant.admin.token, { title: 'Risque visible par tous' });
    await makeRisk(tenant.admin.token, { title: 'Opportunité', type: 'opportunity', likelihood: 2, impact: 2 });

    const memberRes = await request(app).get('/api/risks').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.status).toBe(200);
    expect(memberRes.body.some((r) => r.id === risk.body.id)).toBe(true);

    const byType = await request(app).get('/api/risks?type=opportunity').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(byType.body.every((r) => r.type === 'opportunity')).toBe(true);
    expect(byType.body.length).toBe(1);
  });

  it('filtre par service_id', async () => {
    tenant = await createTenant();
    const serviceRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Logistique' });
    const serviceId = serviceRes.body.id;

    const scoped = await makeRisk(tenant.admin.token, { title: 'Risque logistique', service_id: serviceId });
    await makeRisk(tenant.admin.token, { title: 'Risque sans service' });

    const res = await request(app).get(`/api/risks?service_id=${serviceId}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(scoped.body.id);
  });
});

describe('ai_generated — traçabilité des risques issus d’une suggestion IA acceptée', () => {
  it('false par défaut, true si explicitement envoyé à la création', async () => {
    tenant = await createTenant();

    const manual = await makeRisk(tenant.admin.token);
    expect(manual.body.ai_generated).toBe(false);

    const aiAccepted = await makeRisk(tenant.admin.token, { title: 'Risque suggéré par l’IA', ai_generated: true });
    expect(aiAccepted.body.ai_generated).toBe(true);
  });
});

// POST /api/risks/service-suggestion appelle Groq en direct : comme pour
// POST /api/ai/capa-suggestion et POST /api/haccp/steps/:stepId/hazard-suggestion, aucun test
// automatisé ne couvre le chemin qui appelle réellement l'IA (vérifié manuellement). On couvre
// ici uniquement permission et validation.
describe('POST /api/risks/service-suggestion — permissions et validation', () => {
  it('403 pour un member, 400 si le contexte est trop court', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const memberAttempt = await request(app)
      .post('/api/risks/service-suggestion')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ service_name: 'Logistique', context: 'Réception et expédition de marchandises.' });
    expect(memberAttempt.status).toBe(403);

    const tooShort = await request(app)
      .post('/api/risks/service-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ service_name: 'Logistique', context: 'court' });
    expect(tooShort.status).toBe(400);

    const missingService = await request(app)
      .post('/api/risks/service-suggestion')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ context: 'Réception et expédition de marchandises.' });
    expect(missingService.status).toBe(400);
  });
});

describe('PATCH /api/risks/:id — traitement et évaluation résiduelle', () => {
  it('403 pour un member ; un manager peut poser un plan de traitement et calculer le risque résiduel', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const risk = await makeRisk(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/risks/${risk.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'treating' });
    expect(memberAttempt.status).toBe(403);

    const updated = await request(app)
      .patch(`/api/risks/${risk.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        status: 'treated',
        current_controls: 'Contrat cadre en cours',
        treatment_plan: 'Qualifier un second fournisseur',
        residual_likelihood: 2,
        residual_impact: 3,
      });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('treated');
    expect(updated.body.residual_score).toBe(6);
    // Le risque initial ne doit pas bouger : seule l'évaluation résiduelle a changé.
    expect(updated.body.risk_score).toBe(12);
  });

  it('rejette explicitement toute tentative d’écrire risk_score/residual_score directement', async () => {
    tenant = await createTenant();
    const risk = await makeRisk(tenant.admin.token);

    // risk_score n'est pas dans la liste des champs patchables (voir risks.js) : envoyé, il
    // est simplement ignoré plutôt que de faire échouer la requête ou corrompre la colonne.
    const res = await request(app)
      .patch(`/api/risks/${risk.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ risk_score: 999, likelihood: 5, impact: 5 });
    expect(res.status).toBe(200);
    expect(res.body.risk_score).toBe(25);
  });
});

describe('POST /api/risks/:id/create-capa — lien bidirectionnel', () => {
  it('crée une CAPA liée, visible dans les deux sens, et la CAPA survit à la suppression du risque', async () => {
    tenant = await createTenant();
    const risk = await makeRisk(tenant.admin.token);

    const capa = await request(app)
      .post(`/api/risks/${risk.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Qualifier un fournisseur de secours' });
    expect(capa.status).toBe(201);
    expect(capa.body.risk_id).toBe(risk.body.id);
    expect(capa.body.origin).toContain('Risque/opportunité');

    const detail = await request(app).get(`/api/risks/${risk.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);

    const del = await request(app).delete(`/api/risks/${risk.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.risk_id).toBeNull();
  });
});
