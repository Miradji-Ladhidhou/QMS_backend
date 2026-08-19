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

async function makeSupplier(token, overrides = {}) {
  const res = await request(app).post('/api/suppliers').set('Authorization', `Bearer ${token}`).send({ name: 'Fournisseur Test SARL', ...overrides });
  return res;
}

describe('POST /api/suppliers — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager, statut actif par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeSupplier(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeSupplier(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.status).toBe('active');
    expect(managerAttempt.body.criticality).toBe('medium');
  });
});

describe('GET /api/suppliers — visible à tous les rôles', () => {
  it('un member voit les fournisseurs créés par un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    await makeSupplier(tenant.admin.token, { name: 'Fournisseur visible par tous' });

    const res = await request(app).get('/api/suppliers').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((s) => s.name === 'Fournisseur visible par tous')).toBe(true);
  });
});

describe('Évaluations fournisseur — score calculé par la base, CRUD réservé à admin/manager', () => {
  it('403 pour un member ; un manager peut évaluer, overall_score = moyenne des 4 notes', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const supplier = await makeSupplier(tenant.admin.token);

    const memberAttempt = await request(app)
      .post(`/api/suppliers/${supplier.body.id}/evaluations`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ evaluation_date: '2026-08-01', quality_score: 4, delivery_score: 3, price_score: 5, responsiveness_score: 4 });
    expect(memberAttempt.status).toBe(403);

    const evaluation = await request(app)
      .post(`/api/suppliers/${supplier.body.id}/evaluations`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ evaluation_date: '2026-08-01', quality_score: 4, delivery_score: 3, price_score: 5, responsiveness_score: 4 });
    expect(evaluation.status).toBe(201);
    expect(Number(evaluation.body.overall_score)).toBe(4);
    expect(evaluation.body.decision).toBe('maintained');
    expect(evaluation.body.evaluator.id).toBe(manager.id);

    const detail = await request(app).get(`/api/suppliers/${supplier.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.evaluations).toHaveLength(1);
  });
});

describe('POST /api/suppliers/:supplierId/evaluations/:id/create-capa — lien bidirectionnel', () => {
  it('crée une CAPA liée, visible dans les deux sens, et la CAPA survit à la suppression du fournisseur', async () => {
    tenant = await createTenant();
    const supplier = await makeSupplier(tenant.admin.token);
    const evaluation = await request(app)
      .post(`/api/suppliers/${supplier.body.id}/evaluations`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        evaluation_date: '2026-08-01',
        quality_score: 1,
        delivery_score: 2,
        price_score: 2,
        responsiveness_score: 1,
        decision: 'to_replace',
      });

    const capa = await request(app)
      .post(`/api/suppliers/${supplier.body.id}/evaluations/${evaluation.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Rechercher un fournisseur alternatif' });
    expect(capa.status).toBe(201);
    expect(capa.body.supplier_evaluation_id).toBe(evaluation.body.id);
    expect(capa.body.origin).toContain('Évaluation fournisseur');

    const detail = await request(app).get(`/api/suppliers/${supplier.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.evaluations[0].linked_capa.id).toBe(capa.body.id);

    // Supprimer le fournisseur supprime l'évaluation en cascade, mais pas la CAPA déjà créée.
    const del = await request(app).delete(`/api/suppliers/${supplier.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.supplier_evaluation_id).toBeNull();
  });
});
