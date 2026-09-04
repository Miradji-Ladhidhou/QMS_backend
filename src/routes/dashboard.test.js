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

async function makeCapa(token, title, { serviceId, status, assignedTo, categoryId } = {}) {
  const res = await request(app)
    .post('/api/capas')
    .set('Authorization', `Bearer ${token}`)
    .send({ title, service_id: serviceId, assigned_to: assignedTo, category_id: categoryId });
  if (status && status !== 'open') {
    await admin.from('capas').update({ status }).eq('id', res.body.id);
  }
  return res.body.id;
}

async function makeProcedure(token, number, { nextReviewDate, status } = {}) {
  const res = await request(app)
    .post('/api/procedures')
    .set('Authorization', `Bearer ${token}`)
    .send({ number, title: `Procédure ${number}`, next_review_date: nextReviewDate });
  if (status) {
    await admin.from('procedures').update({ status }).eq('id', res.body.id);
  }
  return res.body.id;
}

async function makeRestrictedCategory(token, name = 'Restreinte') {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: 'capa', name, is_restricted: true });
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

  it("le compteur de CAPA n'inclut pas une catégorie restreinte sans permission — même pour son propre assigné", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;
    const categoryId = await makeRestrictedCategory(tenant.admin.token);
    const serviceId = await makeService(tenant.admin.token, 'Service unique');
    await request(app)
      .post(`/api/services/${serviceId}/assign-user`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: manager.id });

    await makeCapa(tenant.admin.token, 'Ouverte à tous', { serviceId });
    await makeCapa(tenant.admin.token, 'Restreinte', { serviceId, categoryId, assignedTo: member.id });

    const adminStats = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminStats.body.capas.open).toBe(2);

    const managerStats = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${manager.token}`);
    expect(managerStats.body.capas.open).toBe(1);

    const memberStats = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberStats.body.capas.open).toBe(0);

    await request(app)
      .post(`/api/module-categories/${categoryId}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: member.id, can_view: true })
      .expect(201);

    const memberStatsAfter = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberStatsAfter.body.capas.open).toBe(1);
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

  it('compte les KPI hors objectif pour admin/manager (avec aperçu mini-courbe), toujours à 0/vide pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de rebut', target: 5, target_direction: 'max' });
    await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-08-01', value: 10 });
    await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-08-02', value: 12 });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.kpis.off_target).toBe(1);
    expect(adminRes.body.kpis.preview).toHaveLength(1);
    expect(adminRes.body.kpis.preview[0]).toMatchObject({ id: kpi.body.id, name: 'Taux de rebut', average: 11 });
    // Ordonné par période croissante, pas par date d'insertion.
    expect(adminRes.body.kpis.preview[0].sparkline).toEqual([10, 12]);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.kpis.off_target).toBe(0);
    expect(memberRes.body.kpis.preview).toEqual([]);
  });

  it('compte les plans HACCP actifs pour admin/manager (filtrable par service), toujours à 0 pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const serviceA = await makeService(tenant.admin.token, 'Production');

    const planActive = await request(app)
      .post('/api/haccp/plans')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Plan actif', service_id: serviceA });
    await request(app)
      .patch(`/api/haccp/plans/${planActive.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'active' });
    await request(app)
      .post('/api/haccp/plans')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Plan brouillon' }); // status par défaut 'draft', pas compté

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.haccp.active_plans).toBe(1);

    const scoped = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: serviceA })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(scoped.body.haccp.active_plans).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.haccp.active_plans).toBe(0);
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

  it('total "en retard" inclut les fournisseurs en retard de réévaluation pour admin, jamais pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const supplier = await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Fournisseur en retard', next_evaluation_date: '2026-08-01' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.overdue.total).toBe(1);

    // Pas de porteur individuel sur un fournisseur : jamais compté dans le total d'un member.
    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.overdue.total).toBe(0);

    await request(app)
      .patch(`/api/suppliers/${supplier.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'inactive' });
    const afterInactive = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterInactive.body.overdue.total).toBe(0);
  });

  it('widgets par outil (audits/réclamations/risques) : personnels pour member, tout le tenant pour admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit A', planned_date: '2026-12-01', lead_auditor: memberA.id });
    await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit B', planned_date: '2026-12-01', lead_auditor: memberB.id });

    await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        customer_name: 'Client A',
        received_date: '2026-08-01',
        due_date: '2026-12-01',
        description: 'Réclamation A',
        assigned_to: memberA.id,
      });

    const risk = await request(app)
      .post('/api/risks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Risque A', likelihood: 4, impact: 4, owner: memberA.id, review_date: '2026-08-01' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.audits).toEqual({ active: 2, overdue: 0 });
    expect(adminRes.body.complaints).toEqual({ active: 1, overdue: 0 });
    expect(adminRes.body.risks).toEqual({ active: 1, overdue: 1 });

    const memberARes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${memberA.token}`);
    expect(memberARes.body.audits).toEqual({ active: 1, overdue: 0 });
    expect(memberARes.body.complaints).toEqual({ active: 1, overdue: 0 });
    expect(memberARes.body.risks).toEqual({ active: 1, overdue: 1 });

    const memberBRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${memberB.token}`);
    expect(memberBRes.body.audits).toEqual({ active: 1, overdue: 0 });
    expect(memberBRes.body.complaints).toEqual({ active: 0, overdue: 0 });
    expect(memberBRes.body.risks).toEqual({ active: 0, overdue: 0 });

    await request(app)
      .patch(`/api/risks/${risk.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    const afterClosed = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterClosed.body.risks).toEqual({ active: 0, overdue: 0 });
  });

  it('compte les procédures à réviser sous 30 jours pour admin/manager (jamais scopé par service, pas de service_id sur procedures), toujours à 0 pour member, exclut les obsolètes', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const serviceA = await makeService(tenant.admin.token, 'Service A');

    await makeProcedure(tenant.admin.token, 'PROC-D01', { nextReviewDate: '2026-08-20' }); // sous 30 jours
    await makeProcedure(tenant.admin.token, 'PROC-D02', { nextReviewDate: '2027-01-01' }); // hors fenêtre
    await makeProcedure(tenant.admin.token, 'PROC-D03', { nextReviewDate: '2026-08-15', status: 'obsolete' }); // exclue

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.procedures.to_review).toBe(1);

    // Filtrer sur un service ne change rien : les procédures n'ont pas de service_id.
    const scoped = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: serviceA })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(scoped.body.procedures.to_review).toBe(1);

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.procedures.to_review).toBe(0);
  });

  it('total "en retard" inclut aussi les procédures en retard de révision pour admin, jamais pour member, exclut les obsolètes', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await makeProcedure(tenant.admin.token, 'PROC-D04', { nextReviewDate: '2026-08-01' });
    await makeProcedure(tenant.admin.token, 'PROC-D05', { nextReviewDate: '2026-08-01', status: 'obsolete' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.overdue.total).toBe(1);

    // Pas de porteur individuel sur une procédure : jamais compté dans le total d'un member.
    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.overdue.total).toBe(0);
  });

  it('fournisseurs et revues de direction : uniquement pour admin/manager, toujours à 0 pour member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    await request(app)
      .post('/api/suppliers')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Fournisseur A', next_evaluation_date: '2026-08-01' });

    const review = await request(app)
      .post('/api/management-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Revue S2 2026', review_date: '2026-12-01' });

    const adminRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.suppliers).toEqual({ active: 1, overdue: 1 });
    expect(adminRes.body.management_reviews).toEqual({ draft: 1 });

    const memberRes = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${member.token}`);
    expect(memberRes.body.suppliers).toEqual({ active: 0, overdue: 0 });
    expect(memberRes.body.management_reviews).toEqual({ draft: 0 });

    await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed' });
    const afterCompleted = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterCompleted.body.management_reviews).toEqual({ draft: 0 });
  });
});

// Instantanés écrits uniquement par dashboardSnapshotJob.js (jamais par la route) — on en
// seed un directement en base pour tester le calcul de delta sans attendre 30 jours réels.
describe('GET /api/dashboard/stats — tendances (dashboard_metric_snapshots)', () => {
  it('null sans instantané assez ancien ; delta correct dès qu’un instantané à J-30 ou plus existe', async () => {
    tenant = await createTenant();
    await makeCapa(tenant.admin.token, 'CAPA du jour');

    const noSnapshot = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(noSnapshot.body.trends).toBeNull();

    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);
    await admin.from('dashboard_metric_snapshots').insert({
      tenant_id: tenant.tenantId,
      snapshot_date: thirtyOneDaysAgo.toISOString().slice(0, 10),
      metrics: { capas: { open: 1, in_progress: 0, overdue: 0, closed: 0 }, audits: { active: 2, overdue: 0 } },
    });

    const withSnapshot = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tenant.admin.token}`);
    // 1 CAPA créée dans ce test + le compte réel d'audits (0) comparés à l'instantané (1 et 2).
    expect(withSnapshot.body.trends['capas.open']).toBe(0);
    expect(withSnapshot.body.trends['audits.active']).toBe(-2);
  });

  it('toujours null dès qu’un filtre de service est actif (instantanés tenant entier uniquement)', async () => {
    tenant = await createTenant();
    const serviceA = await makeService(tenant.admin.token, 'Service A');
    await makeCapa(tenant.admin.token, 'CAPA', { serviceId: serviceA });

    const thirtyOneDaysAgo = new Date();
    thirtyOneDaysAgo.setDate(thirtyOneDaysAgo.getDate() - 31);
    await admin.from('dashboard_metric_snapshots').insert({
      tenant_id: tenant.tenantId,
      snapshot_date: thirtyOneDaysAgo.toISOString().slice(0, 10),
      metrics: { capas: { open: 0, in_progress: 0, overdue: 0, closed: 0 } },
    });

    const res = await request(app)
      .get('/api/dashboard/stats')
      .query({ service_id: serviceA })
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.body.trends).toBeNull();
  });
});

describe('GET /api/dashboard/recent-activity', () => {
  it('403 pour un member', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const res = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(403);
  });

  it('mélange plusieurs modules, trié du plus récent au plus ancien', async () => {
    tenant = await createTenant();
    const capaId = await makeCapa(tenant.admin.token, 'CAPA récente');
    const audit = await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit récent', planned_date: '2026-12-01' });

    // Rend l'audit strictement plus récent que la CAPA (même seconde sinon, ordre non garanti).
    await admin.from('audits').update({ updated_at: new Date(Date.now() + 5000).toISOString() }).eq('id', audit.body.id);

    const res = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    const modules = res.body.map((item) => item.module);
    expect(modules).toContain('capas');
    expect(modules).toContain('audits');
    expect(res.body[0]).toMatchObject({ module: 'audits', id: audit.body.id, action: 'created' });
    expect(res.body.some((item) => item.id === capaId)).toBe(true);
  });

  it("respecte la visibilité par catégorie restreinte, comme la liste CAPA elle-même", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const categoryId = await makeRestrictedCategory(tenant.admin.token);
    await makeCapa(tenant.admin.token, 'CAPA restreinte', { categoryId });
    await makeCapa(tenant.admin.token, 'CAPA ouverte');

    const managerRes = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${manager.token}`);
    expect(managerRes.body.some((item) => item.label.includes('restreinte'))).toBe(false);
    expect(managerRes.body.some((item) => item.label.includes('ouverte'))).toBe(true);

    const adminRes = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.some((item) => item.label.includes('restreinte'))).toBe(true);
  });

  it('inclut les procédures, sans filtrage par catégorie (le module n’en a pas)', async () => {
    tenant = await createTenant();
    const procedureId = await makeProcedure(tenant.admin.token, 'PROC-D06');

    const res = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    const entry = res.body.find((item) => item.id === procedureId);
    expect(entry).toMatchObject({ module: 'procedures', link: `/procedures/${procedureId}`, action: 'created' });
    expect(entry.label).toContain('PROC-D06');
  });

  it('tronque à 8 résultats au total', async () => {
    tenant = await createTenant();
    for (let i = 0; i < 9; i += 1) {
      await makeCapa(tenant.admin.token, `CAPA ${i}`);
    }

    const res = await request(app).get('/api/dashboard/recent-activity').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.body).toHaveLength(8);
  });
});
