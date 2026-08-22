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

async function createComplaint(token, extra = {}) {
  const res = await request(app)
    .post('/api/complaints')
    .set('Authorization', `Bearer ${token}`)
    .send({ customer_name: 'Client Test', received_date: '2026-01-15', description: 'Réclamation de test', ...extra });
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

  it("un membre non-assigné voit une CAPA d'une catégorie restreinte dès qu'il a la permission de catégorie (la catégorie donne accès, pas seulement le partage individuel)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const member = tenant.users[0];
    const otherManager = tenant.users[1];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Accès catégorie membre', isRestricted: true });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id, assigned_to: otherManager.id });

    const beforeList = await request(app).get('/api/capas').set('Authorization', `Bearer ${member.token}`);
    expect(beforeList.body.map((c) => c.id)).not.toContain(capa.id);
    const beforeDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(beforeDetail.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true })
      .expect(201);

    const afterList = await request(app).get('/api/capas').set('Authorization', `Bearer ${member.token}`);
    expect(afterList.body.map((c) => c.id)).toContain(capa.id);
    const afterDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(afterDetail.status).toBe(200);
  });

  it("un membre voit une CAPA d'un autre sans catégorie restreinte, même sans permission de catégorie particulière (visible par tout le tenant par défaut)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const member = tenant.users[0];
    const otherManager = tenant.users[1];

    // Une catégorie restreinte existe ailleurs dans le tenant, sans lien avec cette CAPA — ne
    // doit avoir aucun effet sur elle.
    await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Restreinte', isRestricted: true });

    const uncategorizedCapa = await createCapa(tenant.admin.token, { assigned_to: otherManager.id });

    const list = await request(app).get('/api/capas').set('Authorization', `Bearer ${member.token}`);
    expect(list.body.map((c) => c.id)).toContain(uncategorizedCapa.id);
    const detail = await request(app).get(`/api/capas/${uncategorizedCapa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(detail.status).toBe(200);
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

  it('même comportement sur les réclamations : catégorie restreinte bloque un manager sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'complaint', name: 'RH confidentiel', isRestricted: true });
    const complaint = await createComplaint(tenant.admin.token, { category_id: category.id });

    const before = await request(app).get(`/api/complaints/${complaint.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/complaints/${complaint.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);

    const list = await request(app).get('/api/complaints').set('Authorization', `Bearer ${manager.token}`);
    expect(list.body.map((c) => c.id)).toContain(complaint.id);
  });

  it('même comportement sur QQOQCCP : catégorie restreinte bloque un manager sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'qqoqccp', name: 'Confidentiel', isRestricted: true });
    const analysisRes = await request(app)
      .post('/api/qqoqccp')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Analyse test', category_id: category.id });
    expect(analysisRes.status).toBe(201);

    const before = await request(app).get(`/api/qqoqccp/${analysisRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/qqoqccp/${analysisRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it('même comportement sur les fournisseurs (aucune restriction avant, opt-in par catégorie)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'supplier', name: 'Stratégique', isRestricted: true });
    const supplierRes = await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Fournisseur test', category_id: category.id });
    expect(supplierRes.status).toBe(201);

    const before = await request(app).get(`/api/suppliers/${supplierRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);
    const beforeList = await request(app).get('/api/suppliers').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((s) => s.id)).not.toContain(supplierRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/suppliers/${supplierRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it('même comportement sur les formations', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'training', name: 'Habilitation confidentielle', isRestricted: true });
    const trainingRes = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation test', category_id: category.id });
    expect(trainingRes.status).toBe(201);

    const beforeList = await request(app).get('/api/trainings').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((t) => t.id)).not.toContain(trainingRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const afterList = await request(app).get('/api/trainings').set('Authorization', `Bearer ${manager.token}`);
    expect(afterList.body.map((t) => t.id)).toContain(trainingRes.body.id);
  });

  it('même comportement sur les revues de direction', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'management_review', name: 'Comité restreint', isRestricted: true });
    const reviewRes = await request(app)
      .post('/api/management-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Revue test', review_date: '2026-02-01', category_id: category.id });
    expect(reviewRes.status).toBe(201);

    const before = await request(app).get(`/api/management-reviews/${reviewRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/management-reviews/${reviewRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it('même comportement sur les audits (aucune restriction avant, opt-in par catégorie)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'audit', name: 'Audit confidentiel', isRestricted: true });
    const auditRes = await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit test', planned_date: '2026-03-01', category_id: category.id });
    expect(auditRes.status).toBe(201);

    const before = await request(app).get(`/api/audits/${auditRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);
    const beforeList = await request(app).get('/api/audits').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((a) => a.id)).not.toContain(auditRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/audits/${auditRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it('même comportement sur les risques (aucune restriction avant, opt-in par catégorie)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'risk', name: 'Risque confidentiel', isRestricted: true });
    const riskRes = await request(app)
      .post('/api/risks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Risque test', likelihood: 3, impact: 3, category_id: category.id });
    expect(riskRes.status).toBe(201);

    const before = await request(app).get(`/api/risks/${riskRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);
    const beforeList = await request(app).get('/api/risks').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((r) => r.id)).not.toContain(riskRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/risks/${riskRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it('même comportement sur les tâches (aucune restriction avant, opt-in par catégorie)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'task', name: 'Tâche confidentielle', isRestricted: true });
    const taskRes = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche test', due_date: '2026-03-01', category_id: category.id });
    expect(taskRes.status).toBe(201);

    const beforeList = await request(app).get('/api/tasks').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((t) => t.id)).not.toContain(taskRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const afterList = await request(app).get('/api/tasks').set('Authorization', `Bearer ${manager.token}`);
    expect(afterList.body.map((t) => t.id)).toContain(taskRes.body.id);
  });

  it('même comportement sur les KPI (aucune restriction avant, opt-in par catégorie)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'kpi', name: 'KPI confidentiel', isRestricted: true });
    const kpiRes = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI test', category_id: category.id });
    expect(kpiRes.status).toBe(201);

    const before = await request(app).get(`/api/kpis/${kpiRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(404);
    const beforeList = await request(app).get('/api/kpis').set('Authorization', `Bearer ${manager.token}`);
    expect(beforeList.body.map((k) => k.id)).not.toContain(kpiRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get(`/api/kpis/${kpiRes.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(after.status).toBe(200);
  });

  it("une CAPA d'une catégorie restreinte, assignée à un member, n'apparaît pas dans son /api/planning tant que la permission n'est pas accordée", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Planning confidentiel', isRestricted: true });
    const capaRes = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA planning', due_date: '2026-03-01', category_id: category.id, assigned_to: member.id });
    expect(capaRes.status).toBe(201);

    const before = await request(app).get('/api/planning').set('Authorization', `Bearer ${member.token}`);
    expect(before.body.items.map((i) => i.id)).not.toContain(capaRes.body.id);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true })
      .expect(201);

    const after = await request(app).get('/api/planning').set('Authorization', `Bearer ${member.token}`);
    expect(after.body.items.map((i) => i.id)).toContain(capaRes.body.id);
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
      .query({ resource_type: 'ghost' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(badType.status).toBe(400);
  });
});

describe('Catégorie personnelle "Uniquement moi" (POST /api/module-categories/personal)', () => {
  it("un member peut créer une CAPA visible uniquement par lui, sans passer par un admin", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const personal = await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ resource_type: 'capa' });
    expect(personal.status).toBe(200);
    expect(personal.body.id).toBeTruthy();

    const capa = await createCapa(memberA.token, { category_id: personal.body.id });

    const ownDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${memberA.token}`);
    expect(ownDetail.status).toBe(200);
    const ownList = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    expect(ownList.body.map((c) => c.id)).toContain(capa.id);

    const otherDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${memberB.token}`);
    expect(otherDetail.status).toBe(404);
    const otherList = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberB.token}`);
    expect(otherList.body.map((c) => c.id)).not.toContain(capa.id);

    const adminDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDetail.status).toBe(200);
  });

  it('renvoie toujours le même id pour le même utilisateur et le même module (une seule catégorie personnelle)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const first = await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ resource_type: 'complaint' });
    const second = await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ resource_type: 'complaint' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('deux utilisateurs différents obtiennent chacun leur propre catégorie personnelle, jamais partagée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const personalA = await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ resource_type: 'qqoqccp' });
    const personalB = await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${memberB.token}`)
      .send({ resource_type: 'qqoqccp' });

    expect(personalA.body.id).not.toBe(personalB.body.id);
  });

  it("une catégorie personnelle n'apparaît jamais dans GET /api/module-categories (ni pour l'admin, ni pour son propriétaire)", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await request(app)
      .post('/api/module-categories/personal')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ resource_type: 'risk' });
    await createCategory(tenant.admin.token, { resourceType: 'risk', name: 'Catégorie normale' });

    const adminList = await request(app)
      .get('/api/module-categories')
      .query({ resource_type: 'risk' })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((c) => c.name)).toEqual(['Catégorie normale']);

    const memberList = await request(app)
      .get('/api/module-categories')
      .query({ resource_type: 'risk' })
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((c) => c.name)).toEqual(['Catégorie normale']);
  });

  it('PATCH category_id="" (remise à "Tout le monde") vide la catégorie plutôt que de faire échouer la requête', async () => {
    tenant = await createTenant();

    const category = await createCategory(tenant.admin.token, { resourceType: 'capa', name: 'Temporaire' });
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });
    expect(capa.category_id).toBe(category.id);

    const patch = await request(app)
      .patch(`/api/capas/${capa.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: '' });
    expect(patch.status).toBe(200);
    expect(patch.body.category_id).toBeNull();
  });

  it('même comportement sur QQOQCCP : PATCH category_id="" vide la catégorie sans échouer', async () => {
    tenant = await createTenant();

    const category = await createCategory(tenant.admin.token, { resourceType: 'qqoqccp', name: 'Temporaire' });
    const analysisRes = await request(app)
      .post('/api/qqoqccp')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Analyse test', category_id: category.id });
    expect(analysisRes.status).toBe(201);

    const patch = await request(app)
      .patch(`/api/qqoqccp/${analysisRes.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: '' });
    expect(patch.status).toBe(200);
    expect(patch.body.category_id).toBeNull();
  });
});
