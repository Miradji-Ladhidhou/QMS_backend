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

  it('compte les KPI hors objectif pour admin/manager, toujours à 0 pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de rebut', target: 5, target_direction: 'max' });
    await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-08-01', value: 12 });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.kpis.off_target).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.kpis.off_target).toBe(0);
  });

  it('total "en retard" agrège CAPA + documents + formations + tâches, jamais de documents pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await makeCapa(tenant.admin.token, 'En retard pour A', { assignedTo: member.id });
    await admin.from('capas').update({ due_date: '2026-08-01' }).eq('tenant_id', tenant.tenantId).eq('title', 'En retard pour A');

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'Tâche en retard', due_date: '2026-08-01' });

    const categoryRes = await admin.from('document_categories').insert({ tenant_id: tenant.tenantId, name: 'Cat' }).select().single();
    await admin
      .from('documents')
      .insert({ tenant_id: tenant.tenantId, category_id: categoryRes.data.id, number: 'DOC-1', title: 'Doc en retard', review_date: '2026-08-01' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    // 1 CAPA + 1 document + 1 tâche en retard : les tâches sont toujours tenant-wide pour
    // admin/manager (pas de notion de service dessus), donc la tâche du member est incluse.
    expect(adminRes.body.overdue.total).toBe(3);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    // Le member voit sa CAPA assignée + sa propre tâche en retard, mais jamais le document.
    expect(memberRes.body.overdue.total).toBe(2);
  });

  it('total "en retard" inclut aussi les audits non clôturés en retard', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const audit = await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit en retard', planned_date: '2026-08-01', lead_auditor: member.id });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.overdue.total).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.overdue.total).toBe(1);

    await request(app)
      .patch(`/api/audits/${audit.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    const afterClose = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterClose.body.overdue.total).toBe(0);
  });

  it('total "en retard" inclut aussi les réclamations non résolues en retard', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const complaint = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        customer_name: 'Client en retard',
        received_date: '2026-08-01',
        due_date: '2026-08-01',
        description: 'Réclamation en retard',
        assigned_to: member.id,
      });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.overdue.total).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.overdue.total).toBe(1);

    await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved' });
    const afterResolved = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterResolved.body.overdue.total).toBe(0);
  });

  it('total "en retard" inclut aussi les risques en retard de revue', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const risk = await request(app)
      .post('/api/risks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Risque en retard', likelihood: 3, impact: 3, owner: member.id, review_date: '2026-08-01' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.overdue.total).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.overdue.total).toBe(1);

    await request(app)
      .patch(`/api/risks/${risk.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted' });
    const afterAccepted = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterAccepted.body.overdue.total).toBe(0);
  });
});
