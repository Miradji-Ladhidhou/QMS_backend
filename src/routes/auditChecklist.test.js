import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { generateAuditChecklist } from '../services/groq.js';
import { cleanQuestions, summarizeChecklist } from '../services/auditChecklist.js';

// L'IA (Groq) est simulée : aucun appel réseau, et on contrôle ce qu'elle « répond ».
vi.mock('../services/groq.js', async (importOriginal) => ({ ...(await importOriginal()), generateAuditChecklist: vi.fn() }));

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};
beforeEach(() => generateAuditChecklist.mockReset());
afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const url = (audit, suffix = '') => `/api/audits/${audit.id}/checklist${suffix}`;

async function createAudit(tenant, extra = {}) {
  const res = await request(app).post('/api/audits').set(auth(tenant.admin.token)).send({ title: 'Audit Achats', audit_type: 'process', planned_date: '2026-11-12', scope: 'Processus achats et réception', ...extra });
  expect(res.status).toBe(201);
  return res.body;
}
const addQuestion = (tenant, audit, question, token = tenant.admin.token) => request(app).post(url(audit, '/items')).set(auth(token)).send({ question });

describe('summarizeChecklist / cleanQuestions', () => {
  const item = (answer) => ({ answer });

  it('taux de conformité = conformes / (conformes + non conformes) ; « sans objet » et sans réponse exclus', () => {
    expect(summarizeChecklist([item('conform'), item('conform'), item('conform'), item('nonconform'), item('na'), item(null)])).toEqual({
      total: 6, answered: 5, conform: 3, nonconform: 1, na: 1, conformity_percent: 75,
    });
    expect(summarizeChecklist([item('na'), item(null)]).conformity_percent).toBeNull();
    expect(summarizeChecklist([]).conformity_percent).toBeNull();
    expect(summarizeChecklist([item('conform'), item('nonconform'), item('nonconform')]).conformity_percent).toBe(33.3);
  });

  it('retire puces et numéros, doublons (casse ignorée), vides, trop longs et types invalides ; ignore l\'existant', () => {
    const result = cleanQuestions(['1. Première ?', '- Deuxième ?', '  Première ?  ', '', '   ', 42, null, 'x'.repeat(501), 'Déjà là ?', 'TROISIÈME ?', 'troisième ?'], ['déjà là ?']);
    expect(result).toEqual(['Première ?', 'Deuxième ?', 'TROISIÈME ?']);
    expect(cleanQuestions('pas un tableau')).toEqual([]);
  });
});

describe('Check-list d\'audit — saisie manuelle et réponses', () => {
  it('ajoute des questions à la suite, enregistre les réponses avec qui/quand, et calcule le bilan', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    const q1 = (await addQuestion(tenant, audit, '  Les bons de commande sont-ils signés ?  ')).body;
    const q2 = (await addQuestion(tenant, audit, 'Les fournisseurs critiques sont-ils évalués ?')).body;
    expect([q1.position, q2.position]).toEqual([1, 2]);
    expect(q1.question).toBe('Les bons de commande sont-ils signés ?');
    expect(q1.source).toBe('manual');
    expect(q1.answer).toBeNull();

    const answered = await request(app).patch(url(audit, `/items/${q1.id}`)).set(auth(tenant.admin.token)).send({ answer: 'conform', observation: '  Vérifié sur 10 commandes.  ' });
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ answer: 'conform', observation: 'Vérifié sur 10 commandes.', answered_by: tenant.admin.id });
    expect(answered.body.answered_at).toBeTruthy();
    await request(app).patch(url(audit, `/items/${q2.id}`)).set(auth(tenant.admin.token)).send({ answer: 'nonconform' }).expect(200);

    const list = await request(app).get(url(audit)).set(auth(tenant.admin.token));
    expect(list.body.items.map((i) => i.position)).toEqual([1, 2]);
    expect(list.body.items[0].answerer.full_name).toBe('Test Admin');
    expect(list.body.summary).toEqual({ total: 2, answered: 2, conform: 1, nonconform: 1, na: 0, conformity_percent: 50 });
  });

  it('retirer la réponse efface qui/quand ; modifier la question garde la réponse ; la position reste à la suite après suppression', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    const q1 = (await addQuestion(tenant, audit, 'Question 1 ?')).body;
    const q2 = (await addQuestion(tenant, audit, 'Question 2 ?')).body;
    await request(app).patch(url(audit, `/items/${q1.id}`)).set(auth(tenant.admin.token)).send({ answer: 'na' });

    const cleared = await request(app).patch(url(audit, `/items/${q1.id}`)).set(auth(tenant.admin.token)).send({ answer: null });
    expect(cleared.body).toMatchObject({ answer: null, answered_by: null, answered_at: null });

    await request(app).patch(url(audit, `/items/${q2.id}`)).set(auth(tenant.admin.token)).send({ answer: 'conform' });
    const renamed = await request(app).patch(url(audit, `/items/${q2.id}`)).set(auth(tenant.admin.token)).send({ question: 'Question 2 reformulée ?' });
    expect(renamed.body).toMatchObject({ question: 'Question 2 reformulée ?', answer: 'conform' });

    await request(app).delete(url(audit, `/items/${q1.id}`)).set(auth(tenant.admin.token)).expect(204);
    const q3 = (await addQuestion(tenant, audit, 'Question 3 ?')).body;
    expect(q3.position).toBe(3); // jamais de réutilisation d'une position déjà prise
    expect((await request(app).delete(url(audit, `/items/${q1.id}`)).set(auth(tenant.admin.token))).status).toBe(404);
  });

  it('bulk : liste collée nettoyée, doublons et questions déjà présentes ignorés ; 400 si rien de nouveau', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    await addQuestion(tenant, audit, 'Déjà présente ?');
    const res = await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: ['1. Nouvelle A ?', '- Nouvelle B ?', 'déjà présente ?', 'Nouvelle A ?', ''] });
    expect(res.status).toBe(201);
    expect(res.body.created.map((i) => i.question)).toEqual(['Nouvelle A ?', 'Nouvelle B ?']);
    expect(res.body.created.map((i) => i.position)).toEqual([2, 3]);

    const nothing = await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: ['Nouvelle A ?', ''] });
    expect(nothing.status).toBe(400);
  });

  it('validations : question vide/trop longue, réponse inconnue, observation trop longue, corps vide → 400', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    const q = (await addQuestion(tenant, audit, 'Question ?')).body;
    expect((await addQuestion(tenant, audit, '   ')).status).toBe(400);
    expect((await addQuestion(tenant, audit, 'x'.repeat(501))).status).toBe(400);
    const patch = (body) => request(app).patch(url(audit, `/items/${q.id}`)).set(auth(tenant.admin.token)).send(body);
    expect((await patch({ answer: 'peut-être' })).status).toBe(400);
    expect((await patch({ observation: 'x'.repeat(2001) })).status).toBe(400);
    expect((await patch({ question: '' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: [] })).status).toBe(400);
    expect((await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: ['Q ?'], source: 'robot' })).status).toBe(400);
  });

  it('une check-list est limitée à 100 questions', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    const first = Array.from({ length: 100 }, (_, i) => `Question ${i + 1} ?`);
    expect((await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: first })).status).toBe(201);
    const over = await addQuestion(tenant, audit, 'La 101e ?');
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/100/);
  });
});

describe('Check-list d\'audit — droits et isolation', () => {
  it('un simple membre lit la check-list mais ne peut ni ajouter, ni répondre, ni supprimer, ni générer', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const [member] = tenant.users;
    const audit = await createAudit(tenant);
    const q = (await addQuestion(tenant, audit, 'Question ?')).body;

    expect((await request(app).get(url(audit)).set(auth(member.token))).status).toBe(200);
    expect((await addQuestion(tenant, audit, 'Autre ?', member.token)).status).toBe(403);
    expect((await request(app).patch(url(audit, `/items/${q.id}`)).set(auth(member.token)).send({ answer: 'conform' })).status).toBe(403);
    expect((await request(app).delete(url(audit, `/items/${q.id}`)).set(auth(member.token))).status).toBe(403);
    expect((await request(app).post(url(audit, '/items/bulk')).set(auth(member.token)).send({ questions: ['A ?'] })).status).toBe(403);
    expect((await request(app).post(url(audit, '/generate')).set(auth(member.token)).send({})).status).toBe(403);
    expect(generateAuditChecklist).not.toHaveBeenCalled();
  });

  it('sans authentification : 401', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    expect((await request(app).get(url(audit))).status).toBe(401);
    expect((await request(app).post(url(audit, '/items')).send({ question: 'Q ?' })).status).toBe(401);
  });

  it('une autre entreprise reçoit 404 partout et ne modifie rien', async () => {
    const owner = await newTenant();
    const intruder = await newTenant();
    const audit = await createAudit(owner);
    const q = (await addQuestion(owner, audit, 'Question ?')).body;
    const asIntruder = (req) => req.set(auth(intruder.admin.token));

    expect((await asIntruder(request(app).get(url(audit)))).status).toBe(404);
    expect((await asIntruder(request(app).post(url(audit, '/items'))).send({ question: 'Piratage ?' })).status).toBe(404);
    expect((await asIntruder(request(app).post(url(audit, '/items/bulk'))).send({ questions: ['A ?'] })).status).toBe(404);
    expect((await asIntruder(request(app).patch(url(audit, `/items/${q.id}`))).send({ answer: 'nonconform' })).status).toBe(404);
    expect((await asIntruder(request(app).delete(url(audit, `/items/${q.id}`)))).status).toBe(404);
    expect((await asIntruder(request(app).post(url(audit, '/generate'))).send({})).status).toBe(404);
    expect(generateAuditChecklist).not.toHaveBeenCalled();

    const { data } = await admin.from('audit_checklist_items').select('answer').eq('id', q.id).single();
    expect(data.answer).toBeNull();
  });

  it('une question d\'un AUTRE audit ne se modifie pas via l\'URL d\'un audit voisin', async () => {
    const tenant = await newTenant();
    const auditA = await createAudit(tenant);
    const auditB = await createAudit(tenant, { title: 'Audit B' });
    const qA = (await addQuestion(tenant, auditA, 'Question de A ?')).body;
    expect((await request(app).patch(url(auditB, `/items/${qA.id}`)).set(auth(tenant.admin.token)).send({ answer: 'conform' })).status).toBe(404);
    expect((await request(app).delete(url(auditB, `/items/${qA.id}`)).set(auth(tenant.admin.token))).status).toBe(404);
  });

  it('audit en catégorie restreinte : un manager sans accès reçoit 404 ; l\'admin y accède', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const [manager] = tenant.users;
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'audit', name: 'Confidentiel', is_restricted: true })).body;
    const audit = await createAudit(tenant, { category_id: category.id });
    await addQuestion(tenant, audit, 'Question ?');

    expect((await request(app).get(url(audit)).set(auth(manager.token))).status).toBe(404);
    expect((await addQuestion(tenant, audit, 'Autre ?', manager.token)).status).toBe(404);
    expect((await request(app).get(url(audit)).set(auth(tenant.admin.token))).status).toBe(200);
  });

  it('supprimer l\'audit supprime sa check-list', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    const q = (await addQuestion(tenant, audit, 'Question ?')).body;
    await request(app).delete(`/api/audits/${audit.id}`).set(auth(tenant.admin.token)).expect(204);
    const { data } = await admin.from('audit_checklist_items').select('id').eq('id', q.id);
    expect(data).toHaveLength(0);
  });
});

describe('Génération de la check-list par l\'IA', () => {
  const generate = (tenant, audit, body = {}, token = tenant.admin.token) => request(app).post(url(audit, '/generate')).set(auth(token)).send(body);

  it('transmet le contexte de l\'audit, nettoie les questions, ne persiste RIEN ; les questions retenues s\'ajoutent avec source « ai »', async () => {
    const tenant = await newTenant();
    const service = (await request(app).post('/api/services').set(auth(tenant.admin.token)).send({ name: 'Réception' })).body;
    const audit = await createAudit(tenant, { service_id: service.id });
    await request(app).post(`/api/audits/${audit.id}/findings`).set(auth(tenant.admin.token)).send({ type: 'minor_nc', description: 'Bon de réception non signé' }).expect(201);
    await addQuestion(tenant, audit, 'Les livraisons sont-elles contrôlées ?');

    generateAuditChecklist.mockResolvedValue({ questions: ['1. Les réceptions sont-elles enregistrées ?', 'Les livraisons sont-elles contrôlées ?', '- Les écarts sont-ils traités ?', ''] });
    const res = await generate(tenant, audit, { count: 5 });

    expect(res.status).toBe(200);
    // « Les livraisons sont-elles contrôlées ? » existe déjà : jamais reproposée.
    expect(res.body.questions).toEqual(['Les réceptions sont-elles enregistrées ?', 'Les écarts sont-ils traités ?']);
    const context = generateAuditChecklist.mock.calls[0][0];
    expect(context).toMatchObject({
      title: 'Audit Achats',
      typeLabel: 'Audit de processus',
      scope: 'Processus achats et réception',
      service: 'Réception',
      count: 5,
      existingQuestions: ['Les livraisons sont-elles contrôlées ?'],
    });
    expect(context.findings).toEqual([{ type: 'minor_nc', description: 'Bon de réception non signé' }]);

    // Rien n'a été enregistré par la génération elle-même.
    expect((await request(app).get(url(audit)).set(auth(tenant.admin.token))).body.items).toHaveLength(1);

    const saved = await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: res.body.questions, source: 'ai' });
    expect(saved.status).toBe(201);
    expect(saved.body.created.every((i) => i.source === 'ai')).toBe(true);
  });

  it('nombre par défaut 10 ; hors 3–25 → 400 sans appeler l\'IA', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    generateAuditChecklist.mockResolvedValue({ questions: ['Q ?'] });
    await generate(tenant, audit);
    expect(generateAuditChecklist.mock.calls[0][0].count).toBe(10);

    generateAuditChecklist.mockClear();
    for (const count of [2, 26, 'beaucoup']) expect((await generate(tenant, audit, { count })).status).toBe(400);
    expect(generateAuditChecklist).not.toHaveBeenCalled();
  });

  it('plafonne au nombre demandé même si l\'IA en renvoie trop', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);
    generateAuditChecklist.mockResolvedValue({ questions: Array.from({ length: 20 }, (_, i) => `Question ${i + 1} ?`) });
    const res = await generate(tenant, audit, { count: 5 });
    expect(res.body.questions).toHaveLength(5);
  });

  it('IA en échec ou réponse inexploitable : 503 avec un message, aucune question enregistrée', async () => {
    const tenant = await newTenant();
    const audit = await createAudit(tenant);

    generateAuditChecklist.mockRejectedValue(new Error('Quota Groq dépassé : réessayez plus tard.'));
    const failed = await generate(tenant, audit);
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain('Quota Groq dépassé');

    for (const bad of [{ questions: [] }, { questions: 'texte' }, {}, null, { questions: [42, '', null] }]) {
      generateAuditChecklist.mockResolvedValue(bad);
      const res = await generate(tenant, audit);
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/aucune question exploitable/);
    }
    expect((await request(app).get(url(audit)).set(auth(tenant.admin.token))).body.items).toHaveLength(0);
  });
});

describe('Export PDF de l\'audit', () => {
  const pdf = (tenant, audit, token = tenant.admin.token) => request(app).get(`/api/audits/${audit.id}/pdf`).set(auth(token)).responseType('blob');

  it('PDF valide pour un audit complet (constats, check-list répondue, auditeur), et pour un audit vide', async () => {
    const tenant = await newTenant();
    const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Audit interne', qualifies_internal_auditor: true })).body;
    await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: '2026-03-01' }).expect(201);

    const audit = await createAudit(tenant, { lead_auditor: tenant.admin.id, conclusion: 'Processus globalement maîtrisé.' });
    await request(app).post(`/api/audits/${audit.id}/findings`).set(auth(tenant.admin.token)).send({ type: 'major_nc', description: 'Aucune évaluation des fournisseurs critiques depuis 2 ans.' }).expect(201);
    const qs = (await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: Array.from({ length: 30 }, (_, i) => `Question d'audit numéro ${i + 1}, assez longue pour occuper de la place sur la page ?`) })).body.created;
    await request(app).patch(url(audit, `/items/${qs[0].id}`)).set(auth(tenant.admin.token)).send({ answer: 'conform', observation: 'OK sur échantillon.' });
    await request(app).patch(url(audit, `/items/${qs[1].id}`)).set(auth(tenant.admin.token)).send({ answer: 'nonconform' });

    const res = await pdf(tenant, audit);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('%PDF');

    const empty = await createAudit(tenant, { title: 'Audit vide' });
    const emptyRes = await pdf(tenant, empty);
    expect(emptyRes.status).toBe(200);
    expect(Buffer.from(emptyRes.body).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('404 pour un audit inexistant, d\'une autre entreprise ou en catégorie restreinte inaccessible ; 401 sans authentification', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const other = await newTenant();
    const audit = await createAudit(tenant);
    expect((await pdf(other, audit)).status).toBe(404);
    expect((await request(app).get('/api/audits/00000000-0000-4000-8000-000000000000/pdf').set(auth(tenant.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/audits/${audit.id}/pdf`)).status).toBe(401);

    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'audit', name: 'Confidentiel', is_restricted: true })).body;
    const restricted = await createAudit(tenant, { title: 'Restreint', category_id: category.id });
    expect((await pdf(tenant, restricted, tenant.users[0].token)).status).toBe(404);
    expect((await pdf(tenant, restricted)).status).toBe(200);
  });
});

describe('Exports Word et Excel de l\'audit', () => {
  async function auditWithContent(tenant) {
    const audit = await createAudit(tenant, { lead_auditor: tenant.admin.id });
    // La conclusion se renseigne à la modification de l'audit, pas à sa création.
    await request(app).patch(`/api/audits/${audit.id}`).set(auth(tenant.admin.token)).send({ conclusion: 'Processus maîtrisé.' }).expect(200);
    await request(app).post(`/api/audits/${audit.id}/findings`).set(auth(tenant.admin.token)).send({ type: 'minor_nc', description: 'Bon de réception non signé.' }).expect(201);
    const created = (await request(app).post(url(audit, '/items/bulk')).set(auth(tenant.admin.token)).send({ questions: ['Les bons sont-ils signés ?', 'Les fournisseurs sont-ils évalués ?', 'Les écarts sont-ils traités ?'] })).body.created;
    await request(app).patch(url(audit, `/items/${created[0].id}`)).set(auth(tenant.admin.token)).send({ answer: 'conform', observation: 'OK sur 10 bons.' });
    await request(app).patch(url(audit, `/items/${created[1].id}`)).set(auth(tenant.admin.token)).send({ answer: 'nonconform' });
    return audit;
  }

  it('Word : document vertical avec périmètre, conclusion, constats, check-list, réponses et taux', async () => {
    const tenant = await newTenant();
    const audit = await auditWithContent(tenant);
    const res = await request(app).get(`/api/audits/${audit.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    for (const expected of ['Audit Achats', 'Processus achats et réception', 'Processus maîtrisé.', 'Bon de réception non signé.', 'Les bons sont-ils signés ?', 'OK sur 10 bons.', 'Conforme', 'Non conforme', 'Non répondue', 'Taux de conformité : 50 %', 'Check-list d\'audit (3 questions)']) {
      expect(text).toContain(expected);
    }
  });

  it('Excel : onglets Audit, Constats et Check-list (une ligne par question) avec le taux de conformité', async () => {
    const tenant = await newTenant();
    const audit = await auditWithContent(tenant);
    const res = await request(app).get(`/api/audits/${audit.id}/xlsx`).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(res.body));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Audit', 'Constats', 'Check-list']);

    const fields = Object.fromEntries(workbook.getWorksheet('Audit').getSheetValues().filter(Array.isArray).map((row) => [row[1], row[2]]));
    expect(fields['Taux de conformité (%)']).toBe(50);
    expect(fields['Questions de la check-list']).toBe(3);
    expect(fields.Constats).toBe(1);

    const checklist = workbook.getWorksheet('Check-list');
    expect(checklist.rowCount).toBe(4); // en-tête + 3 questions
    expect(checklist.getRow(2).getCell(2).value).toBe('Les bons sont-ils signés ?');
    expect(checklist.getRow(2).getCell(3).value).toBe('Conforme');
    expect(checklist.getRow(4).getCell(3).value).toBe('Non répondue');
  });

  it('exports vides et accès : audit sans contenu OK ; 404 autre entreprise ; 401 sans authentification', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const empty = await createAudit(tenant, { title: 'Vide', scope: undefined });
    for (const format of ['word', 'xlsx']) {
      expect((await request(app).get(`/api/audits/${empty.id}/${format}`).set(auth(tenant.admin.token)).responseType('blob')).status).toBe(200);
      expect((await request(app).get(`/api/audits/${empty.id}/${format}`).set(auth(other.admin.token))).status).toBe(404);
      expect((await request(app).get(`/api/audits/${empty.id}/${format}`)).status).toBe(401);
    }
  });
});
