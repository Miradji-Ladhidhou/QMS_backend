import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { sendEmail } from '../services/email.js';

vi.mock('../services/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 'mock' })) }));

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};
beforeEach(() => sendEmail.mockClear());
afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const QUESTIONS = [{ id: 'q1', text: 'Q ?', options: [{ id: 'a', label: 'Bonne', is_correct: true }, { id: 'b', label: 'Mauvaise', is_correct: false }] }];
const GOOD = { q1: ['a'] };
const BAD = { q1: ['b'] };
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function setup(tenant) {
  const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Hygiène' })).body;
  await request(app).put(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token)).send({ pass_threshold: 100, questions: QUESTIONS }).expect(200);
  return training;
}
const newRecord = async (tenant, training, date) =>
  (await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: date })).body;

async function sendLink(tenant, training, record) {
  await request(app).post(`/api/trainings/${training.id}/quiz/invites`).set(auth(tenant.admin.token)).send({ items: [{ record_id: record.id }] }).expect(200);
  return sendEmail.mock.calls.at(-1)[2].match(/\/quiz\/([A-Za-z0-9_-]+)/)[1];
}
const pass = (tenant, token, answers) => request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers });

async function wordText(tenant, training, attemptId) {
  const res = await request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attemptId}/word`).set(auth(tenant.admin.token)).responseType('blob');
  expect(res.status).toBe(200);
  return (await mammoth.extractRawText({ buffer: Buffer.from(res.body) })).value;
}

describe('Trace du nombre d\'essais (échecs et réussites) pour une même session', () => {
  // Parcours : essai 1 échec → lien envoyé mais jamais utilisé (remplacé) → essai 2 échec → essai 3 réussite.
  async function threeEssais() {
    const tenant = await newTenant();
    const training = await setup(tenant);
    const record = await newRecord(tenant, training, '2026-05-04');

    const t1 = await sendLink(tenant, training, record);
    const r1 = await pass(tenant, t1, BAD);
    await sendLink(tenant, training, record); // lien jamais utilisé : remplacé par le suivant
    const t3 = await sendLink(tenant, training, record);
    const r2 = await pass(tenant, t3, BAD);
    const t4 = await sendLink(tenant, training, record);
    const r3 = await pass(tenant, t4, GOOD);
    const { data: attempts } = await admin.from('training_quiz_attempts').select('id, completed_at').eq('record_id', record.id).order('sent_at');
    return { tenant, training, record, results: [r1.body, r2.body, r3.body], attempts };
  }

  it('chaque passage reçoit son numéro d\'essai ; le lien non utilisé n\'est pas compté', async () => {
    const { results } = await threeEssais();
    expect(results.map((r) => r.attempt_number)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.passed)).toEqual([false, false, true]);
  });

  it('la réalisation garde une ligne de note par essai et le résultat du DERNIER essai', async () => {
    const { record } = await threeEssais();
    const { data } = await admin.from('training_records').select('evaluation_result, evaluation_notes').eq('id', record.id).single();
    expect(data.evaluation_result).toBe(true);
    const lines = data.evaluation_notes.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('essai n°1');
    expect(lines[0]).toContain('non réussi');
    expect(lines[1]).toContain('essai n°2');
    expect(lines[2]).toContain('essai n°3');
    expect(lines[2]).toMatch(/— réussi$/);
  });

  it('l\'API des passages fournit tout l\'historique de la formation (envois inclus) sans jeton ni contenu', async () => {
    const { tenant, training, record } = await threeEssais();
    const res = await request(app).get(`/api/trainings/${training.id}/quiz/attempts`).set(auth(tenant.admin.token));
    const mine = res.body.filter((a) => a.record_id === record.id);
    expect(mine).toHaveLength(4);
    expect(mine.filter((a) => a.completed_at)).toHaveLength(3);
    expect(mine.filter((a) => a.passed === true)).toHaveLength(1);
    expect(mine.filter((a) => a.passed === false)).toHaveLength(2);
    expect(JSON.stringify(res.body)).not.toMatch(/token|is_correct|signature/);
  });

  it('le Word du dernier essai affiche « n°3 sur 3 », le bilan et l\'historique complet (4 lignes dont le lien non utilisé)', async () => {
    const { tenant, training, attempts } = await threeEssais();
    const lastCompleted = attempts.filter((a) => a.completed_at).at(-1);
    const text = await wordText(tenant, training, lastCompleted.id);

    expect(text).toContain('n°3 sur 3');
    expect(text).toContain('3 essais : 1 réussite, 2 échecs');
    expect(text).toContain('Historique des essais');
    expect(text).toContain('Lien non utilisé (expiré ou remplacé)');
    expect((text.match(/Non réussi/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(text).toContain('◄ ce document');
  });

  it('le Word d\'un essai plus ancien reste cohérent : « n°1 sur 3 » et il repère SON propre passage', async () => {
    const { tenant, training, attempts } = await threeEssais();
    const first = attempts.find((a) => a.completed_at);
    const text = await wordText(tenant, training, first.id);
    expect(text).toContain('n°1 sur 3');
    expect(text).toContain('3 essais : 1 réussite, 2 échecs');
    expect(text.match(/◄ ce document/g)).toHaveLength(1);
  });

  it('deux sessions différentes pour la même personne : historiques séparés', async () => {
    const tenant = await newTenant();
    const training = await setup(tenant);
    const sessionA = await newRecord(tenant, training, '2026-05-04');
    const sessionB = await newRecord(tenant, training, '2026-09-10');

    const a1 = await sendLink(tenant, training, sessionA);
    await pass(tenant, a1, BAD);
    const b1 = await sendLink(tenant, training, sessionB);
    const resultB = await pass(tenant, b1, GOOD);
    // La réussite de la session B est SON premier essai : l'échec de la session A ne s'y ajoute pas.
    expect(resultB.body.attempt_number).toBe(1);

    const { data: attemptB } = await admin.from('training_quiz_attempts').select('id').eq('record_id', sessionB.id).single();
    const text = await wordText(tenant, training, attemptB.id);
    expect(text).toContain('n°1 sur 1');
    expect(text).toContain('1 essai : 1 réussite, 0 échec');
    expect(text).not.toContain('Non réussi');
  });

  it('un salarié avec un seul essai réussi : « n°1 sur 1 »', async () => {
    const tenant = await newTenant();
    const training = await setup(tenant);
    const record = await newRecord(tenant, training, '2026-05-04');
    const token = await sendLink(tenant, training, record);
    await pass(tenant, token, GOOD);
    const { data } = await admin.from('training_quiz_attempts').select('id').eq('record_id', record.id).single();
    const text = await wordText(tenant, training, data.id);
    expect(text).toContain('n°1 sur 1');
    expect(text).toContain('1 essai : 1 réussite, 0 échec');
  });

  it('une note saisie à la main est conservée devant les lignes d\'essais', async () => {
    const tenant = await newTenant();
    const training = await setup(tenant);
    const record = await newRecord(tenant, training, '2026-05-04');
    await admin.from('training_records').update({ evaluation_notes: 'Bonne participation orale.' }).eq('id', record.id);
    await pass(tenant, await sendLink(tenant, training, record), BAD);
    await pass(tenant, await sendLink(tenant, training, record), GOOD);
    const { data } = await admin.from('training_records').select('evaluation_notes').eq('id', record.id).single();
    const lines = data.evaluation_notes.split('\n');
    expect(lines[0]).toBe('Bonne participation orale.');
    expect(lines).toHaveLength(3);
  });
});
