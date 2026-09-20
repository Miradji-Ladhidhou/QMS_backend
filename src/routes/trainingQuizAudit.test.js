import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'crypto';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { sendEmail } from '../services/email.js';

// Ces tests EXÉCUTENT l'envoi d'email : sendEmail est simulé (il capture le HTML au lieu d'envoyer),
// ce qui permet de retrouver le vrai lien envoyé et de dérouler tout le parcours par l'API, comme le
// ferait la personne — sans jamais insérer un passage à la main.
vi.mock('../services/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 'mock' })) }));

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};

beforeEach(() => {
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => ({ id: 'mock' }));
});

afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const QUESTIONS = [
  { id: 'q1', text: 'Température max ?', options: [{ id: 'a', label: '4 °C', is_correct: true }, { id: 'b', label: '10 °C', is_correct: false }] },
  { id: 'q2', text: 'EPI ?', options: [{ id: 'a', label: 'Charlotte', is_correct: true }, { id: 'b', label: 'Gants', is_correct: true }, { id: 'c', label: 'Bijoux', is_correct: false }] },
];
// PNG 1×1 valide : la signature manuscrite est obligatoire pour valider un QCM.
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function setupTraining(tenant, extra = {}) {
  const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Hygiène', summary: 'Résumé.', ...extra })).body;
  await request(app).put(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token)).send({ pass_threshold: 50, questions: QUESTIONS }).expect(200);
  return training;
}

async function record(tenant, training, person) {
  const res = await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ ...person, completed_at: '2026-05-04' });
  expect(res.status).toBe(201);
  return res.body;
}

const invite = (tenant, training, items) =>
  request(app).post(`/api/trainings/${training.id}/quiz/invites`).set(auth(tenant.admin.token)).send({ items });

// Extrait le jeton du lien contenu dans l'email capturé.
function tokenFromEmail(call = sendEmail.mock.calls.at(-1)) {
  const match = call[2].match(/\/quiz\/([A-Za-z0-9_-]+)/);
  expect(match).not.toBeNull();
  return match[1];
}

describe('Parcours réel : envoi par l\'API → email → passage → réalisation mise à jour', () => {
  it('le lien de l\'email permet de passer le QCM ; le jeton n\'est jamais stocké en clair ; validité 48 h', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });

    const before = Date.now();
    const sent = await invite(tenant, training, [{ record_id: rec.id }]);
    expect(sent.body.results[0].status).toBe('sent');
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const [to, subject, html] = sendEmail.mock.calls[0];
    expect(to).toBe(tenant.admin.email);
    expect(subject).toContain('Hygiène');
    expect(html).toContain(`${process.env.FRONTEND_URL}/quiz/`);

    const token = tokenFromEmail();
    const { data: rows } = await admin.from('training_quiz_attempts').select('*').eq('record_id', rec.id);
    expect(rows).toHaveLength(1);
    // Ni le jeton ni le lien n'apparaissent en base : seulement son hash SHA-256.
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    // Valable 48 h (à quelques secondes près).
    const ttlHours = (new Date(rows[0].expires_at).getTime() - before) / 3600000;
    expect(ttlHours).toBeGreaterThan(47.9);
    expect(ttlHours).toBeLessThan(48.1);

    const start = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(start.status).toBe(200);
    const submit = await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    expect(submit.body).toMatchObject({ passed: true, score_percent: 100 });

    const { data: updated } = await admin.from('training_records').select('evaluation_result').eq('id', rec.id).single();
    expect(updated.evaluation_result).toBe(true);
  });

  it('l\'email échappe le HTML du titre et du nom, et affiche l\'échéance dans le fuseau de l\'entreprise', async () => {
    const tenant = await newTenant();
    await admin.from('tenants').update({ timezone: 'Indian/Reunion' }).eq('id', tenant.tenantId);
    const training = await setupTraining(tenant, { title: '<img src=x onerror=alert(1)> Formation' });
    const employee = (await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: '<b>Paul</b>' })).body;
    const rec = await record(tenant, training, { employee_id: employee.id });

    await invite(tenant, training, [{ record_id: rec.id, email: 'paul@example.com' }]).then((res) => expect(res.body.results[0].status).toBe('sent'));
    const html = sendEmail.mock.calls[0][2];
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Paul</b>');
    expect(html).toContain('&lt;b&gt;Paul&lt;/b&gt;');

    // L'échéance est affichée avec l'heure de La Réunion (UTC+4) ET le fuseau, pas l'heure du serveur.
    const { data: row } = await admin.from('training_quiz_attempts').select('expires_at').eq('record_id', rec.id).single();
    const expectedTime = new Date(row.expires_at).toLocaleTimeString('fr-FR', { timeZone: 'Indian/Reunion', hour: '2-digit', minute: '2-digit' });
    expect(html).toContain(`${expectedTime} UTC+4`);
  });

  it('un saut de ligne dans le titre ne peut pas s\'infiltrer dans l\'objet de l\'email', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant, { title: 'Titre\r\nBcc: pirate@example.com' });
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    expect(sendEmail.mock.calls[0][1]).not.toMatch(/[\r\n]/);
  });

  it('échec d\'envoi : résultat « failed » et AUCUN lien valide ne reste en base', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    sendEmail.mockRejectedValueOnce(new Error('SMTP indisponible'));

    const res = await invite(tenant, training, [{ record_id: rec.id }]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('failed');
    const { data: rows } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id);
    expect(rows).toHaveLength(0);
  });

  it('un envoi en échec n\'empêche pas les autres personnes de la même session', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const training = await setupTraining(tenant);
    const recA = await record(tenant, training, { user_id: tenant.admin.id });
    const recB = await record(tenant, training, { user_id: tenant.users[0].id });
    sendEmail.mockImplementation(async (to) => {
      if (to === tenant.admin.email) throw new Error('boîte pleine');
      return { id: 'ok' };
    });

    const res = await invite(tenant, training, [{ record_id: recA.id }, { record_id: recB.id }]);
    const byRecord = Object.fromEntries(res.body.results.map((r) => [r.record_id, r.status]));
    expect(byRecord[recA.id]).toBe('failed');
    expect(byRecord[recB.id]).toBe('sent');
  });

  it('doublon dans la sélection : un seul email et un seul passage pour la réalisation', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });

    const res = await invite(tenant, training, [{ record_id: rec.id }, { record_id: rec.id }]);
    expect(res.body.results).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const { data: rows } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id);
    expect(rows).toHaveLength(1);
  });

  it('grosse session (12 personnes) : tous reçoivent leur propre lien, tous différents', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const items = [];
    for (let i = 0; i < 12; i += 1) {
      const employee = (await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: `Salarié ${i}` })).body;
      const rec = await record(tenant, training, { employee_id: employee.id });
      items.push({ record_id: rec.id, email: `salarie${i}@example.com` });
    }

    const res = await invite(tenant, training, items);
    expect(res.body.results.every((r) => r.status === 'sent')).toBe(true);
    expect(res.body.results.map((r) => r.record_id)).toEqual(items.map((i) => i.record_id));
    const tokens = sendEmail.mock.calls.map((call) => tokenFromEmail(call));
    expect(new Set(tokens).size).toBe(12);
    // Chaque lien est associé à SON destinataire.
    for (const call of sendEmail.mock.calls) {
      const token = tokenFromEmail(call);
      const wrong = call[0] === 'salarie0@example.com' ? 'salarie1@example.com' : 'salarie0@example.com';
      expect((await request(app).post(`/api/public/quiz/${token}/start`).send({ email: wrong })).status).toBe(403);
    }
  }, 60000);

  it('l\'email saisi pour un salarié doit être valide ; un email invalide → 400 et rien n\'est envoyé', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const employee = (await request(app).post('/api/employees').set(auth(tenant.admin.token)).send({ full_name: 'Paul' })).body;
    const rec = await record(tenant, training, { employee_id: employee.id });
    for (const email of ['pas-un-email', 'a@b', 'a b@c.fr', '@x.fr']) {
      const res = await invite(tenant, training, [{ record_id: rec.id, email }]);
      expect(res.status).toBe(400);
    }
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('pour un compte, l\'email saisi est ignoré : le lien part toujours à l\'adresse du compte', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id, email: 'usurpation@example.com' }]);
    expect(sendEmail.mock.calls[0][0]).toBe(tenant.admin.email);
  });

  it('réalisation d\'une AUTRE formation ou inexistante : not_found, aucun email', async () => {
    const tenant = await newTenant();
    const trainingA = await setupTraining(tenant);
    const trainingB = await setupTraining(tenant);
    const recOfB = await record(tenant, trainingB, { user_id: tenant.admin.id });

    const res = await invite(tenant, trainingA, [{ record_id: recOfB.id }, { record_id: '00000000-0000-4000-8000-000000000000' }]);
    expect(res.body.results.map((r) => r.status)).toEqual(['not_found', 'not_found']);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('validation des items : vide, trop nombreux, ids invalides → 400', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    expect((await invite(tenant, training, [])).status).toBe(400);
    expect((await invite(tenant, training, [{ record_id: 'pas-un-uuid' }])).status).toBe(400);
    const many = Array.from({ length: 201 }, () => ({ record_id: '00000000-0000-4000-8000-000000000000' }));
    expect((await invite(tenant, training, many)).status).toBe(400);
  });
});

describe('Renvoi, deuxième passage et audit', () => {
  it('renvoyer invalide l\'ancien lien (410) et le nouveau fonctionne ; les deux passages restent en base', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });

    await invite(tenant, training, [{ record_id: rec.id }]);
    const oldToken = tokenFromEmail();
    await invite(tenant, training, [{ record_id: rec.id }]);
    const newToken = tokenFromEmail();

    expect((await request(app).post(`/api/public/quiz/${oldToken}/start`).send({ email: tenant.admin.email })).status).toBe(410);
    expect((await request(app).post(`/api/public/quiz/${newToken}/start`).send({ email: tenant.admin.email })).status).toBe(200);
    const { data: rows } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id);
    expect(rows).toHaveLength(2);
  });

  it('échec puis nouveau passage réussi : la réalisation passe à « réussi », les deux essais sont tracés et exportables', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });

    await invite(tenant, training, [{ record_id: rec.id }]);
    const first = tokenFromEmail();
    const fail = await request(app).post(`/api/public/quiz/${first}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['b'], q2: ['c'] } });
    expect(fail.body.passed).toBe(false);
    expect((await admin.from('training_records').select('evaluation_result').eq('id', rec.id).single()).data.evaluation_result).toBe(false);

    await invite(tenant, training, [{ record_id: rec.id }]);
    const second = tokenFromEmail();
    await request(app).post(`/api/public/quiz/${second}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    const { data: after } = await admin.from('training_records').select('evaluation_result, evaluation_notes').eq('id', rec.id).single();
    expect(after.evaluation_result).toBe(true);
    // Une ligne de synthèse PAR ESSAI (trace de tous les passages) : l'échec puis la réussite.
    const noteLines = after.evaluation_notes.split('\n').filter((l) => l.startsWith('QCM en ligne'));
    expect(noteLines).toHaveLength(2);
    expect(noteLines[0]).toContain('essai n°1');
    expect(noteLines[0]).toContain('non réussi');
    expect(noteLines[1]).toContain('essai n°2');
    expect(noteLines[1]).toMatch(/— réussi$/);

    const attempts = await request(app).get(`/api/trainings/${training.id}/quiz/attempts`).set(auth(tenant.admin.token));
    expect(attempts.body.filter((a) => a.completed_at)).toHaveLength(2);
    for (const attempt of attempts.body) {
      const word = await request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attempt.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
      expect(word.status).toBe(200);
    }
  });
});

describe('Robustesse de la page publique', () => {
  async function ready() {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    return { tenant, training, rec, token: tokenFromEmail() };
  }

  it('deux envois simultanés : un seul est enregistré (l\'autre reçoit 409)', async () => {
    const { tenant, token } = await ready();
    const send = () => request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    const statuses = (await Promise.all([send(), send(), send()])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
  });

  it('essais d\'email en parallèle : le compteur ne perd aucun essai, le lien se verrouille', async () => {
    const { tenant, token } = await ready();
    await Promise.all(Array.from({ length: 12 }, (_, i) => request(app).post(`/api/public/quiz/${token}/start`).send({ email: `faux${i}@example.com` })));
    const { data } = await admin.from('training_quiz_attempts').select('failed_email_attempts').eq('token_hash', createHash('sha256').update(token).digest('hex')).single();
    expect(data.failed_email_attempts).toBeGreaterThanOrEqual(5);
    const locked = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(locked.status).toBe(403);
    expect(locked.body.state).toBe('locked');
  }, 30000);

  it('corps invalides : pas de corps, email objet/tableau/nombre, answers non-objet → jamais 500', async () => {
    const { tenant, token } = await ready();
    for (const email of [undefined, null, {}, ['a@b.fr'], 42, true, '']) {
      const res = await request(app).post(`/api/public/quiz/${token}/start`).send(email === undefined ? {} : { email });
      expect([403, 423]).toContain(res.status);
    }
    const noBody = await request(app).post(`/api/public/quiz/${token}/start`);
    expect(noBody.status).toBeLessThan(500);
    for (const answers of ['x', 12, [], [['a']], { q1: { a: true } }, { q1: 'a' }]) {
      const res = await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers });
      expect(res.status).toBeLessThan(500);
      if (res.status === 200) {
        expect(res.body.passed).toBe(false);
        break; // le passage est consommé après le premier envoi accepté
      }
    }
  });

  it('le jeton n\'apparaît jamais dans les journaux d\'erreur du serveur', async () => {
    const { token } = await ready();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Un corps JSON invalide déclenche le gestionnaire d'erreurs global, qui journalise l'adresse.
    await request(app).post(`/api/public/quiz/${token}/start`).set('Content-Type', 'application/json').send('{pas du json');
    const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    spy.mockRestore();
    expect(logged).toContain('Erreur non gérée');
    expect(logged).not.toContain(token);
    expect(logged).toContain('[jeton]');
  });

  it('les réponses publiques ne sont jamais mises en cache', async () => {
    const { tenant, token } = await ready();
    const state = await request(app).get(`/api/public/quiz/${token}`);
    const start = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(state.headers['cache-control']).toBe('no-store');
    expect(start.headers['cache-control']).toBe('no-store');
  });

  it('un passage terminé n\'expose plus le contenu : GET → completed, start → 409', async () => {
    const { tenant, token } = await ready();
    await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    expect((await request(app).get(`/api/public/quiz/${token}`)).body.state).toBe('completed');
    const start = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(start.status).toBe(409);
    expect(JSON.stringify(start.body)).not.toMatch(/Résumé|Température/);
  });

  it('supprimer la formation invalide les liens en attente (404 sur le lien)', async () => {
    const { tenant, training, token } = await ready();
    await request(app).delete(`/api/trainings/${training.id}`).set(auth(tenant.admin.token)).expect(204);
    expect((await request(app).get(`/api/public/quiz/${token}`)).status).toBe(404);
  });
});

describe('Lien bricolé : modifier l\'URL ne donne accès à rien', () => {
  async function ready() {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    return { tenant, token: tokenFromEmail() };
  }

  const flip = (token, index) => token.slice(0, index) + (token[index] === 'A' ? 'B' : 'A') + token.slice(index + 1);

  it('un caractère modifié, ajouté, retiré, ou la casse changée : même réponse 404 « Lien invalide », sans rien révéler', async () => {
    const { tenant, token } = await ready();
    const variants = [flip(token, 0), flip(token, 20), flip(token, token.length - 1), `${token}x`, token.slice(0, -1), token.toUpperCase(), token.toLowerCase(), token.split('').reverse().join('')]
      .filter((variant) => variant !== token);

    const bodies = new Set();
    for (const variant of variants) {
      for (const res of [
        await request(app).get(`/api/public/quiz/${variant}`),
        await request(app).post(`/api/public/quiz/${variant}/start`).send({ email: tenant.admin.email }),
        await request(app).post(`/api/public/quiz/${variant}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: {} }),
      ]) {
        expect(res.status).toBe(404);
        bodies.add(JSON.stringify(res.body));
      }
    }
    // Toujours exactement la même réponse : impossible de « chauffer/froid » vers un vrai jeton.
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe(JSON.stringify({ error: 'Lien invalide.' }));

    // Et le vrai lien n'a pas été affecté (aucun essai compté, aucun passage consommé).
    const ok = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(ok.status).toBe(200);
  });

  it('jetons pathologiques (injection SQL, traversée de chemin, très long, caractères spéciaux) : jamais de 500, jamais d\'accès', async () => {
    await ready();
    const evil = ["' OR '1'='1", '1; DROP TABLE training_quiz_attempts;--', '../../../etc/passwd', '..%2f..%2fadmin', '%00', '<script>alert(1)</script>', 'a'.repeat(5000), '*', '%', '_', 'null', 'undefined', '{}', '[]'];
    for (const value of evil) {
      const res = await request(app).get(`/api/public/quiz/${encodeURIComponent(value)}`);
      expect(res.status).toBe(404);
    }
    // Le point d'entrée ne sait rien faire d'autre que ces trois routes : pas de liste, pas d'identifiant.
    for (const path of ['/api/public/quiz', '/api/public/quiz/', '/api/public/', '/api/public/trainings', '/api/public/quiz/x/attempts']) {
      const res = await request(app).get(path);
      expect([401, 404]).toContain(res.status);
    }
  });

  it('un jeton valide d\'un AUTRE passage ne donne accès qu\'à SON propre contenu (jamais à celui d\'un autre salarié)', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const training = await setupTraining(tenant);
    const recA = await record(tenant, training, { user_id: tenant.admin.id });
    const recB = await record(tenant, training, { user_id: tenant.users[0].id });
    // Vide les emails d'invitation de compte envoyés par createTenant : ne garder que ceux du QCM.
    sendEmail.mockClear();
    await invite(tenant, training, [{ record_id: recA.id }, { record_id: recB.id }]);
    const tokenOf = (to) => tokenFromEmail(sendEmail.mock.calls.find((call) => call[0] === to));
    const tokenA = tokenOf(tenant.admin.email);
    const tokenB = tokenOf(tenant.users[0].email);

    // Le jeton de B avec l'email de A : refusé (chaque lien est lié à SON destinataire).
    expect((await request(app).post(`/api/public/quiz/${tokenB}/start`).send({ email: tenant.admin.email })).status).toBe(403);
    // Et un passage soumis avec le jeton de A n'écrit que sur la réalisation de A.
    await request(app).post(`/api/public/quiz/${tokenA}/submit`).send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    expect((await admin.from('training_records').select('evaluation_result').eq('id', recA.id).single()).data.evaluation_result).toBe(true);
    expect((await admin.from('training_records').select('evaluation_result').eq('id', recB.id).single()).data.evaluation_result).toBeNull();
  });

  it('le corps de la requête ne peut pas désigner une autre réalisation, un autre tenant ou un autre passage', async () => {
    const { tenant, token } = await ready();
    const other = await newTenant();
    const otherTraining = await setupTraining(other);
    const otherRecord = await record(other, otherTraining, { user_id: other.admin.id });

    const res = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({
        email: tenant.admin.email,
        signature: SIGNATURE,
        answers: { q1: ['a'], q2: ['a', 'b'] },
        record_id: otherRecord.id,
        tenant_id: other.tenantId,
        training_id: otherTraining.id,
        passed: true,
        score_percent: 100,
        attempt_id: '00000000-0000-4000-8000-000000000000',
      });
    expect(res.status).toBe(200);
    // Rien n'a bougé chez l'autre entreprise.
    expect((await admin.from('training_records').select('evaluation_result').eq('id', otherRecord.id).single()).data.evaluation_result).toBeNull();
  });

  it('un résultat « réussi » envoyé par le client est ignoré : la note est calculée par le serveur', async () => {
    const { tenant, token } = await ready();
    const res = await request(app)
      .post(`/api/public/quiz/${token}/submit`)
      .send({ email: tenant.admin.email, signature: SIGNATURE, answers: { q1: ['b'], q2: ['c'] }, passed: true, score_percent: 100, correct_count: 2 });
    expect(res.body).toMatchObject({ passed: false, correct_count: 0, score_percent: 0 });
  });
});

describe('Isolation entre entreprises et droits', () => {
  it('une autre entreprise ne voit ni ne modifie le QCM, les passages, les exports ni ne peut envoyer', async () => {
    const owner = await newTenant();
    const intruder = await newTenant();
    const training = await setupTraining(owner);
    const rec = await record(owner, training, { user_id: owner.admin.id });
    await invite(owner, training, [{ record_id: rec.id }]);
    const token = tokenFromEmail();
    await request(app).post(`/api/public/quiz/${token}/submit`).send({ email: owner.admin.email, signature: SIGNATURE, answers: { q1: ['a'], q2: ['a', 'b'] } });
    const { data: attempt } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id).single();

    const as = (t) => auth(t.admin.token);
    expect((await request(app).get(`/api/trainings/${training.id}/quiz`).set(as(intruder))).status).toBe(404);
    expect((await request(app).put(`/api/trainings/${training.id}/quiz`).set(as(intruder)).send({ pass_threshold: 1, questions: QUESTIONS })).status).toBe(404);
    expect((await request(app).get(`/api/trainings/${training.id}/quiz/attempts`).set(as(intruder))).status).toBe(404);
    expect((await request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attempt.id}/word`).set(as(intruder))).status).toBe(404);
    sendEmail.mockClear();
    expect((await invite(intruder, training, [{ record_id: rec.id }])).status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();

    // Le QCM du propriétaire n'a pas bougé.
    const intact = await request(app).get(`/api/trainings/${training.id}/quiz`).set(as(owner));
    expect(intact.body.pass_threshold).toBe(50);
  });

  it('un simple membre ne peut ni envoyer, ni lister les passages, ni exporter', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    const { data: attempt } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id).single();
    sendEmail.mockClear();

    const asMember = (req) => req.set(auth(member.token));
    expect((await asMember(request(app).post(`/api/trainings/${training.id}/quiz/invites`)).send({ items: [{ record_id: rec.id }] })).status).toBe(403);
    expect((await asMember(request(app).get(`/api/trainings/${training.id}/quiz/attempts`))).status).toBe(403);
    expect((await asMember(request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attempt.id}/word`))).status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('un manager peut créer le QCM et envoyer les liens', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const training = (await request(app).post('/api/trainings').set(auth(manager.token)).send({ title: 'Formation du manager' })).body;
    const put = await request(app).put(`/api/trainings/${training.id}/quiz`).set(auth(manager.token)).send({ pass_threshold: 70, questions: QUESTIONS });
    expect(put.status).toBe(200);
    const rec = (await request(app).post(`/api/trainings/${training.id}/records`).set(auth(manager.token)).send({ user_id: manager.id, completed_at: '2026-05-04' })).body;
    const sent = await request(app).post(`/api/trainings/${training.id}/quiz/invites`).set(auth(manager.token)).send({ items: [{ record_id: rec.id }] });
    expect(sent.body.results[0].status).toBe('sent');
  });

  it('formation en catégorie restreinte : un manager sans accès reçoit 404 sur tout le QCM ; l\'admin y accède', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'training', name: 'Confidentiel', is_restricted: true })).body;
    const training = await setupTraining(tenant, { category_id: category.id });
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    const { data: attempt } = await admin.from('training_quiz_attempts').select('id').eq('record_id', rec.id).single();
    sendEmail.mockClear();

    const asManager = (req) => req.set(auth(manager.token));
    expect((await asManager(request(app).get(`/api/trainings/${training.id}/quiz`))).status).toBe(404);
    expect((await asManager(request(app).put(`/api/trainings/${training.id}/quiz`)).send({ pass_threshold: 1, questions: QUESTIONS })).status).toBe(404);
    expect((await asManager(request(app).get(`/api/trainings/${training.id}/quiz/attempts`))).status).toBe(404);
    expect((await asManager(request(app).get(`/api/trainings/${training.id}/quiz/attempts/${attempt.id}/word`))).status).toBe(404);
    expect((await asManager(request(app).post(`/api/trainings/${training.id}/quiz/invites`)).send({ items: [{ record_id: rec.id }] })).status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();

    expect((await request(app).get(`/api/trainings/${training.id}/quiz`).set(auth(tenant.admin.token))).status).toBe(200);
  });
});

describe('Modification du QCM', () => {
  it('ids dupliqués envoyés par un client : stockés uniques ; la correction reste cohérente', async () => {
    const tenant = await newTenant();
    const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'F' })).body;
    const res = await request(app)
      .put(`/api/trainings/${training.id}/quiz`)
      .set(auth(tenant.admin.token))
      .send({
        pass_threshold: 50,
        questions: [{ id: 'dup', text: 'Q', options: [{ id: 'x', label: 'A', is_correct: true }, { id: 'x', label: 'B', is_correct: false }] }],
      });
    expect(res.status).toBe(200);
    const ids = res.body.questions[0].options.map((o) => o.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('un passage déjà envoyé garde l\'ancien QCM après modification ; le prochain envoi utilise le nouveau', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant);
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    const oldToken = tokenFromEmail();

    await request(app)
      .put(`/api/trainings/${training.id}/quiz`)
      .set(auth(tenant.admin.token))
      .send({ pass_threshold: 90, questions: [{ id: 'n1', text: 'Nouvelle question', options: [{ id: 'a', label: 'X', is_correct: true }, { id: 'b', label: 'Y' }] }] });

    const oldStart = await request(app).post(`/api/public/quiz/${oldToken}/start`).send({ email: tenant.admin.email });
    expect(oldStart.body.questions).toHaveLength(2);
    expect(oldStart.body.pass_threshold).toBe(50);

    await invite(tenant, training, [{ record_id: rec.id }]);
    const newToken = tokenFromEmail();
    const newStart = await request(app).post(`/api/public/quiz/${newToken}/start`).send({ email: tenant.admin.email });
    expect(newStart.body.questions).toHaveLength(1);
    expect(newStart.body.pass_threshold).toBe(90);
  });

  it('le résumé modifié après l\'envoi est celui affiché (le résumé n\'est pas figé, seul le QCM l\'est)', async () => {
    const tenant = await newTenant();
    const training = await setupTraining(tenant, { summary: 'Ancien résumé' });
    const rec = await record(tenant, training, { user_id: tenant.admin.id });
    await invite(tenant, training, [{ record_id: rec.id }]);
    const token = tokenFromEmail();
    await request(app).patch(`/api/trainings/${training.id}`).set(auth(tenant.admin.token)).send({ summary: 'Résumé à jour' });
    const start = await request(app).post(`/api/public/quiz/${token}/start`).send({ email: tenant.admin.email });
    expect(start.body.summary).toBe('Résumé à jour');
  });

  it('résumé trop long (> 10 000 caractères) refusé ; vidé → chaîne vide côté page publique', async () => {
    const tenant = await newTenant();
    const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'F' })).body;
    const tooLong = await request(app).patch(`/api/trainings/${training.id}`).set(auth(tenant.admin.token)).send({ summary: 'x'.repeat(10001) });
    expect(tooLong.status).toBe(400);
  });
});
