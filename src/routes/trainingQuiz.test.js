import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { generateQuizToken, hashQuizToken } from '../services/trainingQuiz.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

const QUESTIONS = [
  {
    id: 'q1',
    text: 'Quelle température maximale pour la chambre froide ?',
    options: [
      { id: 'q1a', label: '4 °C', is_correct: true },
      { id: 'q1b', label: '10 °C', is_correct: false },
    ],
  },
  {
    id: 'q2',
    text: 'Quels EPI sont obligatoires ?',
    options: [
      { id: 'q2a', label: 'Charlotte', is_correct: true },
      { id: 'q2b', label: 'Gants', is_correct: true },
      { id: 'q2c', label: 'Bijoux', is_correct: false },
    ],
  },
];

// PNG 1×1 valide : la signature manuscrite est obligatoire pour valider un QCM.
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createTraining(token, extra = {}) {
  const res = await request(app).post('/api/trainings').set(auth(token)).send({ title: 'Hygiène alimentaire', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}

async function saveQuiz(token, trainingId, questions = QUESTIONS, passThreshold = 50) {
  return request(app).put(`/api/trainings/${trainingId}/quiz`).set(auth(token)).send({ pass_threshold: passThreshold, questions });
}

async function createRecord(token, trainingId, person) {
  const res = await request(app)
    .post(`/api/trainings/${trainingId}/records`)
    .set(auth(token))
    .send({ ...person, completed_at: '2026-05-04' });
  expect(res.status).toBe(201);
  return res.body;
}

// Le jeton n'existe que dans l'email (jamais renvoyé par l'API) : pour tester la page publique on
// insère directement un passage avec un jeton connu, exactement comme le fait POST /quiz/invites.
async function seedAttempt({ trainingId, recordId, email = 'marie@example.com', questions = QUESTIONS, passThreshold = 50, expiresInMs = 48 * 3600 * 1000 }) {
  const token = generateQuizToken();
  const { data, error } = await admin
    .from('training_quiz_attempts')
    .insert({
      tenant_id: tenant.tenantId,
      training_id: trainingId,
      record_id: recordId,
      token_hash: hashQuizToken(token),
      email,
      person_name: 'Marie Dupont',
      quiz_snapshot: questions,
      pass_threshold: passThreshold,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    })
    .select('id')
    .single();
  expect(error).toBeNull();
  return { token, attemptId: data.id };
}

describe('QCM de formation — édition (admin/manager)', () => {
  it('PUT /:id/quiz crée puis remplace le QCM ; GET le relit avec les bonnes réponses', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);

    expect((await request(app).get(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token))).body).toBeNull();

    const created = await saveQuiz(tenant.admin.token, training.id);
    expect(created.status).toBe(200);
    expect(created.body.questions).toHaveLength(2);
    expect(created.body.pass_threshold).toBe(50);

    const replaced = await saveQuiz(tenant.admin.token, training.id, [QUESTIONS[0]], 80);
    expect(replaced.status).toBe(200);
    const read = await request(app).get(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token));
    expect(read.body.questions).toHaveLength(1);
    expect(read.body.pass_threshold).toBe(80);
    expect(read.body.questions[0].options[0].is_correct).toBe(true);
  });

  it('400 : question sans bonne réponse, une seule réponse proposée, seuil hors bornes, QCM vide', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);

    const noCorrect = await saveQuiz(tenant.admin.token, training.id, [
      { text: 'Q ?', options: [{ label: 'A', is_correct: false }, { label: 'B', is_correct: false }] },
    ]);
    expect(noCorrect.status).toBe(400);
    expect(noCorrect.body.error).toMatch(/bonne réponse/);

    const oneOption = await saveQuiz(tenant.admin.token, training.id, [{ text: 'Q ?', options: [{ label: 'A', is_correct: true }] }]);
    expect(oneOption.status).toBe(400);

    expect((await saveQuiz(tenant.admin.token, training.id, QUESTIONS, 0)).status).toBe(400);
    expect((await saveQuiz(tenant.admin.token, training.id, QUESTIONS, 101)).status).toBe(400);
    expect((await saveQuiz(tenant.admin.token, training.id, [])).status).toBe(400);
  });

  it('un simple membre ne peut ni lire ni modifier le QCM, et GET /trainings ne divulgue pas les bonnes réponses', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const training = await createTraining(tenant.admin.token, { summary: 'Résumé de la formation.' });
    await saveQuiz(tenant.admin.token, training.id);

    expect((await request(app).get(`/api/trainings/${training.id}/quiz`).set(auth(member.token))).status).toBe(403);
    expect((await saveQuiz(member.token, training.id)).status).toBe(403);

    const list = await request(app).get('/api/trainings').set(auth(member.token));
    expect(list.status).toBe(200);
    const found = list.body.find((t) => t.id === training.id);
    expect(found.summary).toBe('Résumé de la formation.');
    expect(found.quiz).toEqual({ question_count: 2, pass_threshold: 50 });
    expect(JSON.stringify(list.body)).not.toContain('is_correct');
  });

  it('le résumé se crée et se modifie via POST/PATCH /trainings', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token, { summary: 'Premier résumé.' });
    expect(training.summary).toBe('Premier résumé.');
    const patched = await request(app).patch(`/api/trainings/${training.id}`).set(auth(tenant.admin.token)).send({ summary: 'Résumé mis à jour.' });
    expect(patched.body.summary).toBe('Résumé mis à jour.');
  });
});

describe('QCM de formation — envoi des liens', () => {
  it('400 tant que la formation n\'a pas de QCM', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    const record = await createRecord(tenant.admin.token, training.id, { user_id: tenant.admin.id });
    const res = await request(app)
      .post(`/api/trainings/${training.id}/quiz/invites`)
      .set(auth(tenant.admin.token))
      .send({ items: [{ record_id: record.id }] });
    expect(res.status).toBe(400);
  });

  it('envoie à un compte (email du compte), à un salarié avec email saisi (mémorisé), et signale un salarié sans email', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    await saveQuiz(tenant.admin.token, training.id);

    const withEmail = await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Paul Sans Compte' });
    const withoutEmail = await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Jeanne Sans Email' });
    expect(withEmail.status).toBe(201);

    const recordAccount = await createRecord(tenant.admin.token, training.id, { user_id: tenant.admin.id });
    const recordPaul = await createRecord(tenant.admin.token, training.id, { employee_id: withEmail.body.id });
    const recordJeanne = await createRecord(tenant.admin.token, training.id, { employee_id: withoutEmail.body.id });

    const res = await request(app)
      .post(`/api/trainings/${training.id}/quiz/invites`)
      .set(auth(tenant.admin.token))
      .send({ items: [{ record_id: recordAccount.id }, { record_id: recordPaul.id, email: 'Paul@Example.com' }, { record_id: recordJeanne.id }] });

    expect(res.status).toBe(200);
    const byRecord = Object.fromEntries(res.body.results.map((r) => [r.record_id, r]));
    expect(byRecord[recordAccount.id]).toMatchObject({ status: 'sent', email: tenant.admin.email.toLowerCase() });
    expect(byRecord[recordPaul.id]).toMatchObject({ status: 'sent', email: 'paul@example.com' });
    expect(byRecord[recordJeanne.id].status).toBe('no_email');

    // L'email saisi est mémorisé sur la fiche du salarié.
    const { data: employee } = await admin.from('employees').select('email').eq('id', withEmail.body.id).single();
    expect(employee.email).toBe('Paul@Example.com');

    const attempts = await request(app).get(`/api/trainings/${training.id}/quiz/attempts`).set(auth(tenant.admin.token));
    expect(attempts.body).toHaveLength(2);
    expect(attempts.body.every((a) => a.completed_at === null)).toBe(true);
    // Jamais de jeton ni de contenu de QCM dans la liste.
    expect(JSON.stringify(attempts.body)).not.toMatch(/token|is_correct/);
  });

  it('renvoyer un lien invalide le précédent lien en attente de la même réalisation', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    await saveQuiz(tenant.admin.token, training.id);
    const record = await createRecord(tenant.admin.token, training.id, { user_id: tenant.admin.id });

    const send = () =>
      request(app).post(`/api/trainings/${training.id}/quiz/invites`).set(auth(tenant.admin.token)).send({ items: [{ record_id: record.id }] });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    const attempts = await request(app).get(`/api/trainings/${training.id}/quiz/attempts`).set(auth(tenant.admin.token));
    expect(attempts.body).toHaveLength(2);
    const active = attempts.body.filter((a) => new Date(a.expires_at) > new Date());
    expect(active).toHaveLength(1);
  });
});

describe('QCM de formation — page publique', () => {
  async function setup() {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token, { summary: 'Toujours respecter la chaîne du froid.' });
    await saveQuiz(tenant.admin.token, training.id);
    const record = await createRecord(tenant.admin.token, training.id, { user_id: tenant.admin.id });
    return { training, record };
  }

  it('GET /:token : état du lien sans rien révéler du contenu ; 404 pour un jeton inconnu', async () => {
    const { training, record } = await setup();
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id });

    const res = await request(app).get(`/api/public/quiz/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('valid');
    expect(res.body.training_title).toBe('Hygiène alimentaire');
    expect(JSON.stringify(res.body)).not.toMatch(/question|summary|Toujours/);

    expect((await request(app).get(`/api/public/quiz/${generateQuizToken()}`)).status).toBe(404);
    expect((await request(app).get('/api/public/quiz/court')).status).toBe(404);
  });

  it('/start : refuse un email erroné puis verrouille le lien après 5 essais', async () => {
    const { training, record } = await setup();
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id });

    const wrong = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: 'autre@example.com' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatch(/incorrecte/);

    for (let i = 0; i < 4; i += 1) {
      await request(app).post(`/api/public/quiz/${token}/start`).send({ email: 'autre@example.com' });
    }
    // Même le bon email est refusé une fois le lien verrouillé.
    const locked = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: 'marie@example.com' });
    expect(locked.status).toBe(403);
    expect(locked.body.state).toBe('locked');
  });

  it('/start avec le bon email (casse/espaces ignorés) : résumé + questions SANS bonnes réponses', async () => {
    const { training, record } = await setup();
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id });

    const res = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: '  MARIE@example.com ' });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('Toujours respecter la chaîne du froid.');
    expect(res.body.questions).toHaveLength(2);
    expect(res.body.questions[0].multiple).toBe(false);
    expect(res.body.questions[1].multiple).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('is_correct');
  });

  it('/submit : corrige, fige le passage et met à jour la réalisation (réussi) ; un second envoi est refusé', async () => {
    const { training, record } = await setup();
    const { token, attemptId } = await seedAttempt({ trainingId: training.id, recordId: record.id, passThreshold: 50 });

    const res = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({ email: 'marie@example.com', signature: SIGNATURE, answers: { q1: ['q1a'], q2: ['q2a'] } });
    expect(res.status).toBe(200);
    // q1 juste ; q2 incomplète (il fallait Charlotte ET Gants) → fausse : pas de point partiel.
    expect(res.body).toMatchObject({ correct_count: 1, total_count: 2, score_percent: 50, passed: true });

    const { data: saved } = await admin.from('training_quiz_attempts').select('*').eq('id', attemptId).single();
    expect(saved.completed_at).not.toBeNull();
    expect(saved.answers.find((a) => a.question_id === 'q2').is_correct).toBe(false);

    const { data: updated } = await admin.from('training_records').select('evaluation_result, evaluation_notes').eq('id', record.id).single();
    expect(updated.evaluation_result).toBe(true);
    expect(updated.evaluation_notes).toContain('QCM en ligne — essai n°1 : 1/2 (50 %)');

    const again = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({ email: 'marie@example.com', signature: SIGNATURE, answers: { q1: ['q1a'], q2: ['q2a', 'q2b'] } });
    expect(again.status).toBe(409);
    expect((await request(app).post(`/api/public/quiz/${token}/start`).send({ email: 'marie@example.com' })).status).toBe(409);
  });

  it('/submit sous le seuil : réalisation marquée non réussie, note manuelle conservée', async () => {
    const { training, record } = await setup();
    await admin.from('training_records').update({ evaluation_notes: 'Bonne participation orale.' }).eq('id', record.id);
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id, passThreshold: 80 });

    const res = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({ email: 'marie@example.com', signature: SIGNATURE, answers: { q1: ['q1b'], q2: ['q2c'] } });
    expect(res.body).toMatchObject({ correct_count: 0, passed: false, pass_threshold: 80 });

    const { data: updated } = await admin.from('training_records').select('evaluation_result, evaluation_notes').eq('id', record.id).single();
    expect(updated.evaluation_result).toBe(false);
    expect(updated.evaluation_notes).toContain('Bonne participation orale.');
    expect(updated.evaluation_notes).toContain('non réussi');
  });

  it('lien expiré : 410 sur /start et /submit', async () => {
    const { training, record } = await setup();
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id, expiresInMs: -1000 });

    expect((await request(app).get(`/api/public/quiz/${token}`)).body.state).toBe('expired');
    expect((await request(app).post(`/api/public/quiz/${token}/start`).send({ email: 'marie@example.com' })).status).toBe(410);
    expect((await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: 'marie@example.com', signature: SIGNATURE, answers: {} })).status).toBe(410);
  });

  it('le passage est corrigé sur le QCM figé à l\'envoi, pas sur le QCM modifié depuis', async () => {
    const { training, record } = await setup();
    const { token } = await seedAttempt({ trainingId: training.id, recordId: record.id });

    // Le QCM est remanié après l'envoi du lien : q1 n'a plus la même bonne réponse.
    await saveQuiz(tenant.admin.token, training.id, [
      { id: 'q1', text: 'Nouvelle version', options: [{ id: 'q1a', label: 'X', is_correct: false }, { id: 'q1b', label: 'Y', is_correct: true }] },
    ]);

    const res = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({ email: 'marie@example.com', signature: SIGNATURE, answers: { q1: ['q1a'], q2: ['q2a', 'q2b'] } });
    expect(res.body).toMatchObject({ correct_count: 2, total_count: 2, score_percent: 100 });
  });
});

describe('QCM de formation — export Word d\'audit', () => {
  it('409 avant le passage, puis un .docx avec questions, réponses, bonnes réponses et taux de réussite', async () => {
    tenant = await createTenant();
    const training = await createTraining(tenant.admin.token);
    await saveQuiz(tenant.admin.token, training.id);
    const record = await createRecord(tenant.admin.token, training.id, { user_id: tenant.admin.id });
    const { token, attemptId } = await seedAttempt({ trainingId: training.id, recordId: record.id });
    const url = `/api/trainings/${training.id}/quiz/attempts/${attemptId}/word`;

    expect((await request(app).get(url).set(auth(tenant.admin.token))).status).toBe(409);

    await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: 'marie@example.com', signature: SIGNATURE, answers: { q1: ['q1a'], q2: ['q2a'] } });

    const res = await request(app).get(url).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    expect(value).toContain('Quelle température maximale pour la chambre froide ?');
    expect(value).toContain('Charlotte');
    expect(value).toContain('1 / 2 bonnes réponses — 50 %');
    expect(value).toContain('Marie Dupont');
    expect(value).toContain('Incorrecte');

    // Sans authentification : refusé.
    expect((await request(app).get(url)).status).toBe(401);
  });
});
