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

async function createRestrictedCategory(token, name = 'Formation restreinte') {
  const res = await request(app)
    .post('/api/module-categories')
    .set('Authorization', `Bearer ${token}`)
    .send({ resource_type: 'training', name, is_restricted: true });
  expect(res.status).toBe(201);
  return res.body;
}

async function createTraining(token, extra = {}) {
  const res = await request(app)
    .post('/api/trainings')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'Formation test', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

// Enregistre une réalisation puis force next_due_date à une échéance proche (dans la fenêtre
// des 60 jours) directement en base : plus fiable en test qu'un frequency_months + completed_at
// calculés pour retomber pile dans la fenêtre selon la date du jour au moment du run.
async function makeDueSoonRecord(token, trainingId, userId) {
  const res = await request(app)
    .post(`/api/trainings/${trainingId}/records`)
    .set('Authorization', `Bearer ${token}`)
    .send({ user_id: userId, completed_at: new Date().toISOString().slice(0, 10) });
  expect(res.status).toBe(201);

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 10);
  await admin.from('training_records').update({ next_due_date: dueDate.toISOString().slice(0, 10) }).eq('id', res.body.id);
}

describe('GET /api/trainings/matrix et /upcoming-renewals — catégorie restreinte', () => {
  it('une formation restreinte est absente de la matrice, puis apparaît une fois la permission accordée', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createRestrictedCategory(tenant.admin.token);
    const training = await createTraining(tenant.admin.token, { category_id: category.id });
    await makeDueSoonRecord(tenant.admin.token, training.id, manager.id);

    const before = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(200);
    expect(before.body.some((row) => row.training.id === training.id)).toBe(false);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${manager.token}`);
    expect(after.body.some((row) => row.training.id === training.id)).toBe(true);
  });

  it("une formation restreinte n'apparaît pas dans les renouvellements à venir sans permission", async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];

    const category = await createRestrictedCategory(tenant.admin.token, 'Autre formation restreinte');
    const training = await createTraining(tenant.admin.token, { category_id: category.id });
    await makeDueSoonRecord(tenant.admin.token, training.id, manager.id);

    const before = await request(app).get('/api/trainings/upcoming-renewals').set('Authorization', `Bearer ${manager.token}`);
    expect(before.status).toBe(200);
    expect(before.body.some((entry) => entry.training?.id === training.id)).toBe(false);

    await request(app)
      .post(`/api/module-categories/${category.id}/permissions`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ subject_type: 'user', subject_id: manager.id, can_view: true })
      .expect(201);

    const after = await request(app).get('/api/trainings/upcoming-renewals').set('Authorization', `Bearer ${manager.token}`);
    expect(after.body.some((entry) => entry.training?.id === training.id)).toBe(true);
  });
});
