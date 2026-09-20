import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { renderTemplate } from '../services/renderTemplate.js';
import { sendImmediateNotification } from '../services/notificationHelpers.js';
import { getRiskReviewAlerts } from '../jobs/notificationJob.js';
import { isReminderMilestone, reviewState } from '../services/riskAssessments.js';

const tenants = [];
afterEach(async () => {
  while (tenants.length) await tenants.pop().cleanup();
});

async function newTenant(options) {
  const tenant = await createTenant(options);
  tenants.push(tenant);
  return tenant;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function isoDate(daysFromToday) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

async function makeRisk(tenant, overrides = {}) {
  const res = await request(app)
    .post('/api/risks')
    .set(auth(tenant.admin.token))
    .send({ title: 'Dépendance à un fournisseur unique', likelihood: 4, impact: 3, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

const patchRisk = (tenant, id, body, token = tenant.admin.token) => request(app).patch(`/api/risks/${id}`).set(auth(token)).send(body);
const getAssessments = async (tenant, id) => (await request(app).get(`/api/risks/${id}/assessments`).set(auth(tenant.admin.token))).body;

describe('Historique de cotation', () => {
  it('écrit une ligne à la création, puis une par changement de cotation / résiduel / statut — jamais pour un simple changement de titre', async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant);

    let history = await getAssessments(tenant, risk.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ likelihood: 4, impact: 3, score: 12, status: 'identified', reason: 'Cotation initiale' });
    expect(history[0].residual_score).toBeNull();

    await patchRisk(tenant, risk.id, { title: 'Nouveau titre' });
    expect(await getAssessments(tenant, risk.id)).toHaveLength(1);

    await patchRisk(tenant, risk.id, { likelihood: 2, change_reason: 'Second fournisseur qualifié' });
    await patchRisk(tenant, risk.id, { residual_likelihood: 1, residual_impact: 2, status: 'treating' });

    history = await getAssessments(tenant, risk.id);
    expect(history).toHaveLength(3);
    expect(history[1]).toMatchObject({ likelihood: 2, impact: 3, score: 6, reason: 'Second fournisseur qualifié' });
    expect(history[1].assessed_by_user.full_name).toBeTruthy();
    expect(history[2]).toMatchObject({ residual_likelihood: 1, residual_impact: 2, residual_score: 2, status: 'treating' });
  });

  it("un patch qui remet la même valeur n'ajoute rien ; un motif trop long est refusé", async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant);
    await patchRisk(tenant, risk.id, { likelihood: 4, impact: 3 });
    expect(await getAssessments(tenant, risk.id)).toHaveLength(1);
    expect((await patchRisk(tenant, risk.id, { likelihood: 1, change_reason: 'x'.repeat(501) })).status).toBe(400);
  });

  it('un member peut lire l’historique ; un autre tenant reçoit 404', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const risk = await makeRisk(tenant);
    expect((await request(app).get(`/api/risks/${risk.id}/assessments`).set(auth(tenant.users[0].token))).status).toBe(200);
    expect((await request(app).get(`/api/risks/${risk.id}/assessments`).set(auth(other.admin.token))).status).toBe(404);
  });
});

describe("Seuil d'acceptabilité", () => {
  it('10 par défaut ; modifiable par un admin seulement, entre 2 et 25', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    expect((await request(app).get('/api/risks/settings').set(auth(manager.token))).body).toEqual({ unacceptable_score: 10 });

    expect((await request(app).patch('/api/risks/settings').set(auth(manager.token)).send({ unacceptable_score: 15 })).status).toBe(403);
    for (const bad of [1, 26, 'abc', undefined]) {
      expect((await request(app).patch('/api/risks/settings').set(auth(tenant.admin.token)).send({ unacceptable_score: bad })).status).toBe(400);
    }
    const ok = await request(app).patch('/api/risks/settings').set(auth(tenant.admin.token)).send({ unacceptable_score: 15 });
    expect(ok.body).toEqual({ unacceptable_score: 15 });
    expect((await request(app).get('/api/risks/settings').set(auth(manager.token))).body.unacceptable_score).toBe(15);
  });

  it('is_unacceptable / needs_capa dans la liste et la fiche : résiduel prioritaire, opportunités et risques clos exclus', async () => {
    const tenant = await newTenant();
    const high = await makeRisk(tenant, { title: 'Score brut 12', likelihood: 4, impact: 3 });
    const lowResidual = await makeRisk(tenant, { title: 'Résiduel bas', likelihood: 5, impact: 5 });
    await patchRisk(tenant, lowResidual.id, { residual_likelihood: 1, residual_impact: 2 });
    const opportunity = await makeRisk(tenant, { title: 'Opportunité', type: 'opportunity', likelihood: 5, impact: 5 });

    const list = (await request(app).get('/api/risks').set(auth(tenant.admin.token))).body;
    const byId = Object.fromEntries(list.map((risk) => [risk.id, risk]));
    expect(byId[high.id]).toMatchObject({ current_score: 12, is_unacceptable: true, needs_capa: true });
    expect(byId[lowResidual.id]).toMatchObject({ current_score: 2, is_unacceptable: false, needs_capa: false });
    expect(byId[opportunity.id]).toMatchObject({ is_unacceptable: false });

    const detail = (await request(app).get(`/api/risks/${high.id}`).set(auth(tenant.admin.token))).body;
    expect(detail).toMatchObject({ is_unacceptable: true, unacceptable_score: 10 });

    // Une CAPA liée : toujours inacceptable, mais plus « sans CAPA ».
    await request(app).post(`/api/risks/${high.id}/create-capa`).set(auth(tenant.admin.token)).send({ title: 'Qualifier un 2e fournisseur' });
    const withCapa = (await request(app).get(`/api/risks/${high.id}`).set(auth(tenant.admin.token))).body;
    expect(withCapa).toMatchObject({ is_unacceptable: true, needs_capa: false });

    // Relever le seuil au-dessus du score : plus inacceptable.
    await request(app).patch('/api/risks/settings').set(auth(tenant.admin.token)).send({ unacceptable_score: 13 });
    expect((await request(app).get(`/api/risks/${high.id}`).set(auth(tenant.admin.token))).body.is_unacceptable).toBe(false);
  });

  it('la règle « CAPA obligatoire pour traiter » suit le seuil de l’entreprise', async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant);
    // Résiduel 12 (4 × 3) : au seuil par défaut de 10, refus sans CAPA — le message cite le seuil.
    const blocked = await patchRisk(tenant, risk.id, { residual_likelihood: 4, residual_impact: 3, status: 'treated' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain('seuil');
    expect(blocked.body.error).toContain('10');

    // Seuil relevé à 13 : le même risque peut passer « traité » sans CAPA.
    await request(app).patch('/api/risks/settings').set(auth(tenant.admin.token)).send({ unacceptable_score: 13 });
    const allowed = await patchRisk(tenant, risk.id, { residual_likelihood: 4, residual_impact: 3, status: 'treated' });
    expect(allowed.status).toBe(200);
  });
});

describe('Vue « à revoir » et revue en lot', () => {
  it('liste les revues dépassées, proches ou non planifiées ; exclut les risques acceptés/clos et les revues lointaines', async () => {
    const tenant = await newTenant();
    const overdue = await makeRisk(tenant, { title: 'En retard', review_date: isoDate(-10) });
    const soon = await makeRisk(tenant, { title: 'Bientôt', review_date: isoDate(30) });
    await makeRisk(tenant, { title: 'Lointaine', review_date: isoDate(200) });
    const unplanned = await makeRisk(tenant, { title: 'Sans date' });
    const closed = await makeRisk(tenant, { title: 'Clos', review_date: isoDate(-5), likelihood: 1, impact: 1 });
    await patchRisk(tenant, closed.id, { residual_likelihood: 1, residual_impact: 1, status: 'closed' });

    const res = await request(app).get('/api/risks/review-queue').set(auth(tenant.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(res.body.items.map((risk) => risk.id)).toEqual([overdue.id, soon.id, unplanned.id]);
    expect(res.body.items.map((risk) => risk.review_state)).toEqual(['overdue', 'soon', 'unplanned']);

    const wide = await request(app).get('/api/risks/review-queue?days=365').set(auth(tenant.admin.token));
    expect(wide.body.items).toHaveLength(4);
    const narrow = await request(app).get('/api/risks/review-queue?days=7').set(auth(tenant.admin.token));
    expect(narrow.body.items.map((risk) => risk.id)).toEqual([overdue.id, unplanned.id]);
  });

  it('revue en lot : nouvelle cotation, prochaine date, trace « revu le … », historique — et « revu, inchangé » compte aussi', async () => {
    const tenant = await newTenant();
    const changed = await makeRisk(tenant, { title: 'À réévaluer', review_date: isoDate(-3) });
    const unchanged = await makeRisk(tenant, { title: 'Inchangé', review_date: isoDate(-1) });
    const nextDate = isoDate(180);

    const res = await request(app)
      .post('/api/risks/bulk-review')
      .set(auth(tenant.admin.token))
      .send({ items: [{ id: changed.id, likelihood: 2, impact: 2 }, { id: unchanged.id }], next_review_date: nextDate, reason: 'Revue trimestrielle T3' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reviewed: 2, skipped: [] });

    const a = (await request(app).get(`/api/risks/${changed.id}`).set(auth(tenant.admin.token))).body;
    expect(a).toMatchObject({ likelihood: 2, impact: 2, risk_score: 4, review_date: nextDate });
    expect(a.last_reviewed_at).toBeTruthy();
    expect(a.last_reviewed_by).toBe(tenant.admin.id);

    const history = await getAssessments(tenant, unchanged.id);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ likelihood: 4, impact: 3, reason: 'Revue trimestrielle T3' });

    // Sortis de la file (revue à +180 jours, hors fenêtre de 90).
    const queue = await request(app).get('/api/risks/review-queue').set(auth(tenant.admin.token));
    expect(queue.body.items).toHaveLength(0);
  });

  it('motif par défaut selon que la cotation a changé ou non ; ids étrangers ignorés ; member refusé ; valeurs invalides refusées', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const mine = await makeRisk(tenant);
    const theirs = await makeRisk(other);

    const res = await request(app)
      .post('/api/risks/bulk-review')
      .set(auth(tenant.admin.token))
      .send({ items: [{ id: mine.id, impact: 5 }, { id: theirs.id, impact: 1 }] });
    expect(res.body).toEqual({ reviewed: 1, skipped: [theirs.id] });
    expect((await getAssessments(tenant, mine.id))[1].reason).toBe('Revue : cotation modifiée');
    expect((await request(app).get(`/api/risks/${theirs.id}`).set(auth(other.admin.token))).body.impact).toBe(3);

    expect((await request(app).post('/api/risks/bulk-review').set(auth(tenant.users[0].token)).send({ items: [{ id: mine.id }] })).status).toBe(403);
    expect((await request(app).post('/api/risks/bulk-review').set(auth(tenant.admin.token)).send({ items: [] })).status).toBe(400);
    expect((await request(app).post('/api/risks/bulk-review').set(auth(tenant.admin.token)).send({ items: [{ id: mine.id, impact: 9 }] })).status).toBe(400);
    expect((await request(app).post('/api/risks/bulk-review').set(auth(tenant.admin.token)).send({ items: [{ id: 'nope' }] })).status).toBe(400);
  });

  it('« marquer revu » sur un seul risque', async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant, { review_date: isoDate(-2) });
    const res = await request(app).post(`/api/risks/${risk.id}/review`).set(auth(tenant.admin.token)).send({ next_review_date: isoDate(365), reason: 'RAS' });
    expect(res.status).toBe(200);
    expect(res.body.review_date).toBe(isoDate(365));
    expect(res.body.last_reviewed_at).toBeTruthy();
    expect((await getAssessments(tenant, risk.id))[1].reason).toBe('RAS');
    expect((await request(app).post(`/api/risks/${risk.id}/review`).set(auth(tenant.admin.token)).send({ impact: 0 })).status).toBe(400);
  });
});

describe('Liens avec audits, fournisseurs, KPI et procédures', () => {
  async function objects(tenant) {
    const audit = await request(app).post('/api/audits').set(auth(tenant.admin.token)).send({ title: 'Audit achats', planned_date: isoDate(10) });
    const supplier = await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Emballages Martin' });
    const kpi = await request(app).post('/api/kpis').set(auth(tenant.admin.token)).send({ name: 'Taux de rebut', target: 3, target_direction: 'max' });
    const procedure = await request(app).post('/api/procedures').set(auth(tenant.admin.token)).send({ number: 'PR-01', title: 'Achats' });
    return { audit: audit.body, supplier: supplier.body, kpi: kpi.body, procedure: procedure.body };
  }

  it('rattache un audit, un fournisseur, un KPI et une procédure ; liste résolue avec titre et page ; suppression', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const risk = await makeRisk(tenant);
    const objs = await objects(tenant);
    const link = (kind, id, token = tenant.admin.token) => request(app).post(`/api/risks/${risk.id}/links`).set(auth(token)).send({ kind, ref_id: id });

    for (const [kind, id] of [['audit', objs.audit.id], ['supplier', objs.supplier.id], ['kpi', objs.kpi.id], ['procedure', objs.procedure.id]]) {
      expect((await link(kind, id)).status).toBe(201);
    }
    const list = (await request(app).get(`/api/risks/${risk.id}/links`).set(auth(tenant.users[0].token))).body;
    expect(list.map((item) => [item.kind, item.title, item.href])).toEqual([
      ['audit', 'Audit achats', `/audits/${objs.audit.id}`],
      ['supplier', 'Emballages Martin', `/suppliers/${objs.supplier.id}`],
      ['kpi', 'Taux de rebut', '/kpis'],
      ['procedure', 'PR-01 — Achats', `/procedures/${objs.procedure.id}`],
    ]);

    expect((await link('audit', objs.audit.id)).status).toBe(409);
    expect((await link('audit', objs.audit.id, tenant.users[0].token)).status).toBe(403);

    expect((await request(app).delete(`/api/risks/${risk.id}/links/${list[0].id}`).set(auth(tenant.admin.token))).status).toBe(204);
    expect((await request(app).delete(`/api/risks/${risk.id}/links/${list[0].id}`).set(auth(tenant.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token))).body).toHaveLength(3);
  });

  it("refuse un objet d'un autre tenant, un type ou un id invalide ; supprimer l'objet retire son lien", async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const risk = await makeRisk(tenant);
    const foreign = await request(app).post('/api/suppliers').set(auth(other.admin.token)).send({ name: 'Étranger' });
    const post = (body) => request(app).post(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token)).send(body);

    expect((await post({ kind: 'supplier', ref_id: foreign.body.id })).status).toBe(404);
    expect((await post({ kind: 'user', ref_id: foreign.body.id })).status).toBe(400);
    expect((await post({ kind: 'supplier', ref_id: 'x' })).status).toBe(400);
    expect((await request(app).get(`/api/risks/${risk.id}/links`).set(auth(other.admin.token))).status).toBe(404);

    const supplier = await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Local' });
    await post({ kind: 'supplier', ref_id: supplier.body.id });
    await request(app).delete(`/api/suppliers/${supplier.body.id}`).set(auth(tenant.admin.token));
    expect((await request(app).get(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token))).body).toEqual([]);
  });
});

describe('Liens : catégories restreintes et liste de choix', () => {
  it("un manager ne voit, ne propose ni ne lie un objet rangé dans une catégorie restreinte qui lui est fermée", async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const risk = await makeRisk(tenant);

    const category = await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'audit', name: 'Audits confidentiels', is_restricted: true });
    expect(category.status).toBe(201);
    const secret = await request(app).post('/api/audits').set(auth(tenant.admin.token)).send({ title: 'Audit confidentiel', planned_date: isoDate(5), category_id: category.body.id });
    const open = await request(app).post('/api/audits').set(auth(tenant.admin.token)).send({ title: 'Audit ouvert', planned_date: isoDate(6) });
    expect(secret.status).toBe(201);

    const candidates = (token) => request(app).get('/api/risks/link-candidates?kind=audit').set(auth(token));
    expect((await candidates(tenant.admin.token)).body.map((row) => row.title)).toEqual(['Audit confidentiel', 'Audit ouvert']);
    expect((await candidates(manager.token)).body).toEqual([{ id: open.body.id, title: 'Audit ouvert' }]);

    const link = (id, token) => request(app).post(`/api/risks/${risk.id}/links`).set(auth(token)).send({ kind: 'audit', ref_id: id });
    expect((await link(secret.body.id, manager.token)).status).toBe(404);
    // L'admin lie l'audit confidentiel : le manager ne le voit pas dans les liens du risque.
    expect((await link(secret.body.id, tenant.admin.token)).status).toBe(201);
    expect((await request(app).get(`/api/risks/${risk.id}/links`).set(auth(manager.token))).body).toEqual([]);
    expect((await request(app).get(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token))).body).toHaveLength(1);

    expect((await request(app).get('/api/risks/link-candidates?kind=user').set(auth(tenant.admin.token))).status).toBe(400);
  });
});

describe('Suggestions de risques depuis les KPI hors objectif', () => {
  async function kpiWithValues(tenant, name, { target, direction, values, unit }) {
    const kpi = await request(app).post('/api/kpis').set(auth(tenant.admin.token)).send({ name, target, target_direction: direction, unit });
    for (const [index, value] of values.entries()) {
      await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth(tenant.admin.token)).send({ period_date: isoDate(-30 + index), value });
    }
    return kpi.body;
  }

  it("propose les KPI hors objectif non couverts ; disparaissent une fois liés à un risque ; réservé à admin/manager", async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const bad = await kpiWithValues(tenant, 'Taux de rebut', { target: 3, direction: 'max', values: [5, 6], unit: '%' });
    await kpiWithValues(tenant, 'Livraisons', { target: 95, direction: 'min', values: [97, 98] });
    await kpiWithValues(tenant, 'Sans objectif', { direction: 'min', values: [1] });

    const res = await request(app).get('/api/risks/suggestions/kpis').set(auth(tenant.admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ kpi_id: bad.id, name: 'Taux de rebut' });
    expect(res.body[0].off_target_series[0]).toMatchObject({ average: 5.5, unit: '%', target: 3, direction: 'max' });

    expect((await request(app).get('/api/risks/suggestions/kpis').set(auth(tenant.users[0].token))).status).toBe(403);

    const risk = await makeRisk(tenant, { title: 'Rebut élevé' });
    await request(app).post(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token)).send({ kind: 'kpi', ref_id: bad.id });
    expect((await request(app).get('/api/risks/suggestions/kpis').set(auth(tenant.admin.token))).body).toEqual([]);
  });

  it('un KPI à plusieurs courbes est proposé avec la seule courbe en écart', async () => {
    const tenant = await newTenant();
    const kpi = await request(app).post('/api/kpis').set(auth(tenant.admin.token)).send({ name: 'Service client', unit: '%', target: 95, target_direction: 'min' });
    const a = await request(app).post(`/api/kpis/${kpi.body.id}/series`).set(auth(tenant.admin.token)).send({ label: 'Livraisons', calc_type: 'manual' });
    const b = await request(app)
      .post(`/api/kpis/${kpi.body.id}/series`)
      .set(auth(tenant.admin.token))
      .send({ label: 'Réclamations', calc_type: 'manual', unit: 'réclam.', target: 5, target_direction: 'max' });
    await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth(tenant.admin.token)).send({ period_date: isoDate(-2), value: 97, config_id: a.body.id });
    await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth(tenant.admin.token)).send({ period_date: isoDate(-2), value: 9, config_id: b.body.id });

    const res = await request(app).get('/api/risks/suggestions/kpis').set(auth(tenant.admin.token));
    expect(res.body[0].off_target_series).toEqual([{ label: 'Réclamations', average: 9, unit: 'réclam.', target: 5, direction: 'max' }]);
  });
});

describe('Fiche imprimable d’un risque (PDF et Word)', () => {
  async function richRisk(tenant) {
    const risk = await makeRisk(tenant, { title: 'Départ du seul soudeur qualifié', description: 'Un seul soudeur habilité.', review_date: isoDate(30) });
    await patchRisk(tenant, risk.id, { current_controls: 'Cahier de soudage à jour', treatment_plan: 'Former un second soudeur', likelihood: 3, change_reason: 'Formation démarrée' });
    await request(app).post(`/api/risks/${risk.id}/create-capa`).set(auth(tenant.admin.token)).send({ title: 'Former un second soudeur' });
    const supplier = await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Centre de formation Soudure' });
    await request(app).post(`/api/risks/${risk.id}/links`).set(auth(tenant.admin.token)).send({ kind: 'supplier', ref_id: supplier.body.id });
    await request(app).post(`/api/risks/${risk.id}/review`).set(auth(tenant.admin.token)).send({ reason: 'Revue de juin' });
    return risk;
  }

  it('PDF : cotation, verdict d’acceptabilité, mesures, CAPA, liens et historique', async () => {
    const tenant = await newTenant();
    const risk = await richRisk(tenant);
    const res = await request(app).get(`/api/risks/${risk.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const { text } = await pdfParse(Buffer.from(res.body));
    for (const expected of ['Départ du seul soudeur qualifié', '3 × 3 = 9', 'Acceptable', 'Cahier de soudage à jour', 'Former un second soudeur', 'Centre de formation Soudure', 'Cotation initiale', 'Formation démarrée', 'Revue de juin']) {
      expect(text).toContain(expected);
    }
  });

  it('Word : mêmes rubriques ; 404 hors tenant ; inconnu 404', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const risk = await richRisk(tenant);

    const res = await request(app).get(`/api/risks/${risk.id}/word`).set(auth(tenant.users[0].token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    for (const expected of ['Départ du seul soudeur qualifié', '3 × 3 = 9', 'Centre de formation Soudure', 'Historique de cotation (', 'Revue de juin', 'statut : Ouverte']) {
      expect(value).toContain(expected);
    }

    expect((await request(app).get(`/api/risks/${risk.id}/pdf`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/risks/${risk.id}/word`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get('/api/risks/00000000-0000-0000-0000-000000000000/pdf').set(auth(tenant.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/risks/${risk.id}/pdf`)).status).toBe(401);
  });

  it('un risque inacceptable sans CAPA le dit en toutes lettres', async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant, { likelihood: 5, impact: 4 });
    const res = await request(app).get(`/api/risks/${risk.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    expect(value).toContain('Inacceptable');
    expect(value).toContain('Aucune CAPA liée : à traiter');
  });
});

describe('Rappels de revue des risques', () => {
  it('jalons : 7 jours avant, le jour même, puis chaque semaine de retard', () => {
    const milestones = [-30, -21, -15, -14, -8, -7, -6, -1, 0, 1, 6, 7, 8].filter(isReminderMilestone);
    expect(milestones).toEqual([-21, -14, -7, 0, 7]);
  });

  it('reviewState : dépassée, dans la fenêtre, lointaine (null), non planifiée', () => {
    const today = '2026-06-15';
    expect(reviewState('2026-06-01', 90, today)).toBe('overdue');
    expect(reviewState('2026-06-15', 90, today)).toBe('soon');
    expect(reviewState('2026-09-13', 90, today)).toBe('soon');
    expect(reviewState('2026-09-14', 90, today)).toBeNull();
    expect(reviewState(null, 90, today)).toBe('unplanned');
  });

  it('getRiskReviewAlerts : responsable (sinon créateur), risques non clos, sur un jalon uniquement', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const owned = await makeRisk(tenant, { title: 'Dans 7 jours', review_date: isoDate(7), owner: manager.id });
    const noOwner = await makeRisk(tenant, { title: 'Aujourd’hui', review_date: isoDate(0) });
    const lateWeek = await makeRisk(tenant, { title: 'Retard 14 j', review_date: isoDate(-14) });
    await makeRisk(tenant, { title: 'Retard 10 j (pas un jalon)', review_date: isoDate(-10) });
    await makeRisk(tenant, { title: 'Dans 3 jours (pas un jalon)', review_date: isoDate(3) });
    const closed = await makeRisk(tenant, { title: 'Clos', review_date: isoDate(0), likelihood: 1, impact: 1 });
    await patchRisk(tenant, closed.id, { residual_likelihood: 1, residual_impact: 1, status: 'closed' });

    const alerts = (await getRiskReviewAlerts(tenant.tenantId)).sort((a, b) => a.days_remaining - b.days_remaining);
    expect(alerts.map((alert) => alert.id)).toEqual([lateWeek.id, noOwner.id, owned.id]);
    expect(alerts.find((alert) => alert.id === owned.id).user_id).toBe(manager.id);
    expect(alerts.find((alert) => alert.id === noOwner.id).user_id).toBe(tenant.admin.id);
  });

  it("l'email de rappel se génère ; la notification in-app est créée une seule fois par jour ; désactivable par préférence", async () => {
    const tenant = await newTenant();
    const risk = await makeRisk(tenant, { title: 'Perte du site principal', review_date: isoDate(0) });
    const html = renderTemplate('riskReviewDue', { userName: 'Marie', riskTitle: risk.title, score: 12, whenText: "aujourd'hui", reviewDate: risk.review_date, riskUrl: `https://app.example/risks/${risk.id}` });
    expect(html).toContain('Perte du site principal');
    expect(html).toContain("aujourd'hui");
    expect(html).toContain(`https://app.example/risks/${risk.id}`);
    expect(html).not.toContain('{{');

    const send = () =>
      sendImmediateNotification({
        tenantId: tenant.tenantId,
        userId: tenant.admin.id,
        prefField: 'email_risk_review',
        notificationType: 'risk_review_due',
        referenceId: risk.id,
        templateName: 'riskReviewDue',
        subject: 'Risque à revoir',
        variables: { riskTitle: risk.title, score: 12, whenText: "aujourd'hui", reviewDate: risk.review_date, riskUrl: 'https://app.example' },
        notificationTitle: 'Risque à revoir',
        notificationMessage: risk.title,
        notificationLink: `/risks/${risk.id}`,
      });
    await send();
    await send();
    const { data } = await admin.from('notifications').select('type, link').eq('user_id', tenant.admin.id).eq('type', 'risk_review_due');
    expect(data).toEqual([{ type: 'risk_review_due', link: `/risks/${risk.id}` }]);

    await request(app).patch('/api/users/me/notification-preferences').set(auth(tenant.admin.token)).send({ email_risk_review: false });
    const other = await makeRisk(tenant, { title: 'Autre risque', review_date: isoDate(0) });
    await sendImmediateNotification({ tenantId: tenant.tenantId, userId: tenant.admin.id, prefField: 'email_risk_review', notificationType: 'risk_review_due', referenceId: other.id, templateName: 'riskReviewDue', subject: 's', variables: {}, notificationTitle: 't', notificationMessage: 'm', notificationLink: '/risks' });
    const { data: after } = await admin.from('notifications').select('id').eq('user_id', tenant.admin.id).eq('type', 'risk_review_due');
    expect(after).toHaveLength(1);
  });

  it('la préférence email_risk_review existe (activée par défaut) et se désactive', async () => {
    const tenant = await newTenant();
    const before = await request(app).get('/api/users/me/notification-preferences').set(auth(tenant.admin.token));
    expect(before.body.email_risk_review).toBe(true);
    const after = await request(app).patch('/api/users/me/notification-preferences').set(auth(tenant.admin.token)).send({ email_risk_review: false });
    expect(after.status).toBe(200);
    expect(after.body.email_risk_review).toBe(false);
  });
});
