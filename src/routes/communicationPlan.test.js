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

async function makeItem(token, overrides = {}) {
  const res = await request(app)
    .post('/api/communication-plan')
    .set('Authorization', `Bearer ${token}`)
    .send({
      subject: 'Politique qualité',
      audience: 'Tout le personnel',
      timing: 'À chaque révision',
      channel: 'Affichage + réunion d’équipe',
      ...overrides,
    });
  return res;
}

describe('GET /api/communication-plan — ouvert à tous les rôles', () => {
  it('200 pour un member, un manager et un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    await makeItem(tenant.admin.token);

    for (const token of [member.token, manager.token, tenant.admin.token]) {
      const res = await request(app).get('/api/communication-plan').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
    }
  });
});

describe('POST /api/communication-plan — réservé admin', () => {
  it('403 pour un member et un manager, 201 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeItem(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeItem(manager.token);
    expect(managerAttempt.status).toBe(403);

    const adminAttempt = await makeItem(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
    expect(adminAttempt.body.scope).toBe('internal');
    expect(adminAttempt.body.is_active).toBe(true);
  });

  it('rejette un champ requis manquant', async () => {
    tenant = await createTenant();

    for (const missing of ['subject', 'audience', 'timing', 'channel']) {
      const payload = {
        subject: 'X',
        audience: 'Y',
        timing: 'Z',
        channel: 'W',
      };
      delete payload[missing];
      const res = await request(app)
        .post('/api/communication-plan')
        .set('Authorization', `Bearer ${tenant.admin.token}`)
        .send(payload);
      expect(res.status).toBe(400);
    }
  });

  it('rejette une portée invalide', async () => {
    tenant = await createTenant();
    const res = await makeItem(tenant.admin.token, { scope: 'partout' });
    expect(res.status).toBe(400);
  });

  it('accepte une portée externe et un responsable', async () => {
    tenant = await createTenant();
    const res = await makeItem(tenant.admin.token, { scope: 'external', responsible_user_id: tenant.admin.id });
    expect(res.status).toBe(201);
    expect(res.body.scope).toBe('external');
    expect(res.body.responsible?.id).toBe(tenant.admin.id);
  });
});

describe('PATCH /api/communication-plan/:id — réservé admin', () => {
  it('403 pour un member/manager, 200 pour un admin ; bascule is_active', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const item = await makeItem(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ channel: 'Intranet' });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ channel: 'Intranet' });
    expect(managerAttempt.status).toBe(403);

    const deactivated = await request(app)
      .patch(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false, channel: 'Intranet' });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.is_active).toBe(false);
    expect(deactivated.body.channel).toBe('Intranet');
  });

  it('rejette un PATCH sans aucun champ', async () => {
    tenant = await createTenant();
    const item = await makeItem(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/communication-plan/:id — réservé admin', () => {
  it('403 pour un member et un manager, 204 pour un admin, 404 ensuite', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const item = await makeItem(tenant.admin.token);

    const memberDelete = await request(app)
      .delete(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDelete.status).toBe(403);

    const managerDelete = await request(app)
      .delete(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`);
    expect(managerDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);

    const again = await request(app)
      .delete(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(again.status).toBe(404);
  });
});

describe('Isolation multi-tenant', () => {
  it('un tenant ne voit pas le plan de communication d’un autre tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();
    await makeItem(other.admin.token);

    const list = await request(app).get('/api/communication-plan').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(0);

    await other.cleanup();
  });
});

describe('Plan de communication — dossiers (catégories génériques resource_type=communication_plan)', () => {
  it('création/modification avec category_id, catégorie jointe', async () => {
    tenant = await createTenant();

    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'communication_plan', name: 'Communication réglementaire' });
    expect(cat.status).toBe(201);

    const item = await makeItem(tenant.admin.token, { category_id: cat.body.id });
    expect(item.status).toBe(201);
    expect(item.body.category_id).toBe(cat.body.id);
    expect(item.body.category?.name).toBe('Communication réglementaire');

    const moved = await request(app)
      .patch(`/api/communication-plan/${item.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ category_id: null });
    expect(moved.status).toBe(200);
    expect(moved.body.category_id).toBeNull();
  });

  it('refuse un category_id invalide (autre resource_type)', async () => {
    tenant = await createTenant();
    const wrong = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'risk', name: 'Pas ici' });
    const res = await makeItem(tenant.admin.token, { category_id: wrong.body.id });
    expect(res.status).toBe(400);
  });

  it('un dossier restreint masque ses lignes pour un member sans permission', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'communication_plan', name: 'Direction only', is_restricted: true });
    const item = await makeItem(tenant.admin.token, { category_id: cat.body.id });

    const memberList = await request(app).get('/api/communication-plan').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((i) => i.id)).not.toContain(item.body.id);

    const adminList = await request(app).get('/api/communication-plan').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((i) => i.id)).toContain(item.body.id);
  });

  it('garde-fou : supprimer un dossier contenant une ligne renvoie 409', async () => {
    tenant = await createTenant();
    const cat = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'communication_plan', name: 'Thème X' });
    const item = await makeItem(tenant.admin.token, { category_id: cat.body.id });

    const blocked = await request(app)
      .delete(`/api/module-categories/${cat.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 ligne de plan de communication');

    await request(app).delete(`/api/communication-plan/${item.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    const ok = await request(app)
      .delete(`/api/module-categories/${cat.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});
