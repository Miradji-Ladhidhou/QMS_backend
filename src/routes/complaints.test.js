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

describe('GET /api/complaints — visibilité cloisonnée par propriétaire', () => {
  it('un member ne voit que les réclamations qui lui sont assignées, pas tout le tenant', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [memberA, memberB] = tenant.users;

    const forA = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Pour A', received_date: '2026-08-10', description: 'Réclamation A', assigned_to: memberA.id });
    const forB = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Pour B', received_date: '2026-08-10', description: 'Réclamation B', assigned_to: memberB.id });

    const memberARes = await request(app).get('/api/complaints').set('Authorization', `Bearer ${memberA.token}`);
    expect(memberARes.body.map((c) => c.id)).toEqual([forA.body.id]);

    const memberBRes = await request(app).get('/api/complaints').set('Authorization', `Bearer ${memberB.token}`);
    expect(memberBRes.body.map((c) => c.id)).toEqual([forB.body.id]);

    const adminRes = await request(app).get('/api/complaints').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminRes.body.length).toBe(2);
  });

  it('un manager voit une réclamation créée par un autre manager une fois qu’elle lui est partagée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [managerA, managerB] = tenant.users;

    const created = await makeComplaint(managerA.token, { customer_name: 'Client de A' });

    const before = await request(app).get('/api/complaints').set('Authorization', `Bearer ${managerB.token}`);
    expect(before.body).toHaveLength(0);

    await request(app)
      .post('/api/shares')
      .set('Authorization', `Bearer ${managerA.token}`)
      .send({ resource_type: 'complaint', resource_id: created.body.id, subject_type: 'user', subject_id: managerB.id });

    const after = await request(app).get('/api/complaints').set('Authorization', `Bearer ${managerB.token}`);
    expect(after.body.map((c) => c.id)).toEqual([created.body.id]);
  });
});

describe('PATCH /api/complaints/:id — réservé à admin/manager, comme CAPA', () => {
  it('403 pour un member même sur sa propre réclamation assignée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const complaint = await makeComplaint(member.token);

    const memberAttempt = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ status: 'investigating' });
    expect(memberAttempt.status).toBe(403);
  });

  it('un manager qui n’a ni créé ni ne s’est vu assigner la réclamation ne peut plus la modifier', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const complaint = await makeComplaint(member.token);

    const managerAttempt = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'investigating' });
    expect(managerAttempt.status).toBe(404);
  });

  it('un manager peut faire évoluer une réclamation qu’il a créée ou qui lui est assignée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const complaint = await makeComplaint(manager.token);

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

  it('refuse de passer en "Résolue" ou "Clôturée" sans résolution renseignée', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    const resolvedAttempt = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved' });
    expect(resolvedAttempt.status).toBe(400);
    expect(resolvedAttempt.body.error).toBe(
      'Impossible de marquer cette réclamation comme résolue sans description de la résolution.'
    );

    const closedAttempt = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });
    expect(closedAttempt.status).toBe(400);
    expect(closedAttempt.body.error).toBe(
      'Impossible de marquer cette réclamation comme résolue sans description de la résolution.'
    );
  });

  it('refuse de clôturer sans avoir renseigné la satisfaction du client, même avec une résolution', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved', resolution: 'Produit remplacé.' });

    const res = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Impossible de clôturer une réclamation sans avoir renseigné la satisfaction du client.');
  });

  it('autorise la clôture même quand le client se dit insatisfait (customer_satisfied: false n’est pas bloquant)', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', resolution: 'Produit remplacé.', customer_satisfied: false });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.customer_satisfied).toBe(false);
  });

  it('autorise la clôture en un seul appel quand résolution et satisfaction client sont fournies ensemble', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', resolution: 'Produit remplacé.', customer_satisfied: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
    expect(res.body.customer_satisfied).toBe(true);
  });

  it('date la résolution automatiquement si l’utilisateur ne renseigne pas resolution_date', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);
    const today = new Date().toISOString().slice(0, 10);

    const res = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved', resolution: 'Produit remplacé.' });

    expect(res.status).toBe(200);
    expect(res.body.resolution_date).toBe(today);
  });

  it('ne réécrit pas une resolution_date déjà renseignée', async () => {
    tenant = await createTenant();
    const complaint = await makeComplaint(tenant.admin.token);

    await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved', resolution: 'Produit remplacé.', resolution_date: '2026-02-10' });

    const res = await request(app)
      .patch(`/api/complaints/${complaint.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed', customer_satisfied: true });

    expect(res.status).toBe(200);
    expect(res.body.resolution_date).toBe('2026-02-10');
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
