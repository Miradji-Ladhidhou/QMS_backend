import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { sendEmail } from '../services/email.js';
import { resolveSchedule, addMonths } from '../services/managementReviewSchedule.js';
import { generateManagementReviewDraft } from '../services/groq.js';

// L'envoi d'email et l'IA sont simulés : on capture les messages (destinataire, objet, HTML, pièces jointes).
vi.mock('../services/email.js', () => ({ sendEmail: vi.fn(async () => ({ id: 'mock' })) }));
vi.mock('../services/groq.js', async (importOriginal) => ({ ...(await importOriginal()), generateManagementReviewDraft: vi.fn() }));

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};
beforeEach(() => {
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => ({ id: 'mock' }));
  generateManagementReviewDraft.mockReset();
});
afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const api = (method, path, token, body) => {
  const req = request(app)[method](`/api${path}`).set(auth(token));
  return body === undefined ? req : req.send(body);
};

async function createReview(tenant, extra = {}) {
  const res = await api('post', '/management-reviews', tenant.admin.token, { title: 'Revue S1 2026', review_date: '2026-09-20', participants: 'Direction, Qualité', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}
async function closedReview(tenant, extra = {}) {
  const review = await createReview(tenant, extra);
  await admin.from('management_reviews').update({ status: 'completed', conclusions: 'Système adapté.' }).eq('id', review.id);
  return review;
}
const validate = (tenant, review, signature = PNG, token = tenant.admin.token) => api('post', `/management-reviews/${review.id}/validate`, token, signature === null ? {} : { signature });
const detail = (tenant, review, token = tenant.admin.token) => api('get', `/management-reviews/${review.id}`, token);

describe('addMonths / resolveSchedule (purs)', () => {
  it('addMonths ne déborde jamais sur le mois suivant', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-15', 12)).toBe('2027-03-15');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2026-08-01', 6)).toBe('2027-02-01');
  });

  it('statuts : non configuré, aucune revue, programmée, à jour, bientôt, en retard (frontières incluses)', () => {
    const today = '2026-09-20';
    const base = { frequencyMonths: 12, scheduledReview: null, today };
    expect(resolveSchedule({ ...base, frequencyMonths: null, lastCompletedDate: '2025-01-01' }).status).toBe('not_configured');
    expect(resolveSchedule({ ...base, lastCompletedDate: null }).status).toBe('no_review');
    expect(resolveSchedule({ ...base, lastCompletedDate: null, scheduledReview: { id: 'x' } }).status).toBe('scheduled');
    expect(resolveSchedule({ ...base, lastCompletedDate: '2026-02-01' })).toMatchObject({ status: 'ok', next_due_date: '2027-02-01' });
    // échéance le 2026-11-19 = aujourd'hui + 60 j : encore « bientôt » ; le lendemain : « ok ».
    expect(resolveSchedule({ ...base, lastCompletedDate: '2025-11-19' }).status).toBe('due_soon');
    expect(resolveSchedule({ ...base, lastCompletedDate: '2025-11-20' }).status).toBe('ok');
    // échéance aujourd'hui : pas encore en retard ; hier : en retard.
    expect(resolveSchedule({ ...base, lastCompletedDate: '2025-09-20' }).status).toBe('due_soon');
    expect(resolveSchedule({ ...base, lastCompletedDate: '2025-09-19' }).status).toBe('overdue');
    // Une revue programmée supprime le retard.
    expect(resolveSchedule({ ...base, lastCompletedDate: '2024-01-01', scheduledReview: { id: 'x' } }).status).toBe('scheduled');
  });
});

describe('Validation signée de la direction', () => {
  it('admin seulement ; revue clôturée requise ; signature obligatoire et contrôlée', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const draft = await createReview(tenant);
    expect((await validate(tenant, draft)).status).toBe(400); // pas clôturée
    const closed = await closedReview(tenant, { title: 'Clôturée' });

    expect((await validate(tenant, closed, PNG, tenant.users[0].token)).status).toBe(403);
    const missing = await validate(tenant, closed, null);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Signez/);
    for (const signature of ['texte', 42, 'data:image/jpeg;base64,AAAA', `data:image/png;base64,${Buffer.from('<script>').toString('base64')}`]) {
      expect((await validate(tenant, closed, signature)).status).toBe(400);
    }
    expect((await detail(tenant, closed)).body.is_validated).toBe(false);

    const ok = await validate(tenant, closed);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ is_validated: true, validated_by: tenant.admin.id });
    const after = (await detail(tenant, closed)).body;
    expect(after).toMatchObject({ is_validated: true, validated_by: tenant.admin.id });
    expect(after.validator.full_name).toBe('Test Admin');
    // La signature n'est jamais embarquée : ni dans le détail, ni dans la liste.
    expect(JSON.stringify(after)).not.toContain('data:image');
    expect(JSON.stringify((await api('get', '/management-reviews', tenant.admin.token)).body)).not.toContain('data:image');

    expect((await validate(tenant, closed)).status).toBe(409); // déjà validée
  });

  it('deux validations simultanées : une seule aboutit', async () => {
    const tenant = await newTenant();
    const review = await closedReview(tenant);
    const statuses = (await Promise.all([validate(tenant, review), validate(tenant, review), validate(tenant, review)])).map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
  });

  it('une revue validée est verrouillée : texte, dates, statut, ajout/suppression d\'actions, suppression, IA', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const review = await closedReview(tenant, { period_start: '2026-01-01', period_end: '2026-06-30' });
    const action = (await api('post', `/management-reviews/${review.id}/actions`, tenant.admin.token, { description: 'Former deux auditeurs' })).body;
    await validate(tenant, review);
    const locked = (res) => {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('review_validated');
    };

    locked(await api('patch', `/management-reviews/${review.id}`, tenant.admin.token, { conclusions: 'Modifié' }));
    locked(await api('patch', `/management-reviews/${review.id}`, tenant.users[0].token, { title: 'Autre' }));
    locked(await api('patch', `/management-reviews/${review.id}`, tenant.admin.token, { status: 'draft' }));
    locked(await api('post', `/management-reviews/${review.id}/actions`, tenant.admin.token, { description: 'Nouvelle' }));
    locked(await api('delete', `/management-reviews/${review.id}/actions/${action.id}`, tenant.admin.token));
    locked(await api('patch', `/management-reviews/${review.id}/actions/${action.id}`, tenant.admin.token, { description: 'Réécrite' }));
    locked(await api('delete', `/management-reviews/${review.id}`, tenant.admin.token));
    locked(await api('delete', '/management-reviews/bulk', tenant.admin.token, { ids: [review.id] }));
    locked(await api('post', `/management-reviews/${review.id}/ai-draft`, tenant.admin.token));
    expect(generateManagementReviewDraft).not.toHaveBeenCalled();
    expect((await api('post', `/management-reviews/${review.id}/refresh-snapshot`, tenant.admin.token)).status).toBe(400);

    const { data } = await admin.from('management_reviews').select('conclusions, title').eq('id', review.id).single();
    expect(data).toMatchObject({ conclusions: 'Système adapté.', title: 'Revue S1 2026' });
  });

  it('le SUIVI des actions reste possible après validation (responsable, échéance, statut, CAPA)', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const review = await closedReview(tenant);
    const action = (await api('post', `/management-reviews/${review.id}/actions`, tenant.admin.token, { description: 'Renouveler les habilitations' })).body;
    await validate(tenant, review);

    const patched = await api('patch', `/management-reviews/${review.id}/actions/${action.id}`, tenant.users[0].token, { owner: tenant.users[0].id, due_date: '2026-12-01', status: 'in_progress' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ owner: tenant.users[0].id, due_date: '2026-12-01', status: 'in_progress' });
    const done = await api('patch', `/management-reviews/${review.id}/actions/${action.id}`, tenant.admin.token, { status: 'done' });
    expect(done.body.completed_at).toBeTruthy();
    const capa = await api('post', `/management-reviews/${review.id}/actions/${action.id}/create-capa`, tenant.admin.token, { title: 'CAPA depuis la revue' });
    expect(capa.status).toBe(201);
  });

  it('rouvrir : admin seulement, efface validation et signature, redonne la main, et laisse une trace', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const review = await closedReview(tenant);
    expect((await api('post', `/management-reviews/${review.id}/reopen`, tenant.admin.token)).status).toBe(400); // pas validée
    await validate(tenant, review);

    expect((await api('post', `/management-reviews/${review.id}/reopen`, tenant.users[0].token)).status).toBe(403);
    const reopened = await api('post', `/management-reviews/${review.id}/reopen`, tenant.admin.token);
    expect(reopened.status).toBe(200);
    expect(reopened.body.is_validated).toBe(false);
    expect((await admin.from('management_review_signatures').select('review_id').eq('review_id', review.id)).data).toHaveLength(0);
    expect((await detail(tenant, review)).body).toMatchObject({ is_validated: false, validated_by: null, validated_at: null });
    expect((await api('patch', `/management-reviews/${review.id}`, tenant.admin.token, { conclusions: 'Corrigé après réouverture' })).status).toBe(200);

    const { data: log } = await admin.from('activity_log').select('action').eq('entity_id', review.id);
    expect(log.map((row) => row.action)).toEqual(expect.arrayContaining(['MANAGEMENT_REVIEW_VALIDATED', 'MANAGEMENT_REVIEW_REOPENED']));
    // Re-validation possible.
    expect((await validate(tenant, review)).status).toBe(200);
  });

  it('aperçu de la signature : lisible par ceux qui voient la revue, jamais par une autre entreprise ou un manager sans accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const other = await newTenant();
    const category = (await api('post', '/module-categories', tenant.admin.token, { resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const open = await closedReview(tenant, { title: 'Ouverte' });
    const restricted = await closedReview(tenant, { title: 'Restreinte', category_id: category.id });
    await validate(tenant, open);
    await validate(tenant, restricted);

    expect((await api('get', `/management-reviews/${open.id}/validation-signature`, tenant.users[0].token)).body.image).toBe(PNG);
    expect((await api('get', `/management-reviews/${open.id}/validation-signature`, other.admin.token)).status).toBe(404);
    expect((await api('get', `/management-reviews/${restricted.id}/validation-signature`, tenant.users[0].token)).status).toBe(404);
    expect((await api('get', `/management-reviews/${restricted.id}/validation-signature`, tenant.admin.token)).body.image).toBe(PNG);
    const unsigned = await closedReview(tenant, { title: 'Non signée' });
    expect((await api('get', `/management-reviews/${unsigned.id}/validation-signature`, tenant.admin.token)).body).toBeNull();
  });

  it('les exports affichent la validation et la signature', async () => {
    const tenant = await newTenant();
    const review = await closedReview(tenant);
    await validate(tenant, review);

    const word = await api('get', `/management-reviews/${review.id}/word`, tenant.admin.token).responseType('blob');
    const buffer = Buffer.from(word.body);
    expect((await mammoth.extractRawText({ buffer })).value).toContain('Validée et signée par Test Admin');
    const zip = await JSZip.loadAsync(buffer);
    expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !name.endsWith('/'))).toHaveLength(1);

    const pdf = await api('get', `/management-reviews/${review.id}/pdf`, tenant.admin.token).responseType('blob');
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');

    const xlsx = await api('get', `/management-reviews/${review.id}/xlsx`, tenant.admin.token).responseType('blob');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(xlsx.body));
    const rows = Object.fromEntries(workbook.getWorksheet('Revue').getSheetValues().filter(Array.isArray).map((row) => [row[1], row[2]]));
    expect(rows['Validation de la direction']).toContain('Validée et signée par Test Admin');

    // Non validée : la mention l'indique, aucune image.
    const draft = await closedReview(tenant, { title: 'Non validée' });
    const wordDraft = Buffer.from((await api('get', `/management-reviews/${draft.id}/word`, tenant.admin.token).responseType('blob')).body);
    expect((await mammoth.extractRawText({ buffer: wordDraft })).value).not.toContain('Validée et signée');
  });
});

describe('Convocation et envoi du compte rendu', () => {
  const send = (tenant, review, kind, body, token = tenant.admin.token) => api('post', `/management-reviews/${review.id}/send-${kind}`, token, body);
  const lastCall = () => sendEmail.mock.calls.at(-1);

  async function employeeWithEmail(tenant, email = 'paul@example.com', fullName = 'Paul Opérateur') {
    return (await api('post', '/employees', tenant.admin.token, { full_name: fullName, email })).body;
  }

  it('recipients : comptes actifs avec leur adresse + salariés avec email ; jamais ceux sans adresse ; admin/manager seulement', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const paul = await employeeWithEmail(tenant);
    await api('post', '/employees', tenant.admin.token, { full_name: 'Sans Email' });

    const res = await api('get', '/management-reviews/recipients', tenant.users[1].token); // manager
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.map((person) => [person.name, person]));
    expect(byName['Test Admin']).toMatchObject({ kind: 'user', email: tenant.admin.email.toLowerCase() });
    expect(byName['Paul Opérateur']).toMatchObject({ kind: 'employee', id: paul.id, email: 'paul@example.com' });
    expect(byName['Sans Email']).toBeUndefined();
    expect((await api('get', '/management-reviews/recipients', tenant.users[0].token)).status).toBe(403);
  });

  it('convocation : un email par destinataire, dédoublonné, avec ordre du jour, invitation .ics et trace', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const paul = await employeeWithEmail(tenant);
    const previous = await closedReview(tenant, { title: 'Revue S2 2025', review_date: '2025-09-01' });
    await api('post', `/management-reviews/${previous.id}/actions`, tenant.admin.token, { description: 'Renouveler les habilitations' });
    const review = await createReview(tenant, { title: 'Revue S1 2026', period_start: '2026-01-01', period_end: '2026-06-30' });
    sendEmail.mockClear();

    const res = await send(tenant, review, 'convocation', {
      recipients: [{ kind: 'user', id: tenant.users[0].id }, { kind: 'employee', id: paul.id }],
      extra_emails: ['Direction@Exemple.com', 'paul@example.com'], // doublon avec Paul
      meeting_time: '14:30',
      location: 'Salle de réunion 2',
      message: 'Merci de préparer vos indicateurs.',
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(new Set(sendEmail.mock.calls.map((call) => call[0].toLowerCase())).size).toBe(3);

    const [to, subject, html, options] = sendEmail.mock.calls.find((call) => call[0] === 'paul@example.com');
    expect(to).toBe('paul@example.com');
    expect(subject).toBe('Convocation — Revue de direction « Revue S1 2026 » du 20/09/2026');
    for (const expected of ['Date : 20/09/2026 à 14:30', 'Lieu : Salle de réunion 2', 'Direction, Qualité', 'Merci de préparer vos indicateurs.', 'Ordre du jour', 'Revue S2 2025 : 1 action(s), 1 non soldée(s)', 'du 01/01/2026 au 30/06/2026']) {
      expect(html).toContain(expected);
    }
    // Un seul destinataire dans l'en-tête : personne ne voit les autres.
    expect(html).not.toContain('direction@exemple.com');
    const ics = options.attachments[0];
    expect(ics.filename).toBe('revue-de-direction.ics');
    const text = ics.content.toString('utf-8');
    expect(text).toContain('BEGIN:VEVENT');
    expect(text).toContain('DTSTART:20260920T143000');
    expect(text).toContain('DTEND:20260920T163000');
    expect(text).toContain('SUMMARY:Revue de direction — Revue S1 2026');
    expect(text).toContain('LOCATION:Salle de réunion 2');

    const { data: mailing } = await admin.from('management_review_mailings').select('kind, recipients, sent_by').eq('review_id', review.id).single();
    expect(mailing).toMatchObject({ kind: 'convocation', sent_by: tenant.admin.id });
    expect(mailing.recipients).toHaveLength(3);
    const embedded = (await detail(tenant, review)).body.mailings;
    expect(embedded).toHaveLength(1);
    expect(embedded[0].sender.full_name).toBe('Test Admin');
  });

  it('sans heure : invitation sur la journée entière ; échappe le HTML du titre et du message ; objet sans saut de ligne', async () => {
    const tenant = await newTenant();
    const review = await createReview(tenant, { title: '<img src=x onerror=alert(1)> Revue\r\nBcc: pirate@example.com' });
    await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'], message: '<script>alert(1)</script>' });
    const [, subject, html, options] = lastCall();
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    const text = options.attachments[0].content.toString('utf-8');
    expect(text).toContain('DTSTART;VALUE=DATE:20260920');
    expect(text).toContain('DTEND;VALUE=DATE:20260921');
  });

  it('un envoi en échec n\'empêche pas les autres ; le résultat est tracé par destinataire', async () => {
    const tenant = await newTenant();
    sendEmail.mockImplementation(async (to) => {
      if (to === 'boite-pleine@example.com') throw new Error('boîte pleine');
      return { id: 'ok' };
    });
    const review = await createReview(tenant);
    const res = await send(tenant, review, 'convocation', { extra_emails: ['boite-pleine@example.com', 'ok@example.com'] });
    expect(Object.fromEntries(res.body.results.map((r) => [r.email, r.status]))).toEqual({ 'boite-pleine@example.com': 'failed', 'ok@example.com': 'sent' });
    const { data } = await admin.from('management_review_mailings').select('recipients').eq('review_id', review.id).single();
    expect(data.recipients.map((r) => r.status).sort()).toEqual(['failed', 'sent']);
  });

  it('validations : aucun destinataire, adresse/heure invalides, message trop long, trop de destinataires → 400', async () => {
    const tenant = await newTenant();
    const review = await createReview(tenant);
    expect((await send(tenant, review, 'convocation', {})).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { recipients: [] })).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { extra_emails: ['pas-un-email'] })).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'], meeting_time: '25:00' })).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'], message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { recipients: [{ kind: 'user', id: 'pas-un-uuid' }] })).status).toBe(400);
    expect((await send(tenant, review, 'convocation', { recipients: [{ kind: 'robot', id: tenant.admin.id }] })).status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('un destinataire d\'une AUTRE entreprise est ignoré (jamais son adresse) ; un salarié sans email est signalé', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const noEmail = (await api('post', '/employees', tenant.admin.token, { full_name: 'Sans Email' })).body;
    const review = await createReview(tenant);
    const res = await send(tenant, review, 'convocation', {
      recipients: [{ kind: 'user', id: other.admin.id }, { kind: 'employee', id: noEmail.id }],
      extra_emails: ['ok@example.com'],
    });
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('ok@example.com');
    expect(res.body.results.find((r) => r.name === 'Sans Email').status).toBe('no_email');
  });

  it('compte rendu : refusé tant que la revue n\'est pas validée ; ensuite PDF joint et actions listées', async () => {
    const tenant = await newTenant();
    const review = await closedReview(tenant);
    await api('post', `/management-reviews/${review.id}/actions`, tenant.admin.token, { description: 'Former deux auditeurs', owner: tenant.admin.id, due_date: '2026-11-30' });

    const early = await send(tenant, review, 'minutes', { extra_emails: ['a@example.com'] });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('review_not_validated');
    expect(sendEmail).not.toHaveBeenCalled();

    await validate(tenant, review);
    const res = await send(tenant, review, 'minutes', { extra_emails: ['a@example.com'], message: 'Compte rendu validé.' });
    expect(res.status).toBe(200);
    const [, subject, html, options] = lastCall();
    expect(subject).toBe('Compte rendu — Revue de direction « Revue S1 2026 » du 20/09/2026');
    expect(html).toContain('Compte rendu validé.');
    expect(html).toContain('Former deux auditeurs');
    expect(html).toContain('Test Admin');
    expect(options.attachments[0].filename).toBe('Compte-rendu-Revue-S1-2026.pdf');
    expect(options.attachments[0].content.subarray(0, 4).toString()).toBe('%PDF');
    expect((await admin.from('management_review_mailings').select('kind').eq('review_id', review.id)).data[0].kind).toBe('minutes');
  });

  it('droits et isolation : un membre ne peut pas envoyer ; autre entreprise 404 ; catégorie restreinte 404 ; historique caché aux membres', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }, { role: 'manager' }] });
    const other = await newTenant();
    const review = await createReview(tenant);
    expect((await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'] }, tenant.users[0].token)).status).toBe(403);
    expect((await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'] }, other.admin.token)).status).toBe(404);
    expect((await api('post', `/management-reviews/${review.id}/send-minutes`)).status).toBe(401);

    const category = (await api('post', '/module-categories', tenant.admin.token, { resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const restricted = await createReview(tenant, { title: 'Restreinte', category_id: category.id });
    sendEmail.mockClear(); // vide les emails d'invitation de compte envoyés par createTenant
    expect((await send(tenant, restricted, 'convocation', { extra_emails: ['a@example.com'] }, tenant.users[1].token)).status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();

    await send(tenant, review, 'convocation', { extra_emails: ['a@example.com'] });
    expect((await detail(tenant, review, tenant.users[0].token)).body.mailings).toEqual([]);
    expect((await detail(tenant, review)).body.mailings).toHaveLength(1);
  });
});

describe('Planification : fréquence, rappel « à programmer », planning et tableau de bord', () => {
  const setFrequency = (tenant, value, token = tenant.admin.token) => api('patch', '/tenant', token, { management_review_frequency_months: value });
  const schedule = (tenant, token = tenant.admin.token) => api('get', '/management-reviews/schedule', token);
  const planning = async (tenant, token = tenant.admin.token) => (await api('get', '/planning', token)).body.items.filter((item) => item.type.startsWith('management_review'));

  it('la fréquence se règle (admin), avec bornes ; GET /schedule la reflète', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    expect((await schedule(tenant)).body.status).toBe('not_configured');
    expect((await setFrequency(tenant, 0)).status).toBe(200); // 0 / vide = désactive (valeur falsy → null)
    for (const bad of [61, -3, 'beaucoup', 1.5]) expect((await setFrequency(tenant, bad)).status).toBe(400);
    expect((await setFrequency(tenant, 12, tenant.users[0].token)).status).toBe(403);
    const ok = await setFrequency(tenant, 12);
    expect(ok.body.management_review_frequency_months).toBe(12);
    expect((await schedule(tenant)).body).toMatchObject({ frequency_months: 12, status: 'no_review', next_due_date: null });
    expect((await setFrequency(tenant, null)).body.management_review_frequency_months).toBeNull();
  });

  it('dernière revue clôturée + fréquence = prochaine échéance ; en retard → rappel dans le planning ; programmée → le rappel disparaît', async () => {
    const tenant = await newTenant();
    await setFrequency(tenant, 6);
    await closedReview(tenant, { title: 'Ancienne revue', review_date: '2025-01-15' });

    const state = (await schedule(tenant)).body;
    expect(state).toMatchObject({ status: 'overdue', last_completed_date: '2025-01-15', next_due_date: '2025-07-15', scheduled_review: null });
    const due = await planning(tenant);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ type: 'management_review_due', date: '2025-07-15', link: '/management-reviews', is_overdue: true });

    const future = new Date();
    future.setDate(future.getDate() + 20);
    const futureDate = future.toISOString().slice(0, 10);
    const scheduled = await createReview(tenant, { title: 'Prochaine revue', review_date: futureDate });
    expect((await schedule(tenant)).body).toMatchObject({ status: 'scheduled', scheduled_review: { id: scheduled.id, review_date: futureDate } });
    const items = await planning(tenant);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'management_review', id: scheduled.id, date: futureDate, link: `/management-reviews/${scheduled.id}`, is_overdue: false });
    expect(items[0].title).toContain('Prochaine revue');
  });

  it('sans fréquence : aucun rappel ; les revues programmées restent visibles au planning ; les membres ne voient rien', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    await closedReview(tenant, { title: 'Ancienne', review_date: '2020-01-01' });
    expect(await planning(tenant)).toHaveLength(0);
    await setFrequency(tenant, 12);
    expect(await planning(tenant)).toHaveLength(1);
    expect(await planning(tenant, tenant.users[0].token)).toHaveLength(0);
  });

  it('le rappel en retard compte dans le total « en retard » du tableau de bord', async () => {
    const tenant = await newTenant();
    const before = (await api('get', '/dashboard/stats', tenant.admin.token)).body.overdue.total;
    await setFrequency(tenant, 3);
    await closedReview(tenant, { title: 'Ancienne', review_date: '2020-01-01' });
    expect((await api('get', '/dashboard/stats', tenant.admin.token)).body.overdue.total).toBe(before + 1);
  });

  it('une revue programmée en catégorie restreinte n\'est pas révélée à un manager sans accès (donc le rappel reste affiché pour lui)', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    await setFrequency(tenant, 6);
    await closedReview(tenant, { title: 'Ancienne', review_date: '2020-01-01' });
    const category = (await api('post', '/module-categories', tenant.admin.token, { resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const future = new Date();
    future.setDate(future.getDate() + 30);
    await createReview(tenant, { title: 'Confidentielle', review_date: future.toISOString().slice(0, 10), category_id: category.id });

    const asManager = await planning(tenant, tenant.users[0].token);
    expect(asManager.map((item) => item.type)).toEqual(['management_review_due']);
    const asAdmin = await planning(tenant);
    expect(asAdmin.map((item) => item.type)).toEqual(['management_review']);
  });
});
