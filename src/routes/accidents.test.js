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

async function makeAccident(token, overrides = {}) {
  const res = await request(app)
    .post('/api/accidents')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Chute de plain-pied', occurred_at: '2026-01-15', ...overrides });
  return res;
}

async function createRestrictedCategory(token, name = 'Restreinte') {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: 'accident', name, is_restricted: true });
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /api/accidents — création ouverte à tous les rôles', () => {
  it('201 pour un member, un manager ou un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeAccident(member.token);
    expect(memberAttempt.status).toBe(201);
    expect(memberAttempt.body.severity).toBe('minor');
    expect(memberAttempt.body.status).toBe('open');

    const managerAttempt = await makeAccident(manager.token);
    expect(managerAttempt.status).toBe(201);

    const adminAttempt = await makeAccident(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
  });

  it('rejette un titre ou une date manquante', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/accidents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ occurred_at: '2026-01-15' });
    expect(noTitle.status).toBe(400);

    const noDate = await request(app)
      .post('/api/accidents')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Chute de plain-pied' });
    expect(noDate.status).toBe(400);
  });

  it('rejette si injured_user_id ET injured_employee_id sont fournis ensemble', async () => {
    tenant = await createTenant();

    const employeeRes = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Ouvrier Test' });
    expect(employeeRes.status).toBe(201);

    const res = await makeAccident(tenant.admin.token, {
      injured_user_id: tenant.admin.id,
      injured_employee_id: employeeRes.body.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Choisissez une seule personne');
  });
});

describe('PATCH /api/accidents/:id — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un manager, closed_at posé à la clôture', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const accident = await makeAccident(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/accidents/${accident.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'investigating' });
    expect(memberAttempt.status).toBe(403);

    const investigating = await request(app)
      .patch(`/api/accidents/${accident.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'investigating', root_cause: 'Sol glissant non signalé' });
    expect(investigating.status).toBe(200);
    expect(investigating.body.closed_at).toBeNull();

    const closed = await request(app)
      .patch(`/api/accidents/${accident.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'closed' });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closed_at).not.toBeNull();
  });
});

describe('PATCH /api/accidents/bulk-category — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const accident = await makeAccident(tenant.admin.token);
    const category = await createRestrictedCategory(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch('/api/accidents/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [accident.body.id], category_id: category.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/accidents/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [accident.body.id], category_id: category.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });
});

describe('DELETE /api/accidents/:id — admin ou créateur', () => {
  it('un member peut supprimer son propre accident mais pas celui d’un autre ; admin supprime tout', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const ownAccident = await makeAccident(memberA.token);
    const otherAccident = await makeAccident(memberB.token);

    const forbidden = await request(app)
      .delete(`/api/accidents/${otherAccident.body.id}`)
      .set('Authorization', `Bearer ${memberA.token}`);
    expect(forbidden.status).toBe(403);

    const ownDelete = await request(app)
      .delete(`/api/accidents/${ownAccident.body.id}`)
      .set('Authorization', `Bearer ${memberA.token}`);
    expect(ownDelete.status).toBe(204);

    const adminDelete = await request(app)
      .delete(`/api/accidents/${otherAccident.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);
  });
});

describe('DELETE /api/accidents/bulk — filtrage silencieux selon le rôle', () => {
  it('un member ne supprime que ses propres accidents parmi les ids envoyés ; un admin supprime tout', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const ownAccident = await makeAccident(memberA.token);
    const otherAccident = await makeAccident(memberB.token);

    const memberBulk = await request(app)
      .delete('/api/accidents/bulk')
      .set('Authorization', `Bearer ${memberA.token}`)
      .send({ ids: [ownAccident.body.id, otherAccident.body.id] });
    expect(memberBulk.status).toBe(200);
    expect(memberBulk.body.deleted).toBe(1);

    const stillThere = await request(app)
      .get(`/api/accidents/${otherAccident.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(stillThere.status).toBe(200);

    const adminBulk = await request(app)
      .delete('/api/accidents/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [otherAccident.body.id] });
    expect(adminBulk.status).toBe(200);
    expect(adminBulk.body.deleted).toBe(1);
  });
});

describe('Catégorie restreinte — visibilité', () => {
  it("un accident d'une catégorie restreinte reste visible pour l'admin mais invisible pour un member sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await createRestrictedCategory(tenant.admin.token);
    const accident = await makeAccident(tenant.admin.token, { category_id: category.id });

    const adminList = await request(app).get('/api/accidents').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((a) => a.id)).toContain(accident.body.id);
    const adminDetail = await request(app).get(`/api/accidents/${accident.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDetail.status).toBe(200);

    const memberList = await request(app).get('/api/accidents').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((a) => a.id)).not.toContain(accident.body.id);
    const memberDetail = await request(app).get(`/api/accidents/${accident.body.id}`).set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);
  });
});

describe('POST /api/accidents/:id/create-capa — lien bidirectionnel, réservé admin/manager', () => {
  it('crée une CAPA liée avec accident_id et met à jour accidents.linked_capa_id', async () => {
    tenant = await createTenant();
    const accident = await makeAccident(tenant.admin.token);

    const capa = await request(app)
      .post(`/api/accidents/${accident.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Sécuriser la zone de circulation' });
    expect(capa.status).toBe(201);
    expect(capa.body.accident_id).toBe(accident.body.id);
    expect(capa.body.origin).toContain('Accident du travail');

    const detail = await request(app).get(`/api/accidents/${accident.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);
  });

  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const accident = await makeAccident(tenant.admin.token);

    const res = await request(app)
      .post(`/api/accidents/${accident.body.id}/create-capa`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Sécuriser la zone de circulation' });
    expect(res.status).toBe(403);
  });
});
