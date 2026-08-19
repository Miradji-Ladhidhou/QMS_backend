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
    .post('/api/management-reviews')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Revue de direction S1 2026', review_date: '2026-08-01', ...overrides });
  return res;
}

describe('POST /api/management-reviews — création réservée à admin/manager', () => {
  it('403 pour un member, 201 pour un manager, statut brouillon par défaut', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const [member, manager] = tenant.users;

    const memberAttempt = await makeReview(member.token);
    expect(memberAttempt.status).toBe(403);

    const managerAttempt = await makeReview(manager.token);
    expect(managerAttempt.status).toBe(201);
    expect(managerAttempt.body.status).toBe('draft');
    expect(managerAttempt.body.snapshot).toBeNull();
  });
});

describe('GET /api/management-reviews — visible à tous les rôles', () => {
  it('un member voit les revues créées par un admin', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    await makeReview(tenant.admin.token, { title: 'Revue visible par tous' });

    const res = await request(app).get('/api/management-reviews').set('Authorization', `Bearer ${member.token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((review) => review.title === 'Revue visible par tous')).toBe(true);
  });
});

describe('PATCH /api/management-reviews/:id — clôture et snapshot', () => {
  it('403 pour un member ; passer en "completed" capture un snapshot du SMQ, une seule fois', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const review = await makeReview(tenant.admin.token);

    const memberAttempt = await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ conclusions: 'Tentative non autorisée' });
    expect(memberAttempt.status).toBe(403);

    // Un peu de matière réelle avant clôture pour vérifier que le snapshot reflète l'état du SMQ.
    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA avant clôture de revue' });

    const completed = await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed', conclusions: 'SMQ conforme, actions décidées.' });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('completed');
    expect(completed.body.snapshot).not.toBeNull();
    expect(completed.body.snapshot.capas.open).toBe(1);
    const firstSnapshotTime = completed.body.snapshot.generated_at;

    // Nouvelle CAPA après clôture : un second passage ne doit pas recalculer le snapshot déjà posé.
    await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA après clôture, ne doit pas apparaître dans le snapshot déjà figé' });

    const rePatched = await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed' });
    expect(rePatched.body.snapshot.generated_at).toBe(firstSnapshotTime);
    expect(rePatched.body.snapshot.capas.open).toBe(1);
  });
});

describe('Actions de revue — CRUD réservé à admin/manager, création de CAPA liée', () => {
  it('ajoute une action, la lie à une CAPA créée à la volée, et la retrouve dans le détail de la revue', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const review = await makeReview(tenant.admin.token);

    const memberActionAttempt = await request(app)
      .post(`/api/management-reviews/${review.body.id}/actions`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ description: 'Action ajoutée par un member' });
    expect(memberActionAttempt.status).toBe(403);

    const action = await request(app)
      .post(`/api/management-reviews/${review.body.id}/actions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ description: 'Renforcer la formation des nouveaux arrivants' });
    expect(action.status).toBe(201);
    expect(action.body.linked_capa).toBeNull();

    const capa = await request(app)
      .post(`/api/management-reviews/${review.body.id}/actions/${action.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Mettre en place un parcours d’intégration' });
    expect(capa.status).toBe(201);
    expect(capa.body.management_review_action_id).toBe(action.body.id);
    expect(capa.body.origin).toContain('Revue de direction');

    const detail = await request(app)
      .get(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(detail.body.actions).toHaveLength(1);
    expect(detail.body.actions[0].linked_capa.id).toBe(capa.body.id);
  });

  it('supprimer une revue supprime ses actions mais laisse la CAPA déjà créée survivre', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token);
    const action = await request(app)
      .post(`/api/management-reviews/${review.body.id}/actions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ description: 'Action à supprimer avec la revue' });
    const capa = await request(app)
      .post(`/api/management-reviews/${review.body.id}/actions/${action.body.id}/create-capa`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA qui doit survivre' });

    const del = await request(app)
      .delete(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(del.status).toBe(204);

    const capaAfter = await request(app).get(`/api/capas/${capa.body.id}`).set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(capaAfter.status).toBe(200);
    expect(capaAfter.body.management_review_action_id).toBeNull();
  });
});
