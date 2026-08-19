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

async function makeAudit(token, overrides = {}) {
  const res = await request(app)
    .post('/api/audits')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Audit ligne de production', planned_date: '2026-09-01', ...overrides });
  return res;
}

describe('POST /api/audits — planification réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeAudit(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeAudit(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.status).toBe('planned');
    expect(managerAttempt.body.audit_type).toBe('process');
  });
});

describe('GET /api/audits — visible à tous les rôles', () => {
  it('un member voit les audits planifiés par un admin (transparence tenant-wide)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    await makeAudit(tenant.admin.token, { title: 'Audit visible par tous' });

    const res = await request(app).get('/api/audits').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((audit) => audit.title === 'Audit visible par tous')).toBe(true);
  });

  it('filtre par statut et par service', async () => {
    tenant = await createTenant();
    const serviceRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Production' });
    const serviceId = serviceRes.body.id;

    const inService = await makeAudit(tenant.admin.token, { title: 'Audit du service', service_id: serviceId });
    await makeAudit(tenant.admin.token, { title: 'Audit sans service' });

    const filtered = await request(app)
      .get(`/api/audits?service_id=${serviceId}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(filtered.body.map((a) => a.id)).toEqual([inService.body.id]);

    await request(app)
      .patch(`/api/audits/${inService.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed' });

    const byStatus = await request(app)
      .get('/api/audits?status=completed')
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(byStatus.body.map((a) => a.id)).toEqual([inService.body.id]);
  });
});

describe('PATCH /api/audits/:id — réservé à admin/manager', () => {
  it('403 pour un member ; un manager peut faire évoluer le statut et conclure', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const created = await makeAudit(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/audits/${created.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'in_progress' });
    expect(memberAttempt.status).toBe(403);

    const managerUpdate = await request(app)
      .patch(`/api/audits/${created.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'closed', completed_date: '2026-09-05', conclusion: 'SMQ conforme, 2 non-conformités mineures.' });
    expect(managerUpdate.status).toBe(200);
    expect(managerUpdate.body.status).toBe('closed');
    expect(managerUpdate.body.conclusion).toBe('SMQ conforme, 2 non-conformités mineures.');
  });
});

describe('Constats d’audit — CRUD réservé à admin/manager, création de CAPA liée', () => {
  it('ajoute un constat, le lie à une CAPA créée à la volée, et retrouve la CAPA dans le détail de l’audit', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const audit = await makeAudit(tenant.admin.token);

    const memberFindingAttempt = await request(app)
      .post(`/api/audits/${audit.body.id}/findings`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ type: 'minor_nc', description: 'Constat ajouté par un member' });
    expect(memberFindingAttempt.status).toBe(403);

    const finding = await request(app)
      .post(`/api/audits/${audit.body.id}/findings`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ type: 'major_nc', description: 'Procédure de nettoyage non affichée en zone de production' });
    expect(finding.status).toBe(201);
    expect(finding.body.linked_capa).toBeNull();

    const capa = await request(app)
      .post(`/api/audits/${audit.body.id}/findings/${finding.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Afficher la procédure de nettoyage' });
    expect(capa.status).toBe(201);
    expect(capa.body.audit_finding_id).toBe(finding.body.id);
    expect(capa.body.origin).toContain('Audit interne');

    const auditDetail = await request(app)
      .get(`/api/audits/${audit.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(auditDetail.body.findings).toHaveLength(1);
    expect(auditDetail.body.findings[0].linked_capa.id).toBe(capa.body.id);
  });

  it('supprimer un audit supprime ses constats mais laisse la CAPA déjà créée survivre (audit_finding_id -> null)', async () => {
    tenant = await createTenant();
    const audit = await makeAudit(tenant.admin.token);
    const finding = await request(app)
      .post(`/api/audits/${audit.body.id}/findings`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ type: 'observation', description: 'Remarque mineure' });
    const capa = await request(app)
      .post(`/api/audits/${audit.body.id}/findings/${finding.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Action corrective' });

    const del = await request(app).delete(`/api/audits/${audit.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.audit_finding_id).toBeNull();
  });
});
