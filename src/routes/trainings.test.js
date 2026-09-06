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

describe("PATCH /api/trainings/:id/records/:recordId — évaluation d'efficacité", () => {
  it('refuse un résultat (true ou false) sans commentaire de justification', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    const record = await request(app)
      .post(`/api/trainings/${training.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: tenant.admin.id });

    const resTrue = await request(app)
      .patch(`/api/trainings/${training.id}/records/${record.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ evaluation_result: true });
    expect(resTrue.status).toBe(400);
    expect(resTrue.body.error).toBe("Merci de justifier le résultat de l'évaluation par un commentaire.");

    const resFalse = await request(app)
      .patch(`/api/trainings/${training.id}/records/${record.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ evaluation_result: false });
    expect(resFalse.status).toBe(400);
    expect(resFalse.body.error).toBe("Merci de justifier le résultat de l'évaluation par un commentaire.");
  });

  it('autorise un résultat avec commentaire, dans la même requête ou après coup', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    const record = await request(app)
      .post(`/api/trainings/${training.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: tenant.admin.id });

    const res = await request(app)
      .patch(`/api/trainings/${training.id}/records/${record.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ evaluation_result: true, evaluation_notes: 'Quiz réussi à 90%.' });
    expect(res.status).toBe(200);
    expect(res.body.evaluation_result).toBe(true);

    // Renseigné après coup (déjà en base) : re-sélectionner le même résultat sans renvoyer les
    // notes doit rester accepté (relecture en base, voir routes/trainings.js).
    const resAgain = await request(app)
      .patch(`/api/trainings/${training.id}/records/${record.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ evaluation_result: true });
    expect(resAgain.status).toBe(200);
  });
});

describe('POST/PATCH /api/trainings — required_job_titles : normalisation et validation', () => {
  it('dédoublonne en ignorant la casse/espaces, en gardant la première graphie rencontrée', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token, {
      required_job_titles: ['Opérateur', ' opérateur ', 'OPÉRATEUR', 'Chef d’équipe'],
    });
    expect(training.required_job_titles).toEqual(['Opérateur', 'Chef d’équipe']);
  });

  it('refuse un tableau contenant une valeur non-chaîne ou une chaîne vide', async () => {
    tenant = await createTenant();
    const badType = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation test', required_job_titles: ['Opérateur', 42] });
    expect(badType.status).toBe(400);

    const emptyString = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation test', required_job_titles: ['   '] });
    expect(emptyString.status).toBe(400);

    const notArray = await request(app)
      .post('/api/trainings')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Formation test', required_job_titles: 'Opérateur' });
    expect(notArray.status).toBe(400);
  });

  it('PATCH /:id met à jour et normalise required_job_titles sur une formation existante', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    expect(training.required_job_titles).toEqual([]);

    const res = await request(app)
      .patch(`/api/trainings/${training.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ required_job_titles: ['Opérateur', 'opérateur'] });

    expect(res.status).toBe(200);
    expect(res.body.required_job_titles).toEqual(['Opérateur']);
  });
});

describe('GET /api/trainings/matrix — exigences de formation par poste (required_job_titles)', () => {
  it('sans exigence (tableau vide), tout le monde apparaît en "never_done" — comportement inchangé', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const training = await createTraining(tenant.admin.token);

    const matrix = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = matrix.body.find((r) => r.training.id === training.id);
    const entry = row.people.find((p) => p.person.id === manager.id);
    expect(entry.status).toBe('never_done');
  });

  it('avec une exigence, seul le poste concerné apparaît en "never_done" — les autres en "not_applicable"', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }, { role: 'manager' }] });
    const [operateur, administratif] = tenant.users;
    await request(app)
      .patch(`/api/users/${operateur.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ job_title: 'Opérateur' })
      .expect(200);
    await request(app)
      .patch(`/api/users/${administratif.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ job_title: 'Assistant administratif' })
      .expect(200);

    const training = await createTraining(tenant.admin.token, { required_job_titles: ['Opérateur'] });

    const matrix = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = matrix.body.find((r) => r.training.id === training.id);
    expect(row.training.required_job_titles).toEqual(['Opérateur']);
    expect(row.people.find((p) => p.person.id === operateur.id).status).toBe('never_done');
    expect(row.people.find((p) => p.person.id === administratif.id).status).toBe('not_applicable');
  });

  it('une réalisation existante reste affichée même si le poste ne correspond plus à l’exigence', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'manager' }] });
    const person = tenant.users[0];
    await request(app)
      .patch(`/api/users/${person.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ job_title: 'Assistant administratif' })
      .expect(200);

    const training = await createTraining(tenant.admin.token, { required_job_titles: ['Opérateur'] });
    await request(app)
      .post(`/api/trainings/${training.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ user_id: person.id })
      .expect(201);

    const matrix = await request(app).get('/api/trainings/matrix').set('Authorization', `Bearer ${tenant.admin.token}`);
    const row = matrix.body.find((r) => r.training.id === training.id);
    expect(row.people.find((p) => p.person.id === person.id).status).toBe('up_to_date');
  });
});
