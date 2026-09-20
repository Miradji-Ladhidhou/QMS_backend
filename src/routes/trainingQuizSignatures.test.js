import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import JSZip from 'jszip';
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

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const EMPLOYEE_SIG = `data:image/png;base64,${PNG_B64}`;
// Autre PNG valide (2×1) pour distinguer signature salarié / formateur / ancienne / nouvelle.
const TRAINER_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8DwnwEIGBgAF/8C/7MDdgQAAAAASUVORK5CYII=';
const NEW_TRAINER_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAAAeTfMqAAAAE0lEQVR4nGNkYPj/n4EIwEiMIgCd9AQCmUqMHQAAAABJRU5ErkJggg==';

const QUESTIONS = [
  { id: 'q1', text: 'Température max ?', options: [{ id: 'a', label: '4 °C', is_correct: true }, { id: 'b', label: '10 °C', is_correct: false }] },
];
const GOOD = { q1: ['a'] };
const BAD = { q1: ['b'] };
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function setup(tenant, trainingExtra = {}) {
  const training = (
    await request(app)
      .post('/api/trainings')
      .set(auth(tenant.admin.token))
      .send({ title: 'Hygiène', instructor: 'Claire Formatrice', description: 'Chaîne du froid\nLavage des mains', ...trainingExtra })
  ).body;
  await request(app).put(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token)).send({ pass_threshold: 100, questions: QUESTIONS }).expect(200);
  const record = (await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: '2026-05-04' })).body;
  return { training, record };
}

async function sendLink(tenant, training, record) {
  await request(app).post(`/api/trainings/${training.id}/quiz/invites`).set(auth(tenant.admin.token)).send({ items: [{ record_id: record.id }] }).expect(200);
  return sendEmail.mock.calls.at(-1)[2].match(/\/quiz\/([A-Za-z0-9_-]+)/)[1];
}

const submit = (token, tenant, body) => request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, ...body });
const putSignature = (tenant, training, image, token = tenant.admin.token) =>
  request(app).put(`/api/trainings/${training.id}/instructor-signature`).set(auth(token)).send({ image });

async function wordOf(tenant, training, record) {
  const { data: attempt } = await admin.from('training_quiz_attempts').select('id').eq('record_id', record.id).order('sent_at', { ascending: false }).limit(1).single();
  const res = await request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attempt.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
  expect(res.status).toBe(200);
  const buffer = Buffer.from(res.body);
  const zip = await JSZip.loadAsync(buffer);
  // Sans l'entrée de dossier « word/media/ » elle-même : seulement les images embarquées.
  const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !name.endsWith('/'));
  const { value: text } = await mammoth.extractRawText({ buffer });
  return { text, media };
}

describe('Signature du salarié (obligatoire à la validation)', () => {
  it('sans signature : 400 et le passage n\'est PAS consommé (on peut signer et revalider)', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);

    const missing = await submit(token, tenant, { answers: GOOD });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Signez/);
    const { data: untouched } = await admin.from('training_quiz_attempts').select('completed_at, employee_signature').eq('record_id', record.id).single();
    expect(untouched.completed_at).toBeNull();
    expect(untouched.employee_signature).toBeNull();
    expect((await admin.from('training_records').select('evaluation_result').eq('id', record.id).single()).data.evaluation_result).toBeNull();

    const ok = await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });
    expect(ok.status).toBe(200);
  });

  it('signature invalide (mauvais type, HTML, texte, énorme, non-PNG déguisé) : 400, passage intact', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    const huge = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400 * 1024)]).toString('base64')}`;
    const disguised = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;

    for (const signature of ['texte', 42, {}, 'data:image/jpeg;base64,AAAA', 'data:text/html;base64,PHNjcmlwdD4=', disguised, huge, 'http://exemple.fr/x.png']) {
      const res = await submit(token, tenant, { answers: GOOD, signature });
      expect(res.status).toBe(400);
    }
    const { data } = await admin.from('training_quiz_attempts').select('completed_at').eq('record_id', record.id).single();
    expect(data.completed_at).toBeNull();
  });

  it('la signature du salarié est conservée sur le passage', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: BAD, signature: EMPLOYEE_SIG });
    const { data } = await admin.from('training_quiz_attempts').select('employee_signature, instructor_signature, passed').eq('record_id', record.id).single();
    expect(data.employee_signature).toBe(EMPLOYEE_SIG);
    // Échec : la signature du formateur n'est jamais copiée.
    expect(data.passed).toBe(false);
    expect(data.instructor_signature).toBeNull();
  });
});

describe('Signature du formateur (enregistrée sur la formation)', () => {
  it('PUT/GET/DELETE : enregistre, relit, supprime ; la liste n\'expose que le booléen', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const { training } = await setup(tenant);

    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.admin.token))).body).toBeNull();
    expect((await putSignature(tenant, training, TRAINER_SIG)).status).toBe(200);
    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.admin.token))).body.image).toBe(TRAINER_SIG);

    // Un membre voit qu'une signature existe, jamais l'image elle-même.
    const asMember = await request(app).get('/api/trainings').set(auth(tenant.users[0].token));
    expect(asMember.body.find((t) => t.id === training.id).has_instructor_signature).toBe(true);
    expect(JSON.stringify(asMember.body)).not.toContain(TRAINER_SIG);

    // Remplacement puis suppression.
    expect((await putSignature(tenant, training, NEW_TRAINER_SIG)).status).toBe(200);
    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.admin.token))).body.image).toBe(NEW_TRAINER_SIG);
    expect((await request(app).delete(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.admin.token))).status).toBe(200);
    const list = await request(app).get('/api/trainings').set(auth(tenant.admin.token));
    expect(list.body.find((t) => t.id === training.id).has_instructor_signature).toBe(false);
  });

  it('image invalide → 400 ; un membre → 403 ; une autre entreprise → 404', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const intruder = await newTenant();
    const { training } = await setup(tenant);

    for (const image of [undefined, 'texte', 'data:image/jpeg;base64,AAAA', `data:image/png;base64,${Buffer.from('pas png').toString('base64')}`]) {
      expect((await putSignature(tenant, training, image)).status).toBe(400);
    }
    expect((await putSignature(tenant, training, TRAINER_SIG, tenant.users[0].token)).status).toBe(403);
    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.users[0].token))).status).toBe(403);
    expect((await request(app).delete(`/api/trainings/${training.id}/instructor-signature`).set(auth(tenant.users[0].token))).status).toBe(403);

    expect((await putSignature(tenant, training, TRAINER_SIG, intruder.admin.token)).status).toBe(404);
    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(intruder.admin.token))).status).toBe(404);
    expect((await request(app).delete(`/api/trainings/${training.id}/instructor-signature`).set(auth(intruder.admin.token))).status).toBe(404);
  });

  it('formation en catégorie restreinte : un manager sans accès reçoit 404 sur la signature', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'training', name: 'Confidentiel', is_restricted: true })).body;
    const { training } = await setup(tenant, { category_id: category.id });
    await putSignature(tenant, training, TRAINER_SIG);
    const asManager = tenant.users[0].token;
    expect((await request(app).get(`/api/trainings/${training.id}/instructor-signature`).set(auth(asManager))).status).toBe(404);
    expect((await putSignature(tenant, training, NEW_TRAINER_SIG, asManager)).status).toBe(404);
  });

  it('réussite : la signature du formateur est copiée sur le passage et ne change plus ensuite', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    await putSignature(tenant, training, TRAINER_SIG);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    await putSignature(tenant, training, NEW_TRAINER_SIG);
    const { data } = await admin.from('training_quiz_attempts').select('instructor_signature, passed').eq('record_id', record.id).single();
    expect(data.passed).toBe(true);
    expect(data.instructor_signature).toBe(TRAINER_SIG);
  });
});

describe('Compte rendu Word : objet/contenu et signatures', () => {
  it('QCM réussi + signature formateur : contenu de la formation, formateur et DEUX signatures', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    await putSignature(tenant, training, TRAINER_SIG);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    const { text, media } = await wordOf(tenant, training, record);
    expect(text).toContain('Objet et contenu de la formation');
    expect(text).toContain('Chaîne du froid');
    expect(text).toContain('Lavage des mains');
    expect(text).toContain('Claire Formatrice');
    expect(text).toContain('Signatures');
    expect(text).toContain('Le salarié');
    expect(text).toContain('Signature électronique apposée automatiquement à la réussite');
    expect(text).toContain('RÉUSSI');
    expect(media).toHaveLength(2);
  });

  it('QCM non réussi : signature du salarié seulement, aucune signature de formateur', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    await putSignature(tenant, training, TRAINER_SIG);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: BAD, signature: EMPLOYEE_SIG });

    const { text, media } = await wordOf(tenant, training, record);
    expect(text).toContain('NON RÉUSSI');
    expect(text).toContain('n\'est apposée qu\'en cas de réussite');
    expect(text).not.toContain('apposée automatiquement à la réussite');
    expect(media).toHaveLength(1);
  });

  it('QCM réussi sans signature de formateur enregistrée : mention explicite, une seule image', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    const { text, media } = await wordOf(tenant, training, record);
    expect(text).toContain('Signature du formateur non enregistrée');
    expect(media).toHaveLength(1);
  });

  it('réussite AVANT l\'enregistrement de la signature du formateur : le Word utilise la signature actuelle', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });
    await putSignature(tenant, training, TRAINER_SIG);

    const { media } = await wordOf(tenant, training, record);
    expect(media).toHaveLength(2);
  });

  it('objet/contenu et formateur figés à l\'envoi : les modifier ensuite ne change pas le document', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    await request(app).patch(`/api/trainings/${training.id}`).set(auth(tenant.admin.token)).send({ description: 'Contenu totalement différent', instructor: 'Autre Formateur' });
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    const { text } = await wordOf(tenant, training, record);
    expect(text).toContain('Chaîne du froid');
    expect(text).toContain('Claire Formatrice');
    expect(text).not.toContain('Contenu totalement différent');
    expect(text).not.toContain('Autre Formateur');
  });

  it('ancien passage sans copie (training_info absent) : retombe sur les valeurs actuelles de la formation', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant);
    const token = await sendLink(tenant, training, record);
    await admin.from('training_quiz_attempts').update({ training_info: null }).eq('record_id', record.id);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    const { text } = await wordOf(tenant, training, record);
    expect(text).toContain('Chaîne du froid');
    expect(text).toContain('Claire Formatrice');
  });

  it('formation sans description ni formateur : « Non renseigné », le document se génère quand même', async () => {
    const tenant = await newTenant();
    const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Minimale' })).body;
    await request(app).put(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token)).send({ pass_threshold: 50, questions: QUESTIONS });
    const record = (await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: '2026-05-04' })).body;
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });

    const { text } = await wordOf(tenant, training, record);
    expect(text).toContain('Non renseigné');
  });

  it('description contenant du HTML ou des caractères spéciaux : insérée comme texte, document valide', async () => {
    const tenant = await newTenant();
    const { training, record } = await setup(tenant, { description: '<script>alert(1)</script> & "guillemets" — <b>gras</b>' });
    const token = await sendLink(tenant, training, record);
    await submit(token, tenant, { answers: GOOD, signature: EMPLOYEE_SIG });
    const { text } = await wordOf(tenant, training, record);
    expect(text).toContain('<script>alert(1)</script> & "guillemets"');
  });
});
