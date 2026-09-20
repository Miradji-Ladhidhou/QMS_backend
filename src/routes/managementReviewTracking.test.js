import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { generateManagementReviewDraft } from '../services/groq.js';
import { effectiveActionStatus, buildInputBlocks, describeAction } from '../services/managementReviewContent.js';

// L'IA (Groq) est simulée : aucun appel réseau, et on contrôle ce qu'elle « répond ».
vi.mock('../services/groq.js', async (importOriginal) => ({ ...(await importOriginal()), generateManagementReviewDraft: vi.fn() }));

let tenants = [];
const newTenant = async (options) => {
  const created = await createTenant(options);
  tenants.push(created);
  return created;
};
beforeEach(() => generateManagementReviewDraft.mockReset());
afterEach(async () => {
  for (const tenant of tenants) await tenant.cleanup();
  tenants = [];
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const createReview = async (tenant, extra = {}) => {
  const res = await request(app).post('/api/management-reviews').set(auth(tenant.admin.token)).send({ title: 'Revue S1 2026', review_date: '2026-08-01', ...extra });
  expect(res.status).toBe(201);
  return res.body;
};
const addAction = (tenant, review, body, token = tenant.admin.token) => request(app).post(`/api/management-reviews/${review.id}/actions`).set(auth(token)).send({ description: 'Former les auditeurs', ...body });
const patchAction = (tenant, review, action, body, token = tenant.admin.token) =>
  request(app).patch(`/api/management-reviews/${review.id}/actions/${action.id}`).set(auth(token)).send(body);
const getReview = (tenant, review, token = tenant.admin.token) => request(app).get(`/api/management-reviews/${review.id}`).set(auth(token));
const complete = (review) => admin.from('management_reviews').update({ status: 'completed' }).eq('id', review.id);

describe('effectiveActionStatus / buildInputBlocks / describeAction', () => {
  it('une CAPA liée clôturée rend l\'action réalisée (déduit) ; le retard ne vaut que pour une action en cours', () => {
    expect(effectiveActionStatus({ status: 'open', due_date: '2026-01-01' }, '2026-06-01')).toEqual({ status: 'open', derived: false, overdue: true });
    expect(effectiveActionStatus({ status: 'in_progress', due_date: '2026-06-01' }, '2026-06-01').overdue).toBe(false);
    expect(effectiveActionStatus({ status: 'done', due_date: '2020-01-01' }, '2026-06-01').overdue).toBe(false);
    expect(effectiveActionStatus({ status: 'cancelled', due_date: '2020-01-01' }, '2026-06-01').overdue).toBe(false);
    expect(effectiveActionStatus({ status: 'open', due_date: '2020-01-01', linked_capa: { status: 'closed' } }, '2026-06-01')).toEqual({ status: 'done', derived: true, overdue: false });
    expect(effectiveActionStatus({ status: 'open', due_date: null }, '2026-06-01').overdue).toBe(false);
  });

  it('lit les données d\'entrée de la période et l\'état à la clôture', () => {
    const blocks = buildInputBlocks({
      input_snapshot: {
        period: { start: '2026-01-01', end: '2026-06-30' },
        kpi_trend: [{ name: 'Taux de service', unit: '%', current_avg: 93.456, target: 95, target_direction: 'min', trend: 'down' }],
        audits_period: { count: 2, findings_by_type: { major_nc: 1, minor_nc: 3 } },
        complaints_period: { received: 5, still_open: 2 },
        capas_period: { in_progress: 4, closed_in_period: 7, on_time_closure_rate: null },
        risks_open: { low: 1, critical: 2 },
      },
      snapshot: { generated_at: '2026-07-01T10:00:00Z', capas: { open: 2, in_progress: 1, overdue: 1 }, audits: { planned: 1, in_progress: 1 }, kpis: { off_target: 3 }, documents: { to_review: 4 }, trainings: { to_renew: 5 } },
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('Taux de service : 93.5 % (objectif ≥ 95 %), en baisse');
    expect(text).toContain('NC majeures : 1');
    expect(text).toContain('5 reçue(s), dont 2 encore ouverte(s)');
    expect(text).toContain('Taux de clôture dans les délais : —');
    expect(text).toContain('CAPA ouvertes : 3 dont 1 en retard');
    expect(buildInputBlocks({})).toEqual([]);
  });

  it('describeAction résume statut, responsable, échéance et CAPA', () => {
    expect(describeAction({ description: 'Former', status: 'open', effective_status: 'open', owner_user: { full_name: 'Marie' }, due_date: '2026-09-30', is_overdue: true, linked_capa: { number: 'CAPA-1' } })).toBe(
      'Former — À faire, responsable : Marie, échéance 30/09/2026 (dépassée), CAPA CAPA-1'
    );
  });
});

describe('Actions de revue — responsable, échéance, statut', () => {
  it('création avec suivi ; valeurs par défaut ; source', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const review = await createReview(tenant);
    const [manager] = tenant.users;

    const plain = await addAction(tenant, review, {});
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({ status: 'open', owner: null, due_date: null, source: 'manual', effective_status: 'open', is_overdue: false });

    const full = await addAction(tenant, review, { owner: manager.id, due_date: '2026-12-31', status: 'in_progress', source: 'ai' });
    expect(full.body).toMatchObject({ owner: manager.id, due_date: '2026-12-31', status: 'in_progress', source: 'ai' });
    expect(full.body.owner_user.full_name).toBe('Test manager');
  });

  it('validations : statut, échéance, source, responsable inconnu ou d\'une autre entreprise → 400', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const review = await createReview(tenant);
    expect((await addAction(tenant, review, { status: 'terminé' })).status).toBe(400);
    expect((await addAction(tenant, review, { due_date: 'demain' })).status).toBe(400);
    expect((await addAction(tenant, review, { source: 'robot' })).status).toBe(400);
    expect((await addAction(tenant, review, { owner: 'pas-un-uuid' })).status).toBe(400);
    expect((await addAction(tenant, review, { owner: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await addAction(tenant, review, { owner: other.admin.id })).status).toBe(400);
    expect((await addAction(tenant, review, { description: '  ' })).status).toBe(400);
  });

  it('PATCH champ par champ ; « réalisée » date l\'action, en sortir efface la date ; corps vide → 400', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const review = await createReview(tenant);
    const action = (await addAction(tenant, review, {})).body;

    expect((await patchAction(tenant, review, action, { owner: tenant.users[0].id })).body.owner).toBe(tenant.users[0].id);
    expect((await patchAction(tenant, review, action, { due_date: '2026-10-15' })).body.due_date).toBe('2026-10-15');
    const done = await patchAction(tenant, review, action, { status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.completed_at).toBeTruthy();
    const reopened = await patchAction(tenant, review, action, { status: 'in_progress' });
    expect(reopened.body.completed_at).toBeNull();
    // Retirer responsable et échéance.
    const cleared = await patchAction(tenant, review, action, { owner: null, due_date: null });
    expect(cleared.body).toMatchObject({ owner: null, due_date: null });
    // La description reste modifiable ; vide refusée.
    expect((await patchAction(tenant, review, action, { description: 'Nouveau texte' })).body.description).toBe('Nouveau texte');
    expect((await patchAction(tenant, review, action, { description: ' ' })).status).toBe(400);
    expect((await patchAction(tenant, review, action, {})).status).toBe(400);
    expect((await patchAction(tenant, review, action, { status: 'nope' })).status).toBe(400);
  });

  it('droits et isolation : un membre ne crée ni ne modifie ; une autre entreprise reçoit 404', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const review = await createReview(tenant);
    const action = (await addAction(tenant, review, {})).body;
    expect((await addAction(tenant, review, {}, tenant.users[0].token)).status).toBe(403);
    expect((await patchAction(tenant, review, action, { status: 'done' }, tenant.users[0].token)).status).toBe(403);
    expect((await patchAction(tenant, review, action, { status: 'done' }, other.admin.token)).status).toBe(404);
    expect((await addAction(other, review, {}, other.admin.token)).status).toBe(404);
    expect((await admin.from('management_review_actions').select('status').eq('id', action.id).single()).data.status).toBe('open');
  });

  it('la CAPA liée clôturée rend l\'action « réalisée » (dérivé) ; une échéance passée la marque en retard', async () => {
    const tenant = await newTenant();
    const review = await createReview(tenant);
    const late = (await addAction(tenant, review, { due_date: '2020-01-01', description: 'En retard' })).body;
    expect(late.is_overdue).toBe(true);

    const withCapa = (await addAction(tenant, review, { due_date: '2020-01-01', description: 'Avec CAPA' })).body;
    const capa = (await request(app).post('/api/capas').set(auth(tenant.admin.token)).send({ title: 'CAPA liée', description: 'x', origin: 'Revue' })).body;
    await admin.from('management_review_actions').update({ linked_capa_id: capa.id }).eq('id', withCapa.id);
    await admin.from('capas').update({ status: 'closed' }).eq('id', capa.id);

    const detail = (await getReview(tenant, review)).body;
    const derived = detail.actions.find((a) => a.id === withCapa.id);
    expect(derived).toMatchObject({ status: 'open', effective_status: 'done', status_derived: true, is_overdue: false });
    expect(detail.actions.find((a) => a.id === late.id).is_overdue).toBe(true);
  });
});

describe('Revue précédente — suivi automatique des actions', () => {
  it('reprend la revue CLÔTURÉE la plus récente antérieure, avec ses actions et leur état', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const older = await createReview(tenant, { title: 'Revue 2025', review_date: '2025-02-01' });
    const previous = await createReview(tenant, { title: 'Revue S2 2025', review_date: '2025-09-01' });
    const draftBetween = await createReview(tenant, { title: 'Brouillon', review_date: '2026-01-01' });
    const current = await createReview(tenant, { title: 'Revue S1 2026', review_date: '2026-08-01' });
    await complete(older);
    await complete(previous);
    await addAction(tenant, previous, { description: 'Action A', owner: tenant.users[0].id, due_date: '2026-03-01', status: 'done' });
    await addAction(tenant, previous, { description: 'Action B', due_date: '2020-01-01' });

    const detail = (await getReview(tenant, current)).body;
    expect(detail.previous_review).toMatchObject({ id: previous.id, title: 'Revue S2 2025' });
    const [a, b] = detail.previous_review.actions;
    expect(a).toMatchObject({ description: 'Action A', effective_status: 'done', is_overdue: false });
    expect(a.owner_user.full_name).toBe('Test manager');
    expect(b).toMatchObject({ description: 'Action B', effective_status: 'open', is_overdue: true });
    // Un brouillon n'est jamais « la revue précédente ».
    expect(detail.previous_review.id).not.toBe(draftBetween.id);
  });

  it('aucune revue précédente clôturée, ou même date : null ; jamais la revue elle-même', async () => {
    const tenant = await newTenant();
    const only = await createReview(tenant);
    expect((await getReview(tenant, only)).body.previous_review).toBeNull();
    await complete(only);
    const sameDate = await createReview(tenant, { title: 'Même jour' });
    expect((await getReview(tenant, sameDate)).body.previous_review).toBeNull();
    expect((await getReview(tenant, only)).body.previous_review).toBeNull();
  });

  it('une revue précédente en catégorie restreinte n\'est pas révélée à un manager sans accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const previous = await createReview(tenant, { title: 'Revue confidentielle', review_date: '2025-09-01', category_id: category.id });
    await complete(previous);
    await addAction(tenant, previous, { description: 'Secret' });
    const current = await createReview(tenant, { title: 'Revue courante' });

    const asManager = await getReview(tenant, current, tenant.users[0].token);
    expect(asManager.status).toBe(200);
    expect(asManager.body.previous_review).toBeNull();
    expect((await getReview(tenant, current)).body.previous_review.id).toBe(previous.id);
  });
});

describe('Planning et tableau de bord', () => {
  it('l\'action apparaît dans le planning de son responsable (échéance, lien vers la revue), pas si réalisée ou sans échéance', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }, { role: 'member' }] });
    const [owner, stranger] = tenant.users;
    const review = await createReview(tenant, { title: 'Revue S1' });
    const planned = (await addAction(tenant, review, { owner: owner.id, due_date: '2020-05-05', description: 'Action à suivre' })).body;
    await addAction(tenant, review, { owner: owner.id, due_date: '2026-12-01', status: 'done', description: 'Déjà faite' });
    await addAction(tenant, review, { owner: owner.id, description: 'Sans échéance' });
    await addAction(tenant, review, { due_date: '2026-12-01', description: 'Sans responsable' });

    const mine = (await request(app).get('/api/planning').set(auth(owner.token))).body.items.filter((i) => i.type === 'review_action');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: planned.id, date: '2020-05-05', link: `/management-reviews/${review.id}`, is_overdue: true });
    expect(mine[0].title).toContain('Revue S1');
    expect(mine[0].title).toContain('Action à suivre');

    expect((await request(app).get('/api/planning').set(auth(stranger.token))).body.items.filter((i) => i.type === 'review_action')).toHaveLength(0);
    // L'admin (vue entreprise) voit les actions avec échéance non réalisées, y compris sans responsable.
    const all = (await request(app).get('/api/planning').set(auth(tenant.admin.token))).body.items.filter((i) => i.type === 'review_action');
    expect(all).toHaveLength(2);
  });

  it('une action en retard compte dans le total « en retard » du tableau de bord', async () => {
    const tenant = await newTenant();
    const review = await createReview(tenant);
    const before = (await request(app).get('/api/dashboard/stats').set(auth(tenant.admin.token))).body.overdue.total;
    await addAction(tenant, review, { due_date: '2020-01-01' });
    const after = (await request(app).get('/api/dashboard/stats').set(auth(tenant.admin.token))).body.overdue.total;
    expect(after).toBe(before + 1);
  });

  it('planning d\'une revue en catégorie restreinte : invisible pour un manager sans accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const review = await createReview(tenant, { category_id: category.id });
    await addAction(tenant, review, { owner: tenant.users[0].id, due_date: '2030-01-01' });
    expect((await request(app).get('/api/planning').set(auth(tenant.users[0].token))).body.items.filter((i) => i.type === 'review_action')).toHaveLength(0);
    expect((await request(app).get('/api/planning').set(auth(tenant.admin.token))).body.items.filter((i) => i.type === 'review_action')).toHaveLength(1);
  });
});

describe('Exports de la revue (PDF, Word, Excel)', () => {
  async function richReview(tenant) {
    const previous = await createReview(tenant, { title: 'Revue S2 2025', review_date: '2025-09-01' });
    await complete(previous);
    await addAction(tenant, previous, { description: 'Renouveler les habilitations', due_date: '2026-03-01', status: 'done' });
    const review = await createReview(tenant, { title: 'Revue S1 2026', participants: 'Direction, Qualité', period_start: '2026-01-01', period_end: '2026-06-30' });
    await request(app)
      .patch(`/api/management-reviews/${review.id}`)
      .set(auth(tenant.admin.token))
      .send({ context_changes: 'Nouveau client majeur.', conclusions: 'Système adapté.', improvement_opportunities: 'Digitaliser les contrôles.', previous_actions_status: 'Toutes réalisées.' })
      .expect(200);
    await addAction(tenant, review, { description: 'Former deux auditeurs', due_date: '2026-11-30', owner: tenant.admin.id });
    return review;
  }

  it('PDF valide ; Word avec toutes les rubriques et les actions ; Excel en 4 onglets', async () => {
    const tenant = await newTenant();
    const review = await richReview(tenant);

    const pdf = await request(app).get(`/api/management-reviews/${review.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');

    const word = await request(app).get(`/api/management-reviews/${review.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
    expect(word.status).toBe(200);
    const { value: text } = await mammoth.extractRawText({ buffer: Buffer.from(word.body) });
    for (const expected of ['Revue S1 2026', 'Direction, Qualité', 'Éléments d\'entrée', 'Revue précédente : Revue S2 2025', 'Renouveler les habilitations', 'Réalisée', 'Toutes réalisées.', 'Nouveau client majeur.', 'Digitaliser les contrôles.', 'Système adapté.', 'Former deux auditeurs', 'Test Admin']) {
      expect(text).toContain(expected);
    }

    const xlsx = await request(app).get(`/api/management-reviews/${review.id}/xlsx`).set(auth(tenant.admin.token)).responseType('blob');
    expect(xlsx.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(xlsx.body));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Revue', 'Entrées', 'Actions', 'Revue précédente']);
    expect(workbook.getWorksheet('Actions').getRow(2).getCell(2).value).toBe('Former deux auditeurs');
    expect(workbook.getWorksheet('Revue précédente').getRow(2).getCell(5).value).toBe('Réalisée');
  });

  it('revue vide : les trois exports fonctionnent ; 404 autre entreprise / catégorie restreinte ; 401 sans authentification', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const other = await newTenant();
    const empty = await createReview(tenant, { title: 'Vide' });
    for (const format of ['pdf', 'word', 'xlsx']) {
      expect((await request(app).get(`/api/management-reviews/${empty.id}/${format}`).set(auth(tenant.admin.token)).responseType('blob')).status).toBe(200);
      expect((await request(app).get(`/api/management-reviews/${empty.id}/${format}`).set(auth(other.admin.token))).status).toBe(404);
      expect((await request(app).get(`/api/management-reviews/${empty.id}/${format}`)).status).toBe(401);
    }
    const category = (await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'management_review', name: 'Direction', is_restricted: true })).body;
    const restricted = await createReview(tenant, { title: 'Restreinte', category_id: category.id });
    expect((await request(app).get(`/api/management-reviews/${restricted.id}/pdf`).set(auth(tenant.users[0].token))).status).toBe(404);
    expect((await request(app).get(`/api/management-reviews/${restricted.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob')).status).toBe(200);
  });
});

describe('Brouillon IA des conclusions', () => {
  const draft = (tenant, review, token = tenant.admin.token) => request(app).post(`/api/management-reviews/${review.id}/ai-draft`).set(auth(token)).send({});

  async function reviewWithPeriod(tenant) {
    return createReview(tenant, { period_start: '2026-01-01', period_end: '2026-06-30', participants: 'Direction' });
  }

  it('transmet les éléments d\'entrée et le suivi des actions précédentes, nettoie la proposition, ne persiste RIEN', async () => {
    const tenant = await newTenant();
    const previous = await createReview(tenant, { title: 'Revue S2 2025', review_date: '2025-09-01' });
    await complete(previous);
    await addAction(tenant, previous, { description: 'Renouveler les habilitations', status: 'done' });
    const review = await reviewWithPeriod(tenant);
    await addAction(tenant, review, { description: 'Déjà décidée' });

    generateManagementReviewDraft.mockResolvedValue({
      conclusions: '  Le système reste adapté.  ',
      improvement_opportunities: '- Digitaliser les contrôles',
      decisions: ['1. Former deux auditeurs', '- Déjà décidée', 'former deux auditeurs', '', 42, 'Relancer les fournisseurs en retard'],
    });
    const res = await draft(tenant, review);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      conclusions: 'Le système reste adapté.',
      improvement_opportunities: '- Digitaliser les contrôles',
      decisions: ['Former deux auditeurs', 'Relancer les fournisseurs en retard'],
    });
    const context = generateManagementReviewDraft.mock.calls[0][0];
    expect(context).toContain('Revue S1 2026');
    expect(context).toContain("ÉLÉMENTS D'ENTRÉE");
    expect(context).toContain('Période analysée');
    expect(context).toContain('Renouveler les habilitations — Réalisée');
    expect(context).toContain('Actions déjà décidées : Déjà décidée');

    // Rien n'a été enregistré : ni conclusions, ni nouvelle action.
    const after = (await getReview(tenant, review)).body;
    expect(after.conclusions).toBeNull();
    expect(after.actions).toHaveLength(1);
  });

  it('sans donnée d\'entrée (pas de période) : 400 sans appeler l\'IA', async () => {
    const tenant = await newTenant();
    const review = await createReview(tenant);
    const res = await draft(tenant, review);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/période/);
    expect(generateManagementReviewDraft).not.toHaveBeenCalled();
  });

  it('IA en échec ou réponse inexploitable : 503, jamais de 500', async () => {
    const tenant = await newTenant();
    const review = await reviewWithPeriod(tenant);
    generateManagementReviewDraft.mockRejectedValue(new Error('Quota Groq dépassé : réessayez plus tard.'));
    const failed = await draft(tenant, review);
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain('Quota Groq dépassé');
    for (const bad of [{}, null, { conclusions: '', decisions: [] }, { decisions: 'texte' }]) {
      generateManagementReviewDraft.mockResolvedValue(bad);
      expect((await draft(tenant, review)).status).toBe(503);
    }
  });

  it('réservé admin/manager ; 404 autre entreprise ; 401 sans authentification', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const review = await reviewWithPeriod(tenant);
    generateManagementReviewDraft.mockResolvedValue({ conclusions: 'x' });
    expect((await draft(tenant, review, tenant.users[0].token)).status).toBe(403);
    expect((await draft(tenant, review, other.admin.token)).status).toBe(404);
    expect((await request(app).post(`/api/management-reviews/${review.id}/ai-draft`)).status).toBe(401);
    expect(generateManagementReviewDraft).not.toHaveBeenCalled();
  });
});
