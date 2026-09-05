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

function isoDate(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

describe('POST /api/management-reviews — période et input_snapshot', () => {
  it('sans période : input_snapshot reste null ; avec période : calculé et renvoyé', async () => {
    tenant = await createTenant();

    const withoutPeriod = await makeReview(tenant.admin.token, { title: 'Sans période' });
    expect(withoutPeriod.status).toBe(201);
    expect(withoutPeriod.body.input_snapshot).toBeNull();

    const withPeriod = await makeReview(tenant.admin.token, {
      title: 'Avec période',
      period_start: isoDate(-30),
      period_end: isoDate(0),
    });
    expect(withPeriod.status).toBe(201);
    expect(withPeriod.body.input_snapshot).not.toBeNull();
    expect(withPeriod.body.input_snapshot.period).toEqual({ start: isoDate(-30), end: isoDate(0) });
  });

  it('400 si period_end est fournie sans period_start, ou antérieure à period_start', async () => {
    tenant = await createTenant();

    const missingStart = await makeReview(tenant.admin.token, { period_end: isoDate(0) });
    expect(missingStart.status).toBe(400);

    const reversed = await makeReview(tenant.admin.token, { period_start: isoDate(0), period_end: isoDate(-10) });
    expect(reversed.status).toBe(400);
  });
});

describe('POST /api/management-reviews/:id/refresh-snapshot', () => {
  it('403 pour un member, 400 sans période, 200 recalcule tant que la revue est en brouillon, 400 une fois clôturée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];

    const noPeriod = await makeReview(tenant.admin.token, { title: 'Sans période' });
    const noPeriodAttempt = await request(app)
      .post(`/api/management-reviews/${noPeriod.body.id}/refresh-snapshot`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(noPeriodAttempt.status).toBe(400);

    const review = await makeReview(tenant.admin.token, {
      title: 'Avec période',
      period_start: isoDate(-30),
      period_end: isoDate(0),
    });

    const memberAttempt = await request(app)
      .post(`/api/management-reviews/${review.body.id}/refresh-snapshot`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(memberAttempt.status).toBe(403);

    const refreshed = await request(app)
      .post(`/api/management-reviews/${review.body.id}/refresh-snapshot`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.input_snapshot).not.toBeNull();

    await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed' });

    const afterCompletion = await request(app)
      .post(`/api/management-reviews/${review.body.id}/refresh-snapshot`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(afterCompletion.status).toBe(400);
  });

  it('modifier la période après clôture est refusé (input_snapshot déjà figé)', async () => {
    tenant = await createTenant();
    const review = await makeReview(tenant.admin.token, {
      period_start: isoDate(-30),
      period_end: isoDate(0),
    });

    await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'completed' });

    const attempt = await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_end: isoDate(10) });
    expect(attempt.status).toBe(400);

    // Ré-envoyer les MÊMES valeurs de période (ce que fait EditReviewModal à chaque
    // soumission, même pour éditer un tout autre champ) ne doit pas être bloqué : seul un
    // changement réel de période est refusé après clôture.
    const sameValues = await request(app)
      .patch(`/api/management-reviews/${review.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_start: isoDate(-30), period_end: isoDate(0), conclusions: 'Édition légitime après clôture' });
    expect(sameValues.status).toBe(200);
    expect(sameValues.body.conclusions).toBe('Édition légitime après clôture');
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
