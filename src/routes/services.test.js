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

describe('Services CRUD — admin only, read open to all roles', () => {
  it('member/manager bloqués en écriture, lecture ouverte à tous', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;

    for (const user of [manager, member]) {
      const res = await request(app)
        .post('/api/services')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ name: 'Service interdit' });
      expect(res.status).toBe(403);
    }

    const created = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Qualité' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/services').set('Authorization', `Bearer ${member.token}`);
    expect(list.status).toBe(200);
    expect(list.body.some((s) => s.id === created.body.id)).toBe(true);
  });

  it('GET /services renvoie aussi les services inactifs', async () => {
    tenant = await createTenant();
    const created = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Service à désactiver' });

    await request(app)
      .patch(`/api/services/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ is_active: false });

    const list = await request(app).get('/api/services').set('Authorization', `Bearer ${tenant.admin.token}`);
    const found = list.body.find((s) => s.id === created.body.id);
    expect(found).toBeDefined();
    expect(found.is_active).toBe(false);
  });

  it('refuse la suppression si des CAPA sont rattachées, avec un message clair', async () => {
    tenant = await createTenant();
    const service = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Service utilisé' });

    const capa = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA liée', service_id: service.body.id });
    expect(capa.body.service_id).toBe(service.body.id);

    const blocked = await request(app)
      .delete(`/api/services/${service.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/désactiv/i);

    await admin.from('capas').delete().eq('id', capa.body.id);

    const ok = await request(app)
      .delete(`/api/services/${service.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });

  it('assign-user / unassign / my-services fonctionnent ensemble', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const service = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Équipe Qualité' });

    const assign = await request(app)
      .post(`/api/services/${service.body.id}/assign-user`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: manager.id });
    expect(assign.status).toBe(201);

    const mine = await request(app).get('/api/services/my-services').set('Authorization', `Bearer ${manager.token}`);
    expect(mine.body.map((s) => s.id)).toContain(service.body.id);

    const managers = await request(app)
      .get(`/api/services/${service.body.id}/managers`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(managers.body.map((m) => m.id)).toContain(manager.id);

    const unassign = await request(app)
      .delete(`/api/services/${service.body.id}/assign-user/${manager.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(unassign.status).toBe(204);

    const mineAfter = await request(app).get('/api/services/my-services').set('Authorization', `Bearer ${manager.token}`);
    expect(mineAfter.body).toHaveLength(0);
  });
});
