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

// Couvre POST /api/workflows/:id/decide — jusqu'ici seule la soumission (submit-for-approval,
// voir documents.test.js) avait des tests ; la décision elle-même (le cœur du circuit
// d'approbation : approbation simple/multi-approbateurs, rejet, habilitation, double décision)
// n'était couverte par aucun test.
async function createDocument(token, number, extra = {}) {
  const req = request(app).post('/api/documents').set('Authorization', `Bearer ${token}`).field('number', number).field('title', `Titre ${number}`);
  for (const [key, value] of Object.entries(extra)) req.field(key, value);
  const res = await req;
  expect(res.status).toBe(201);
  return res.body;
}

async function submitForApproval(token, documentId, approverIds) {
  const res = await request(app)
    .post(`/api/documents/${documentId}/submit-for-approval`)
    .set('Authorization', `Bearer ${token}`)
    .send({ approver_ids: approverIds });
  expect(res.status).toBe(201);
  return res.body.workflow;
}

describe('POST /api/workflows/:id/decide', () => {
  it('un seul approbateur : "approved" fait passer le workflow et le document en approuvé, avec une signature', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-001');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.workflow_status).toBe('approved');
    expect(res.body.approval.decision).toBe('approved');
    expect(res.body.approval.signature_hash).toBeTruthy();

    const updatedDoc = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(updatedDoc.body.status).toBe('approved');
    expect(updatedDoc.body.approved_by).toBe(manager.id);
  });

  it('"rejected" sans commentaire est refusé (400)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-002');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('"rejected" avec commentaire repasse le document en brouillon, sans signature', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-003');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'rejected', comment: 'Manque la référence normative.' });

    expect(res.status).toBe(200);
    expect(res.body.workflow_status).toBe('rejected');
    expect(res.body.approval.signature_hash).toBeNull();

    const updatedDoc = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(updatedDoc.body.status).toBe('draft');
    expect(updatedDoc.body.approved_by).toBeNull();
  });

  it('multi-approbateurs : le workflow reste "pending" tant que tous n’ont pas décidé', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [managerA, managerB] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-004');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [managerA.id, managerB.id]);

    const first = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${managerA.token}`)
      .send({ decision: 'approved' });
    expect(first.status).toBe(200);
    // Pas encore final : la route renvoie le statut (stale) du workflow tel que lu en tête de
    // handler, donc toujours "pending" tant que finalStatus n'est pas calculé (voir workflows.js).
    expect(first.body.workflow_status).toBe('pending');

    const stillInReview = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(stillInReview.body.status).toBe('in_review');

    const second = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${managerB.token}`)
      .send({ decision: 'approved' });
    expect(second.status).toBe(200);
    expect(second.body.workflow_status).toBe('approved');

    const approvedDoc = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(approvedDoc.body.status).toBe('approved');
  });

  it('multi-approbateurs : un seul rejet suffit à rejeter le workflow, même si l’autre n’a pas encore décidé', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [managerA, managerB] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-005');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [managerA.id, managerB.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${managerA.token}`)
      .send({ decision: 'rejected', comment: 'Non conforme.' });
    expect(res.status).toBe(200);
    expect(res.body.workflow_status).toBe('rejected');

    const rejectedDoc = await request(app).get(`/api/documents/${doc.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(rejectedDoc.body.status).toBe('draft');
  });

  it("quelqu'un qui n'est pas dans les approbateurs requis reçoit 403, même un admin", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [manager, outsider] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-006');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
  });

  it('un workflow déjà finalisé refuse une seconde décision (409)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-007');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'approved' });

    const second = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'approved' });
    expect(second.status).toBe(409);
  });

  it('decision invalide (autre chose que approved/rejected) est refusée (400)', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-008');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'maybe' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/workflows/mine et GET /api/workflows/:id', () => {
  it('"mine" ne renvoie que les workflows encore en attente de MA décision', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-009');
    await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app).get('/api/workflows/mine').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].workflow.document.number).toBe('DOC-WF-009');

    const emptyForAdmin = await request(app).get('/api/workflows/mine').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(emptyForAdmin.body).toHaveLength(0);
  });

  it('"mine" se vide une fois la décision prise', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-010');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    await request(app)
      .post(`/api/workflows/${workflow.id}/decide`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ decision: 'approved' });

    const res = await request(app).get('/api/workflows/mine').set('Authorization', `Bearer ${manager.token}`);
    expect(res.body).toHaveLength(0);
  });

  it('GET /:id renvoie le détail avec l’état de chaque approbateur', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const doc = await createDocument(tenant.admin.token, 'DOC-WF-011');
    const workflow = await submitForApproval(tenant.admin.token, doc.id, [manager.id]);

    const res = await request(app).get(`/api/workflows/${workflow.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.document.number).toBe('DOC-WF-011');
    expect(res.body.approvals).toHaveLength(1);
    expect(res.body.approvals[0].decision).toBe('pending');
  });
});
