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

async function createCategory(token, { resourceType, name, isRestricted = false }) {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: resourceType, name, is_restricted: isRestricted });
  expect(res.status).toBe(201);
  return res.body;
}

async function createCapa(token, extra = {}) {
  const res = await request(app)
    .post('/api/capas')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'CAPA de test', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Catégories génériques (CAPA)', () => {
  it('un manager voit tout par défaut, puis se fait bloquer par une catégorie restreinte, puis autorisé une fois la permission accordée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'RH confidentiel', isRestricted: true });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    // Avant restriction de catégorie, un manager voyait TOUT — vérifie que la restriction
    // s'applique bien désormais à lui aussi (pas seulement aux membres).
    const beforeList = await request(app).get('/api/capas').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((c) => c.id)).not.toContain(capa.id);

    const beforeDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(beforeDetail.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const afterList = await request(app).get('/api/capas').set('Authorization', `Bearer ${manager.token}`);
    expect(afterList.body.map((c) => c.id)).toContain(capa.id);

    const afterDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(afterDetail.status).toBe(200);
  });

  it('un partage individuel (record_shares) lève la restriction de catégorie', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Confidentiel', isRestricted: true });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'user', subject_id: manager.id })
      .expect(201);

    const list = await request(app).get('/api/capas').set('Authorization', `Bearer ${manager.token}`);
    expect(list.body.map((c) => c.id)).toContain(capa.id);
    const detail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(detail.status).toBe(200);
  });

  it("un membre assigné à une CAPA d'une catégorie restreinte reste bloqué sans permission de catégorie (la restriction prime sur l'assignation)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Confidentiel membre', isRestricted: true });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id, assigned_to: member.id });

    const detail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(detail.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true })
      .expect(201);

    const detailAfter = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(detailAfter.status).toBe(200);
  });

  it('une règle directe can_view=false est prioritaire sur un groupe autorisé (même fix que documents)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Exclusion groupe', isRestricted: true });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    const groupRes = await request(app)
      .post('/api/groups')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Managers qualité' });
    await request(app)
      .post(`/api/groups/${groupRes.body.id}/members`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: manager.id })
      .expect(201);
    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'group', subject_id: groupRes.body.id, can_view: true })
      .expect(201);

    const viaGroup = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(viaGroup.status).toBe(200);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: false })
      .expect(201);

    const excluded = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(excluded.status).toBe(404);
  });

  it('GET /api/module-categories filtre par resource_type et rejette un type inconnu', async () => {
    tenant = await createTenant();
    await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Catégorie CAPA' });
    await createCategory(tenant.admin.token, { resourceType: 'complaint', name: 'Catégorie réclamation' });

    const capaList = await request(app)
      .get('/api/module-categories')
      .query({ resource_type: 'capa' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaList.status).toBe(200);
    expect(capaList.body.map((c) => c.name)).toEqual(['Catégorie CAPA']);

    const badType = await request(app)
      .get('/api/module-categories')
      .query({ resource_type: 'audit' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(badType.status).toBe(400);
  });
});
