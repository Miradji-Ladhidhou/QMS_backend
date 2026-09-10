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

async function makeSurvey(token, overrides = {}) {
  const res = await request(app)
    .post('/api/customer-satisfaction')
    .set('Authorization', `Bearer ${token}`)
    .send({ customer_name: 'Client Test SARL', survey_date: '2026-01-15', score: 4, ...overrides });
  return res;
}

describe('POST /api/customer-satisfaction — création ouverte à tous les rôles', () => {
  it('201 pour un member, un manager ou un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeSurvey(member.token);
    expect(memberAttempt.status).toBe(201);
    expect(memberAttempt.body.method).toBe('questionnaire');

    const managerAttempt = await makeSurvey(manager.token);
    expect(managerAttempt.status).toBe(201);

    const adminAttempt = await makeSurvey(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
  });

  it('rejette un client, une date ou une note manquants', async () => {
    tenant = await createTenant();

    const noCustomer = await request(app)
      .post('/api/customer-satisfaction')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ survey_date: '2026-01-15', score: 4 });
    expect(noCustomer.status).toBe(400);

    const noDate = await request(app)
      .post('/api/customer-satisfaction')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Client Test', score: 4 });
    expect(noDate.status).toBe(400);

    const noScore = await request(app)
      .post('/api/customer-satisfaction')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Client Test', survey_date: '2026-01-15' });
    expect(noScore.status).toBe(400);
  });

  it('rejette une note hors de l’échelle 1-5', async () => {
    tenant = await createTenant();

    const tooLow = await makeSurvey(tenant.admin.token, { score: 0 });
    expect(tooLow.status).toBe(400);

    const tooHigh = await makeSurvey(tenant.admin.token, { score: 6 });
    expect(tooHigh.status).toBe(400);
  });

  it('accepte une méthode explicite', async () => {
    tenant = await createTenant();
    const res = await makeSurvey(tenant.admin.token, { method: 'phone' });
    expect(res.status).toBe(201);
    expect(res.body.method).toBe('phone');
  });
});

describe('PATCH /api/customer-satisfaction/:id — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const survey = await makeSurvey(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ score: 3 });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ score: 3, comments: 'Corrigé après relecture.' });
    expect(managerAttempt.status).toBe(200);
    expect(managerAttempt.body.score).toBe(3);
    expect(managerAttempt.body.comments).toBe('Corrigé après relecture.');
  });

  it('rejette une note hors échelle sur la modification', async () => {
    tenant = await createTenant();
    const survey = await makeSurvey(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ score: 7 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/customer-satisfaction/bulk-category — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const survey = await makeSurvey(tenant.admin.token);

    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'customer_satisfaction', name: 'Grands comptes', is_restricted: true });
    expect(categoryRes.status).toBe(201);

    const memberAttempt = await request(app)
      .patch('/api/customer-satisfaction/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [survey.body.id], category_id: categoryRes.body.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/customer-satisfaction/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [survey.body.id], category_id: categoryRes.body.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });
});

describe('DELETE /api/customer-satisfaction/:id et /bulk — réservé admin/manager', () => {
  it('403 pour un member, 204/200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const survey = await makeSurvey(member.token);
    const survey2 = await makeSurvey(member.token);

    const memberDelete = await request(app)
      .delete(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);

    const memberBulk = await request(app)
      .delete('/api/customer-satisfaction/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [survey2.body.id] });
    expect(memberBulk.status).toBe(403);

    const adminBulk = await request(app)
      .delete('/api/customer-satisfaction/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [survey2.body.id] });
    expect(adminBulk.status).toBe(200);
    expect(adminBulk.body.deleted).toBe(1);
  });
});

describe('Catégorie restreinte — visibilité', () => {
  it("une enquête d'une catégorie restreinte reste visible pour l'admin mais invisible pour un member sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'customer_satisfaction', name: 'Confidentiel', is_restricted: true });
    expect(categoryRes.status).toBe(201);
    const survey = await makeSurvey(tenant.admin.token, { category_id: categoryRes.body.id });

    const adminList = await request(app).get('/api/customer-satisfaction').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((s) => s.id)).toContain(survey.body.id);

    const memberList = await request(app).get('/api/customer-satisfaction').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((s) => s.id)).not.toContain(survey.body.id);
    const memberDetail = await request(app)
      .get(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);
  });
});

describe('Catégories — une enquête de satisfaction respecte les mêmes règles que les autres modules', () => {
  it('le garde-fou de suppression de catégorie couvre customer_satisfaction sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'customer_satisfaction', name: 'Catégorie restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const survey = await makeSurvey(tenant.admin.token, { category_id: category.body.id });
    expect(survey.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 enquête de satisfaction');

    await request(app).delete(`/api/customer-satisfaction/${survey.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('POST /api/customer-satisfaction/:id/create-capa — lien bidirectionnel, réservé admin/manager', () => {
  it('crée une CAPA liée avec customer_satisfaction_survey_id et met à jour linked_capa_id', async () => {
    tenant = await createTenant();
    const survey = await makeSurvey(tenant.admin.token, { score: 1 });

    const capa = await request(app)
      .post(`/api/customer-satisfaction/${survey.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Comprendre les causes de la faible satisfaction' });
    expect(capa.status).toBe(201);
    expect(capa.body.customer_satisfaction_survey_id).toBe(survey.body.id);
    expect(capa.body.origin).toContain('Enquête de satisfaction');

    const detail = await request(app)
      .get(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);
  });

  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const survey = await makeSurvey(tenant.admin.token);

    const res = await request(app)
      .post(`/api/customer-satisfaction/${survey.body.id}/create-capa`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Comprendre les causes de la faible satisfaction' });
    expect(res.status).toBe(403);
  });
});

describe('Isolation multi-tenant', () => {
  it('un tenant ne voit pas les enquêtes de satisfaction d’un autre tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();
    const survey = await makeSurvey(other.admin.token);

    const detail = await request(app)
      .get(`/api/customer-satisfaction/${survey.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(404);

    await other.cleanup();
  });
});
