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

async function createCapa(token, extra = {}) {
  const res = await request(app).post('/api/capas').set('Authorization', `Bearer ${token}`).send({ title: 'CAPA de test', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function createQqoqccp(token, extra = {}) {
  const res = await request(app).post('/api/qqoqccp').set('Authorization', `Bearer ${token}`).send({ title: 'Analyse QQOQCCP de test', ...extra });
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

async function createProcedure(token, number, extra = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

// CAPA/réclamations/QQOQCCP sont visibles par tout le tenant par défaut (comme les
// Documents) — pour démontrer qu'un partage individuel donne réellement accès, ces tests le
// font sur une catégorie explicitement restreinte (Paramètres > Catégories), sinon un member
// verrait déjà l'élément sans aucun partage.
async function createRestrictedCategory(token, resourceType, name = 'Restreinte') {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: resourceType, name, is_restricted: true });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Partage d’un élément précis (record_shares)', () => {
  it("un membre ne voit une CAPA d'une catégorie restreinte qu'après un partage direct avec lui", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;
    const category = await createRestrictedCategory(tenant.admin.token, 'capa');
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    const beforeList = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    expect(beforeList.body.map((c) => c.id)).not.toContain(capa.id);

    const beforeDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${memberA.token}`);
    expect(beforeDetail.status).toBe(404);

    const shareRes = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'user', subject_id: memberA.id });
    expect(shareRes.status).toBe(201);

    const afterList = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    expect(afterList.body.map((c) => c.id)).toContain(capa.id);

    const afterDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${memberA.token}`);
    expect(afterDetail.status).toBe(200);

    // memberB n'a jamais été partagé — ne doit jamais voir cette CAPA.
    const otherList = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberB.token}`);
    expect(otherList.body.map((c) => c.id)).not.toContain(capa.id);
    const otherDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${memberB.token}`);
    expect(otherDetail.status).toBe(404);
  });

  it("un partage par rôle 'member' donne accès à TOUS les membres", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;
    const category = await createRestrictedCategory(tenant.admin.token, 'capa');
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'role', subject_id: 'member' })
      .expect(201);

    const listA = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberA.token}`);
    const listB = await request(app).get('/api/capas').set('Authorization', `Bearer ${memberB.token}`);
    expect(listA.body.map((c) => c.id)).toContain(capa.id);
    expect(listB.body.map((c) => c.id)).toContain(capa.id);
  });

  it('retirer un partage retire à nouveau l’accès', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token, 'capa');
    const capa = await createCapa(tenant.admin.token, { category_id: category.id });

    const shareRes = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'user', subject_id: member.id });

    const midDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(midDetail.status).toBe(200);

    const deleteRes = await request(app)
      .delete(`/api/shares/${shareRes.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(deleteRes.status).toBe(204);

    const afterDetail = await request(app).get(`/api/capas/${capa.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(afterDetail.status).toBe(404);
  });

  it('un membre ne peut pas créer ou lister de partages (réservé admin/manager)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const capa = await createCapa(tenant.admin.token);

    const createRes = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'user', subject_id: member.id });
    expect(createRes.status).toBe(403);

    const listRes = await request(app)
      .get(`/api/shares?resource_type=capa&resource_id=${capa.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(listRes.status).toBe(403);
  });

  it('rejette un partage vers le rôle admin, un rôle inconnu, ou un élément inexistant', async () => {
    tenant = await createTenant();
    const capa = await createCapa(tenant.admin.token);

    const adminRole = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'role', subject_id: 'admin' });
    expect(adminRole.status).toBe(400);

    const unknownRole = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: capa.id, subject_type: 'role', subject_id: 'ghost' });
    expect(unknownRole.status).toBe(400);

    const missingResource = await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'capa', resource_id: '00000000-0000-0000-0000-000000000000', subject_type: 'role', subject_id: 'member' });
    expect(missingResource.status).toBe(404);
  });

  it('un document d’une catégorie restreinte devient visible pour un membre partagé directement', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const { data: category } = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Confidentiel', is_restricted: true })
      .select()
      .single();

    const docRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .field('number', 'DOC-SHARE-001')
      .field('title', 'Document restreint')
      .field('category_id', category.id);
    expect(docRes.status).toBe(201);

    const beforeRes = await request(app).get(`/api/documents/${docRes.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(beforeRes.status).toBe(404);

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'document', resource_id: docRes.body.id, subject_type: 'user', subject_id: member.id })
      .expect(201);

    const afterRes = await request(app).get(`/api/documents/${docRes.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(afterRes.status).toBe(200);

    const listRes = await request(app).get('/api/documents').set('Authorization', `Bearer ${member.token}`);
    expect(listRes.body.map((d) => d.id)).toContain(docRes.body.id);
  });

  it("un membre ne voit une réclamation d'une catégorie restreinte qu'après un partage direct avec lui", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token, 'complaint');
    const complaint = await createComplaint(tenant.admin.token, { category_id: category.id });

    const beforeDetail = await request(app)
      .get(`/api/complaints/${complaint.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(beforeDetail.status).toBe(404);

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'complaint', resource_id: complaint.id, subject_type: 'user', subject_id: member.id })
      .expect(201);

    const afterList = await request(app).get('/api/complaints').set('Authorization', `Bearer ${member.token}`);
    expect(afterList.body.map((c) => c.id)).toContain(complaint.id);

    const afterDetail = await request(app)
      .get(`/api/complaints/${complaint.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(afterDetail.status).toBe(200);
  });

  it("un membre ne voit une analyse QQOQCCP d'une catégorie restreinte qu'après un partage direct", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token, 'qqoqccp');
    const analysis = await createQqoqccp(tenant.admin.token, { category_id: category.id });

    const beforeList = await request(app).get('/api/qqoqccp').set('Authorization', `Bearer ${member.token}`);
    expect(beforeList.body.map((a) => a.id)).not.toContain(analysis.id);
    const beforeDetail = await request(app).get(`/api/qqoqccp/${analysis.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(beforeDetail.status).toBe(404);

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'qqoqccp', resource_id: analysis.id, subject_type: 'user', subject_id: member.id })
      .expect(201);

    const afterList = await request(app).get('/api/qqoqccp').set('Authorization', `Bearer ${member.token}`);
    expect(afterList.body.map((a) => a.id)).toContain(analysis.id);
    const afterDetail = await request(app).get(`/api/qqoqccp/${analysis.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(afterDetail.status).toBe(200);
  });

  it("un membre ne voit une procédure d'un dossier restreint qu'après un partage direct", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token, 'procedure');
    const procedure = await createProcedure(tenant.admin.token, 'PROC-SHARE-1', { category_id: category.id });

    const beforeList = await request(app).get('/api/procedures').set('Authorization', `Bearer ${member.token}`);
    expect(beforeList.body.map((p) => p.id)).not.toContain(procedure.id);
    const beforeDetail = await request(app).get(`/api/procedures/${procedure.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(beforeDetail.status).toBe(404);

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'procedure', resource_id: procedure.id, subject_type: 'user', subject_id: member.id })
      .expect(201);

    const afterList = await request(app).get('/api/procedures').set('Authorization', `Bearer ${member.token}`);
    expect(afterList.body.map((p) => p.id)).toContain(procedure.id);
    const afterDetail = await request(app).get(`/api/procedures/${procedure.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(afterDetail.status).toBe(200);
  });
});
