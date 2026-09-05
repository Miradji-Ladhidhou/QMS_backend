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

async function makePdca(token, overrides = {}) {
  const res = await request(app)
    .post('/api/pdca')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Réduire les rebuts en ligne 3', ...overrides });
  return res;
}

async function createRestrictedCategory(token, name = 'Restreinte') {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: 'pdca', name, is_restricted: true });
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/pdca — ouvert à tous les rôles', () => {
  it('un member crée un projet avec juste un titre ; owner/target_date/plan_content restent optionnels', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const res = await makePdca(member.token);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('plan');
    expect(res.body.owner_user).toBeNull();
    expect(res.body.target_date).toBeNull();
    expect(res.body.plan_content).toBeNull();
    expect(res.body.created_by).toBe(member.id);
  });

  it('accepte owner, target_date et plan_content à la création', async () => {
    tenant = await createTenant();
    const res = await makePdca(tenant.admin.token, {
      owner: tenant.admin.id,
      target_date: '2026-12-31',
      plan_content: 'Objectif : réduire les rebuts de 20%.',
    });
    expect(res.status).toBe(201);
    expect(res.body.owner_user.id).toBe(tenant.admin.id);
    expect(res.body.target_date).toBe('2026-12-31');
    expect(res.body.plan_content).toBe('Objectif : réduire les rebuts de 20%.');
  });

  it('rejette un titre vide', async () => {
    tenant = await createTenant();
    const res = await makePdca(tenant.admin.token, { title: '' });
    expect(res.status).toBe(400);
  });

  it('ignore status/do_content/check_content/act_content envoyés à la création', async () => {
    tenant = await createTenant();
    const res = await makePdca(tenant.admin.token, { status: 'closed', do_content: 'x', check_content: 'y', act_content: 'z' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('plan');
    expect(res.body.do_content).toBeNull();
    expect(res.body.check_content).toBeNull();
    expect(res.body.act_content).toBeNull();
  });
});

describe('PATCH /api/pdca/:id — admin/manager ou créateur', () => {
  it("le créateur (member) peut modifier son propre plan_content ; un autre member ne peut pas", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [creator, other] = tenant.users;
    const pdca = await makePdca(creator.token);

    const ownUpdate = await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${creator.token}`)
      .send({ plan_content: 'Analyse des causes de rebuts en cours.' });
    expect(ownUpdate.status).toBe(200);
    expect(ownUpdate.body.plan_content).toBe('Analyse des causes de rebuts en cours.');

    const otherAttempt = await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ plan_content: 'Je modifie le projet de quelqu’un d’autre.' });
    expect(otherAttempt.status).toBe(403);
  });

  it('admin/manager peuvent toujours modifier un projet créé par un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const pdca = await makePdca(member.token);

    const byAdmin = await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Titre corrigé par admin' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.title).toBe('Titre corrigé par admin');

    const byManager = await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ description: 'Ajout manager' });
    expect(byManager.status).toBe(200);
    expect(byManager.body.description).toBe('Ajout manager');
  });

  it('status n’est jamais accepté sur ce PATCH', async () => {
    tenant = await createTenant();
    const pdca = await makePdca(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', title: 'Toujours en plan' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('plan');
  });
});

describe('POST /api/pdca/:id/advance — progression séquentielle plan → do → check → act → closed', () => {
  it('rejette l’avancement depuis plan sans plan_content, réussit une fois rempli', async () => {
    tenant = await createTenant();
    const pdca = await makePdca(tenant.admin.token);

    const rejected = await request(app)
      .post(`/api/pdca/${pdca.body.id}/advance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(rejected.status).toBe(400);

    await request(app)
      .patch(`/api/pdca/${pdca.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ plan_content: 'Plan défini.' });

    const advanced = await request(app)
      .post(`/api/pdca/${pdca.body.id}/advance`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(advanced.status).toBe(200);
    expect(advanced.body.status).toBe('do');
    expect(advanced.body.plan_completed_at).toBeTruthy();
  });

  it('parcourt tout le cycle jusqu’à closed, puis refuse un 5e avancement', async () => {
    tenant = await createTenant();
    const pdca = await makePdca(tenant.admin.token, { plan_content: 'Plan initial.' });
    const id = pdca.body.id;
    const token = tenant.admin.token;

    const toDo = await request(app).post(`/api/pdca/${id}/advance`).set('Authorization', `Bearer ${token}`).send({ do_content: 'Actions faites.' });
    expect(toDo.status).toBe(200);
    expect(toDo.body.status).toBe('do');
    expect(toDo.body.do_content).toBe('Actions faites.');

    const toCheck = await request(app)
      .post(`/api/pdca/${id}/advance`)
      .set('Authorization', `Bearer ${token}`)
      .send({ check_content: 'Vérification effectuée.' });
    expect(toCheck.status).toBe(200);
    expect(toCheck.body.status).toBe('check');

    const toAct = await request(app).post(`/api/pdca/${id}/advance`).set('Authorization', `Bearer ${token}`).send({ act_content: 'Ajustements faits.' });
    expect(toAct.status).toBe(200);
    expect(toAct.body.status).toBe('act');

    const toClosed = await request(app).post(`/api/pdca/${id}/advance`).set('Authorization', `Bearer ${token}`).send({});
    expect(toClosed.status).toBe(200);
    expect(toClosed.body.status).toBe('closed');
    expect(toClosed.body.closed_at).toBeTruthy();
    expect(toClosed.body.act_completed_at).toBeTruthy();

    const fifthAttempt = await request(app).post(`/api/pdca/${id}/advance`).set('Authorization', `Bearer ${token}`).send({});
    expect(fifthAttempt.status).toBe(400);
  });

  it('403 pour un member qui n’est ni admin/manager ni créateur du projet', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [creator, other] = tenant.users;
    const pdca = await makePdca(creator.token, { plan_content: 'Plan.' });

    const res = await request(app).post(`/api/pdca/${pdca.body.id}/advance`).set('Authorization', `Bearer ${other.token}`).send({});
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/pdca/bulk-category et DELETE /api/pdca/bulk — permissions en masse', () => {
  it('bulk-category est réservé admin/manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const pdca = await makePdca(tenant.admin.token);
    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'pdca', name: 'Dossier PDCA' });

    const memberAttempt = await request(app)
      .patch('/api/pdca/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [pdca.body.id], category_id: category.body.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/pdca/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [pdca.body.id], category_id: category.body.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });

  it('bulk-delete : un non-admin ne supprime que ses propres projets, les autres sont silencieusement ignorés', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;
    const ownPdca = await makePdca(memberA.token, { title: 'Le mien' });
    const othersPdca = await makePdca(memberB.token, { title: 'Pas le mien' });

    const res = await request(app)
      .delete('/api/pdca/bulk')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ ids: [ownPdca.body.id, othersPdca.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const stillThere = await request(app).get(`/api/pdca/${othersPdca.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(stillThere.status).toBe(200);

    const gone = await request(app).get(`/api/pdca/${ownPdca.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(gone.status).toBe(404);
  });
});

describe('DELETE /api/pdca/:id — admin ou créateur', () => {
  it('403 pour un manager qui n’a pas créé le projet ; 204 pour le créateur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const pdca = await makePdca(member.token);

    const managerAttempt = await request(app).delete(`/api/pdca/${pdca.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(managerAttempt.status).toBe(403);

    const creatorAttempt = await request(app).delete(`/api/pdca/${pdca.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(creatorAttempt.status).toBe(204);
  });
});

describe('Catégorie restreinte — visibilité GET /, GET /:id', () => {
  it("un member ne voit un projet PDCA d'une catégorie restreinte qu'avec une permission de catégorie ; admin voit toujours", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token);
    const pdca = await makePdca(tenant.admin.token, { category_id: category.id });

    const memberList = await request(app).get('/api/pdca').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((p) => p.id)).not.toContain(pdca.body.id);

    const memberDetail = await request(app).get(`/api/pdca/${pdca.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);

    const adminList = await request(app).get('/api/pdca').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((p) => p.id)).toContain(pdca.body.id);

    const adminDetail = await request(app).get(`/api/pdca/${pdca.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDetail.status).toBe(200);
  });
});
