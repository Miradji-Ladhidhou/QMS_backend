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

async function makeReview(token, overrides = {}) {
  const res = await request(app)
    .post('/api/order-reviews')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: 'Commande #2026-118',
      customer_name: 'Client Test SARL',
      received_at: '2026-01-15',
      specified_requirements: 'Livraison de 500 unités X sous 4 semaines, conditionnement palette.',
      ...overrides,
    });
  return res;
}

describe('POST /api/order-reviews — création ouverte à tous les rôles', () => {
  it('201 pour un member, un manager ou un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeReview(member.token);
    expect(memberAttempt.status).toBe(201);
    expect(memberAttempt.body.status).toBe('pending');
    expect(memberAttempt.body.capability_confirmed).toBe(false);

    const managerAttempt = await makeReview(manager.token);
    expect(managerAttempt.status).toBe(201);

    const adminAttempt = await makeReview(tenant.admin.token);
    expect(adminAttempt.status).toBe(201);
  });

  it('rejette un titre, un client, une date ou des exigences manquants', async () => {
    tenant = await createTenant();

    const noTitle = await request(app)
      .post('/api/order-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Client Test', received_at: '2026-01-15', specified_requirements: 'X' });
    expect(noTitle.status).toBe(400);

    const noCustomer = await request(app)
      .post('/api/order-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Commande', received_at: '2026-01-15', specified_requirements: 'X' });
    expect(noCustomer.status).toBe(400);

    const noDate = await request(app)
      .post('/api/order-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Commande', customer_name: 'Client Test', specified_requirements: 'X' });
    expect(noDate.status).toBe(400);

    const noRequirements = await request(app)
      .post('/api/order-reviews')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Commande', customer_name: 'Client Test', received_at: '2026-01-15' });
    expect(noRequirements.status).toBe(400);
  });
});

describe('PATCH /api/order-reviews/:id — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un manager', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;
    const review = await makeReview(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ capability_confirmed: true });
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ capability_confirmed: true });
    expect(managerAttempt.status).toBe(200);
    expect(managerAttempt.body.capability_confirmed).toBe(true);
  });
});

describe('PATCH /api/order-reviews/:id — acceptation : capacité confirmée exigée', () => {
  it('refuse l’acceptation sans capability_confirmed', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted' });
    expect(res.status).toBe(400);
  });

  it('accepte une capability_confirmed déjà posée précédemment, sans avoir à la renvoyer', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ capability_confirmed: true });

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.reviewed_at).not.toBeNull();
  });

  it('ne pose reviewed_at qu’une seule fois', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token, {});

    const firstAccept = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', capability_confirmed: true });
    expect(firstAccept.status).toBe(200);
    const firstReviewedAt = firstAccept.body.reviewed_at;

    const secondPatch = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', reference: 'CMD-2026-118' });
    expect(secondPatch.status).toBe(200);
    expect(secondPatch.body.reviewed_at).toBe(firstReviewedAt);
  });

  it('rafraîchit reviewed_at sur un basculement direct rejected → accepted (sans repasser par pending)', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const rejected = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'rejected', decision_comment: 'Capacité insuffisante à cette date.' });
    expect(rejected.status).toBe(200);
    const rejectedAt = rejected.body.reviewed_at;

    // Petit délai pour garantir un horodatage distinct du précédent (résolution de la seconde).
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const accepted = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', capability_confirmed: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.reviewed_at).not.toBe(rejectedAt);
  });
});

describe('PATCH /api/order-reviews/:id — acceptation : écart non résolu bloque', () => {
  it('refuse l’acceptation si discrepancies est renseigné et discrepancies_resolved faux', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', capability_confirmed: true, discrepancies: 'Le devis initial prévoyait 400 unités, pas 500.' });
    expect(res.status).toBe(400);
  });

  it('accepte une fois discrepancies_resolved posé à true', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'accepted',
        capability_confirmed: true,
        discrepancies: 'Le devis initial prévoyait 400 unités, pas 500.',
        discrepancies_resolved: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
  });

  it('un écart vide n’exige jamais discrepancies_resolved pour être accepté', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', capability_confirmed: true });
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/order-reviews/:id — refus : commentaire de décision exigé', () => {
  it('refuse le rejet sans decision_comment', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'rejected' });
    expect(res.status).toBe(400);
  });

  it('accepte le rejet avec decision_comment', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);

    const res = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'rejected', decision_comment: 'Capacité de production insuffisante sur la période demandée.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.reviewed_at).not.toBeNull();
  });
});

describe('PATCH /api/order-reviews/:id — reviewed_by retombe sur le décideur', () => {
  it('pose reviewed_by = décideur si non fourni, respecte la valeur fournie sinon', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const review = await makeReview(tenant.admin.token);

    const accepted = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'accepted', capability_confirmed: true });
    expect(accepted.status).toBe(200);
    expect(accepted.body.reviewed_by).toBe(manager.id);

    const review2 = await makeReview(tenant.admin.token);
    const acceptedExplicit = await request(app)
      .patch(`/api/order-reviews/${review2.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'accepted', capability_confirmed: true, reviewed_by: tenant.admin.id });
    expect(acceptedExplicit.status).toBe(200);
    expect(acceptedExplicit.body.reviewed_by).toBe(tenant.admin.id);
  });

  it('retombe aussi sur le décideur si reviewed_by est explicitement envoyé à null', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const review = await makeReview(tenant.admin.token);

    const accepted = await request(app)
      .patch(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ status: 'accepted', capability_confirmed: true, reviewed_by: null });
    expect(accepted.status).toBe(200);
    expect(accepted.body.reviewed_by).toBe(manager.id);
  });
});

describe('PATCH /api/order-reviews/bulk-category — réservé admin/manager', () => {
  it('403 pour un member, 200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const review = await makeReview(tenant.admin.token);

    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'order_review', name: 'Grands comptes', is_restricted: true });
    expect(categoryRes.status).toBe(201);

    const memberAttempt = await request(app)
      .patch('/api/order-reviews/bulk-category')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [review.body.id], category_id: categoryRes.body.id });
    expect(memberAttempt.status).toBe(403);

    const adminAttempt = await request(app)
      .patch('/api/order-reviews/bulk-category')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [review.body.id], category_id: categoryRes.body.id });
    expect(adminAttempt.status).toBe(200);
    expect(adminAttempt.body.updated).toBe(1);
  });
});

describe('DELETE /api/order-reviews/:id et /bulk — réservé admin/manager', () => {
  it('403 pour un member, 204/200 pour un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const review = await makeReview(member.token);
    const review2 = await makeReview(member.token);

    const memberDelete = await request(app)
      .delete(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDelete.status).toBe(403);

    const adminDelete = await request(app)
      .delete(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminDelete.status).toBe(204);

    const memberBulk = await request(app)
      .delete('/api/order-reviews/bulk')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ ids: [review2.body.id] });
    expect(memberBulk.status).toBe(403);

    const adminBulk = await request(app)
      .delete('/api/order-reviews/bulk')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ ids: [review2.body.id] });
    expect(adminBulk.status).toBe(200);
    expect(adminBulk.body.deleted).toBe(1);
  });
});

describe('Catégorie restreinte — visibilité', () => {
  it("une revue d'une catégorie restreinte reste visible pour l'admin mais invisible pour un member sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const categoryRes = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'order_review', name: 'Confidentiel', is_restricted: true });
    expect(categoryRes.status).toBe(201);
    const review = await makeReview(tenant.admin.token, { category_id: categoryRes.body.id });

    const adminList = await request(app).get('/api/order-reviews').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(adminList.body.map((r) => r.id)).toContain(review.body.id);

    const memberList = await request(app).get('/api/order-reviews').set('Authorization', `Bearer ${member.token}`);
    expect(memberList.body.map((r) => r.id)).not.toContain(review.body.id);
    const memberDetail = await request(app)
      .get(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberDetail.status).toBe(404);
  });
});

describe('Catégories — une revue de commande respecte les mêmes règles que les autres modules', () => {
  it('le garde-fou de suppression de catégorie couvre order_review sans changement dans moduleCategories.js', async () => {
    tenant = await createTenant();

    const category = await request(app)
      .post('/api/module-categories')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ resource_type: 'order_review', name: 'Catégorie restreinte', is_restricted: true });
    expect(category.status).toBe(201);

    const review = await makeReview(tenant.admin.token, { category_id: category.body.id });
    expect(review.body.category_id).toBe(category.body.id);

    const blocked = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('1 revue de commande');

    await request(app).delete(`/api/order-reviews/${review.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);

    const ok = await request(app)
      .delete(`/api/module-categories/${category.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(ok.status).toBe(204);
  });
});

describe('Isolation multi-tenant', () => {
  it('un tenant ne voit pas les revues de commande d’un autre tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();
    const review = await makeReview(other.admin.token);

    const detail = await request(app)
      .get(`/api/order-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.status).toBe(404);

    await other.cleanup();
  });
});
