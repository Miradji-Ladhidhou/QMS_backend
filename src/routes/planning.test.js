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

describe('GET /api/planning — agrégation chronologique par rôle', () => {
  it('admin voit CAPA + documents + tâches du tenant, triés par date', async () => {
    tenant = await createTenant();
    const categoryRes = await admin
      .from('document_categories')
      .insert({ tenant_id: tenant.tenantId, name: 'Cat' })
      .select()
      .single();

    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa planning', due_date: '2026-08-01' });
    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Tâche planning', due_date: '2026-07-01' });
    await admin
      .from('documents')
      .insert({ tenant_id: tenant.tenantId, category_id: categoryRes.data.id, number: 'DOC-1', title: 'Doc planning', review_date: '2026-09-01' });

    const res = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);

    const types = res.body.items.map((item) => item.type);
    expect(types).toContain('capa');
    expect(types).toContain('document');
    expect(types).toContain('task');

    const dates = res.body.items.map((item) => item.date);
    expect(dates).toEqual([...dates].sort());
  });

  it('un CAPA clôturé n’apparaît pas dans le planning', async () => {
    tenant = await createTenant();
    const capa = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa à clôturer', due_date: '2026-08-01' });
    await request(app)
      .patch(`/api/capas/${capa.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });

    const res = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.body.items.some((item) => item.type === 'capa' && item.id === capa.body.id)).toBe(false);
  });

  it('manager auto-scopé sur son service ; member ne voit que ses propres éléments, jamais les documents', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }, { role: 'member' }] });
    const [manager, memberA, memberB] = tenant.users;
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    await request(app)
      .post(`/api/services/${serviceA}/assign-user`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: manager.id });

    const capaA = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa service A', due_date: '2026-08-01', assigned_to: memberA.id });
    await admin.from('capas').update({ service_id: serviceA }).eq('id', capaA.body.id);

    const capaB = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa de B', due_date: '2026-08-05', assigned_to: memberB.id });

    // Manager : ne voit que la CAPA du service A (auto-scope), pas celle de memberB.
    const managerRes = await request(app).get('/api/planning').set('Authorization', `Bearer ${manager.token}`);
    const managerCapaIds = managerRes.body.items.filter((i) => i.type === 'capa').map((i) => i.id);
    expect(managerCapaIds).toContain(capaA.body.id);
    expect(managerCapaIds).not.toContain(capaB.body.id);

    // Member A : uniquement sa propre CAPA assignée, jamais de documents.
    const categoryRes = await admin.from('document_categories').insert({ tenant_id: tenant.tenantId, name: 'Cat' }).select().single();
    await admin.from('documents').insert({ tenant_id: tenant.tenantId, category_id: categoryRes.data.id, number: 'DOC-2', title: 'Doc', review_date: '2026-09-01' });

    const memberARes = await request(app).get('/api/planning').set('Authorization', `Bearer ${memberA.token}`);
    const memberATypes = memberARes.body.items.map((i) => i.type);
    expect(memberATypes).not.toContain('document');
    const memberACapaIds = memberARes.body.items.filter((i) => i.type === 'capa').map((i) => i.id);
    expect(memberACapaIds).toEqual([capaA.body.id]);
  });

  it('accepte plusieurs service_id et rejette un id invalide', async () => {
    tenant = await createTenant();
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    const serviceB = await makeService(tenant.admin.token, 'Service B');
    const capaA = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa A', due_date: '2026-08-01' });
    await admin.from('capas').update({ service_id: serviceA }).eq('id', capaA.body.id);
    const capaB = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Capa B', due_date: '2026-08-02' });
    await admin.from('capas').update({ service_id: serviceB }).eq('id', capaB.body.id);

    const both = await request(app)
      .get(`/api/planning?service_id=${serviceA}&service_id=${serviceB}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    const ids = both.body.items.filter((i) => i.type === 'capa').map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([capaA.body.id, capaB.body.id]));

    const invalid = await request(app)
      .get('/api/planning?service_id=not-a-uuid')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(invalid.status).toBe(400);
  });

  it('inclut les formations à échéance pour du personnel sans compte, avec le nom résolu', async () => {
    tenant = await createTenant();
    const employee = await request(app)
      .post('/api/employees')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ full_name: 'Nadia Ligne' });
    const training = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation planning', frequency_months: 6 });
    await request(app)
      .post(`/api/trainings/${training.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ employee_id: employee.body.id, completed_at: '2026-01-01' });

    const res = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    const trainingItem = res.body.items.find((i) => i.type === 'training' && i.title.includes('Nadia Ligne'));
    expect(trainingItem).toBeDefined();
    expect(trainingItem.date).toBe('2026-07-01');
  });

  it('inclut les audits non clôturés ; un member ne voit que ceux qu’il mène', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const audit = await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit process production', planned_date: '2026-08-01', lead_auditor: member.id });

    const adminRes = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    const adminAuditItem = adminRes.body.items.find((i) => i.type === 'audit' && i.id === audit.body.id);
    expect(adminAuditItem).toBeDefined();
    expect(adminAuditItem.is_overdue).toBe(true);

    const memberRes = await request(app).get('/api/planning').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.items.some((i) => i.type === 'audit' && i.id === audit.body.id)).toBe(true);

    // Un audit clôturé ne doit plus apparaître.
    await request(app)
      .patch(`/api/audits/${audit.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    const afterClose = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterClose.body.items.some((i) => i.type === 'audit' && i.id === audit.body.id)).toBe(false);
  });

  it('inclut les réclamations non résolues avec échéance ; un member ne voit que les siennes', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const complaint = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        customer_name: 'Client planning',
        received_date: '2026-08-01',
        due_date: '2026-08-01',
        description: 'Retard de livraison',
        assigned_to: member.id,
      });

    const adminRes = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    const item = adminRes.body.items.find((i) => i.type === 'complaint' && i.id === complaint.body.id);
    expect(item).toBeDefined();
    expect(item.is_overdue).toBe(true);

    const memberRes = await request(app).get('/api/planning').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.items.some((i) => i.type === 'complaint' && i.id === complaint.body.id)).toBe(true);

    await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved' });
    const afterResolved = await request(app).get('/api/planning').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterResolved.body.items.some((i) => i.type === 'complaint' && i.id === complaint.body.id)).toBe(false);
  });
});
