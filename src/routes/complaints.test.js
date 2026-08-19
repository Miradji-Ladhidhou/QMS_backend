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

async function makeComplaint(token, overrides = {}) {
  const res = await request(app)
    .post('/api/complaints')
    .set('Authorization', `Bearer ${token}`)
    .send({
      customer_name: 'Client Test SARL',
      received_date: '2026-08-15',
      description: 'Produit livré endommagé',
      ...overrides,
    });
  return res;
}

describe('POST /api/complaints — création ouverte à tous les rôles, auto-assignation pour un member', () => {
  it('201 pour tous les rôles ; un member se voit toujours auto-assigner la réclamation', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    for (const actor of [tenant.admin, ...tenant.users]) {
      const res = await makeComplaint(actor.token, { customer_name: `Client de ${actor.email}` });
      expect(res.status).toBe(201);
    }

    // Un member ne peut pas assigner la réclamation à quelqu'un d'autre.
    const attempt = await makeComplaint(member.token, { assigned_to: manager.id });
    expect(attempt.body.assigned.id).toBe(member.id);
  });
});

describe('GET /api/complaints — scope par rôle comme CAPA', () => {
  it('un member ne voit que les réclamations qui lui sont assignées ; admin/manager voient tout', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const forA = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Pour A', received_date: '2026-08-10', description: 'Réclamation A', assigned_to: memberA.id });
    await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Pour B', received_date: '2026-08-10', description: 'Réclamation B', assigned_to: memberB.id });

    const memberARes = await request(app).get('/api/complaints').set('Authorization', `Bearer ${memberA.token}`);
    expect(memberARes.body.map((c) => c.id)).toEqual([forA.body.id]);

    const adminRes = await request(app).get('/api/complaints').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.length).toBe(2);
  });
});

describe('PATCH /api/complaints/:id — réservé à admin/manager, comme CAPA', () => {
  it('403 pour un member même sur sa propre réclamation assignée ; un manager peut la faire évoluer', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const complaint = await makeComplaint(member.token);

    const memberAttempt = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'investigating' });
    expect(memberAttempt.status).toBe(403);

    const managerUpdate = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        status: 'resolved',
        root_cause: 'Emballage insuffisant pour le transport',
        resolution: 'Produit remplacé, emballage renforcé',
        resolution_date: '2026-08-18',
        customer_satisfied: true,
      });
    expect(managerUpdate.status).toBe(200);
    expect(managerUpdate.body.status).toBe('resolved');
    expect(managerUpdate.body.customer_satisfied).toBe(true);
  });
});

describe('POST /api/complaints/:id/create-capa — lien bidirectionnel', () => {
  it('crée une CAPA liée, visible dans les deux sens, et la CAPA survit à la suppression de la réclamation', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    const capa = await request(app)
      .post(`/api/complaints/${complaint.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Renforcer les emballages export' });
    expect(capa.status).toBe(201);
    expect(capa.body.complaint_id).toBe(complaint.body.id);
    expect(capa.body.origin).toContain('Réclamation client');

    const detail = await request(app)
      .get(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.linked_capa.id).toBe(capa.body.id);

    const del = await request(app)
      .delete(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.complaint_id).toBeNull();
  });
});
