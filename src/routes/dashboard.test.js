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

async function makeService(token, name) {
  const res = await request(app).post('/api/services').set('Authorization', `Bearer ${token}`).send({ name });
  return res.body.id;
}

async function makeCapa(token, title, { serviceId, status, assignedTo } = {}) {
  const res = await request(app)
    .post('/api/capas')
    .set('Authorization', `Bearer ${token}`)
    .send({ title, service_id: serviceId, assigned_to: assignedTo });
  if (status && status !== 'open') {
    await admin.from('capas').update({ status }).eq('id', res.body.id);
  }
  return res.body.id;
}

describe('GET /api/dashboard/stats — filtrage par rôle', () => {
  it('admin voit tout le tenant par défaut, et peut filtrer sur un service', async () => {
    tenant = await createTenant();
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    const serviceB = await makeService(tenant.admin.token, 'Service B');

    await makeCapa(tenant.admin.token, 'A open', { serviceId: serviceA });
    await makeCapa(tenant.admin.token, 'A overdue', { serviceId: serviceA, status: 'overdue' });
    await makeCapa(tenant.admin.token, 'B closed', { serviceId: serviceB, status: 'closed' });

    const wholeTenant = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(wholeTenant.body.capas).toEqual({ open: 1, in_progress: 0, overdue: 1, closed: 1 });

    const filtered = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: serviceA })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(filtered.body.capas).toEqual({ open: 1, in_progress: 0, overdue: 1, closed: 0 });
  });

  it('manager auto-scopé sur ses services, élargissement ponctuel possible', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    const serviceB = await makeService(tenant.admin.token, 'Service B');
    await request(app)
      .post(`/api/services/${serviceA}/assign-user`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: manager.id });

    await makeCapa(tenant.admin.token, 'A open', { serviceId: serviceA });
    await makeCapa(tenant.admin.token, 'B closed', { serviceId: serviceB, status: 'closed' });

    const scoped = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${manager.token}`);
    expect(scoped.body.capas).toEqual({ open: 1, in_progress: 0, overdue: 0, closed: 0 });

    const widened = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: serviceB })
      .set('Authorization', `Bearer ${manager.token}`);
    expect(widened.body.capas).toEqual({ open: 0, in_progress: 0, overdue: 0, closed: 1 });

    // L'élargissement ponctuel ne doit rien changer au périmètre par défaut du prochain appel.
    const scopedAgain = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${manager.token}`);
    expect(scopedAgain.body.capas.open).toBe(1);
  });

  it('manager sans service rattaché voit tout à zéro par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    await makeCapa(tenant.admin.token, 'Non rattachée');

    const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${manager.token}`);
    expect(res.body.capas).toEqual({ open: 0, in_progress: 0, overdue: 0, closed: 0 });
  });

  it('member ne voit que ses propres CAPA, jamais de vue tenant/service, documents.to_review = 0', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    await makeCapa(tenant.admin.token, 'Pour A', { assignedTo: memberA.id });
    await makeCapa(tenant.admin.token, 'Pour B', { assignedTo: memberB.id });

    const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${memberA.token}`);
    expect(res.body.capas).toEqual({ open: 1, in_progress: 0, overdue: 0, closed: 0 });
    expect(res.body.documents.to_review).toBe(0);

    // service_id est ignoré pour ce rôle.
    const withServiceId = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: '00000000-0000-0000-0000-000000000000' })
      .set('Authorization', `Bearer ${memberA.token}`);
    expect(withServiceId.body.capas.open).toBe(1);
  });

  it('accepte plusieurs service_id (paramètre répété) et rejette un id invalide', async () => {
    tenant = await createTenant();
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    const serviceB = await makeService(tenant.admin.token, 'Service B');
    await makeCapa(tenant.admin.token, 'A', { serviceId: serviceA });
    await makeCapa(tenant.admin.token, 'B', { serviceId: serviceB });

    const both = await request(app)
      .get(`/api/dashboard/stats?service_id=${serviceA}&service_id=${serviceB}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(both.body.capas.open).toBe(2);

    const invalid = await request(app)
      .get(`/api/dashboard/stats?service_id=${serviceA}&service_id=not-a-uuid`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(invalid.status).toBe(400);
  });
});
