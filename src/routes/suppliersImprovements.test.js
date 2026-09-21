import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { getSupplierAlerts } from '../jobs/notificationJob.js';
import {
  DEFAULT_SUPPLIER_SETTINGS,
  addMonths,
  documentState,
  evaluationState,
  isMoreLenient,
  isSupplierReminderMilestone,
  mergeSettings,
  suggestDecision,
  validateSettingsInput,
  weightedScore,
} from '../services/supplierPolicy.js';
import { watchSince } from '../services/supplierSummary.js';

// Chaque scénario crée fournisseurs, évaluations, documents (et parfois des fichiers) : sous la charge de toute la
// suite, 5 s par défaut ne suffisent pas.
vi.setConfig({ testTimeout: 30000 });

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
const isoDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const makeSupplier = async (tenant, overrides = {}, token = tenant.admin.token) => {
  const res = await request(app).post('/api/suppliers').set(auth(token)).send({ name: 'Emballages Martin', ...overrides });
  expect(res.status).toBe(201);
  return res.body;
};
const evaluate = (tenant, supplierId, body, token = tenant.admin.token) =>
  request(app)
    .post(`/api/suppliers/${supplierId}/evaluations`)
    .set(auth(token))
    .send({ evaluation_date: isoDate(0), quality_score: 4, delivery_score: 4, price_score: 4, responsiveness_score: 4, ...body });
const getSupplier = async (tenant, id, token = tenant.admin.token) => (await request(app).get(`/api/suppliers/${id}`).set(auth(token))).body;
const putSettings = (tenant, body, token = tenant.admin.token) => request(app).patch('/api/suppliers/settings').set(auth(token)).send(body);

const completeSettings = (overrides = {}) => ({
  ...structuredClone(DEFAULT_SUPPLIER_SETTINGS),
  ...overrides,
});

describe('Règles : réglages, note pondérée, décision proposée, échéances', () => {
  it('mergeSettings : défauts, valeurs partielles, valeurs invalides ignorées', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SUPPLIER_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SUPPLIER_SETTINGS);
    const merged = mergeSettings({ frequency_months: { critical: 3, low: 'x' }, thresholds: { watch: 3.5 }, weights: { critical: { quality: 5, price: -1 } } });
    expect(merged.frequency_months).toEqual({ low: 24, medium: 12, high: 9, critical: 3 });
    expect(merged.thresholds).toEqual({ watch: 3.5, replace: 2 });
    expect(merged.weights.critical).toEqual({ quality: 5, delivery: 1, price: 1, responsiveness: 1 });
    // Tous les poids à zéro : retombe sur les défauts plutôt que de diviser par zéro.
    expect(mergeSettings({ weights: { low: { quality: 0, delivery: 0, price: 0, responsiveness: 0 } } }).weights.low).toEqual({ quality: 1, delivery: 1, price: 1, responsiveness: 1 });
  });

  it('weightedScore et suggestDecision (seuils stricts) et isMoreLenient', () => {
    expect(weightedScore({ quality: 4, delivery: 2, price: 5, responsiveness: 3 }, { quality: 3, delivery: 2, price: 1, responsiveness: 1 })).toBe(3.43);
    expect(weightedScore({ quality: 4, delivery: 2, price: 5, responsiveness: 3 }, { quality: 1, delivery: 1, price: 1, responsiveness: 1 })).toBe(3.5);
    const thresholds = { watch: 3, replace: 2 };
    expect(suggestDecision(3, thresholds)).toBe('maintained');
    expect(suggestDecision(2.99, thresholds)).toBe('under_watch');
    expect(suggestDecision(2, thresholds)).toBe('under_watch');
    expect(suggestDecision(1.99, thresholds)).toBe('to_replace');
    expect(isMoreLenient('maintained', 'under_watch')).toBe(true);
    expect(isMoreLenient('under_watch', 'under_watch')).toBe(false);
    expect(isMoreLenient('to_replace', 'maintained')).toBe(false);
  });

  it('addMonths (fin de mois), evaluationState, documentState, jalons de rappel', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-15', 6)).toBe('2027-02-15');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    const today = '2026-06-15';
    expect(evaluationState({ next_evaluation_date: null, evaluationCount: 0 }, today)).toBe('never');
    expect(evaluationState({ next_evaluation_date: null, evaluationCount: 2 }, today)).toBe('ok');
    expect(evaluationState({ next_evaluation_date: '2026-06-14', evaluationCount: 1 }, today)).toBe('overdue');
    expect(evaluationState({ next_evaluation_date: '2026-06-15', evaluationCount: 1 }, today)).toBe('due_soon');
    expect(evaluationState({ next_evaluation_date: '2026-07-15', evaluationCount: 1 }, today)).toBe('due_soon');
    expect(evaluationState({ next_evaluation_date: '2026-07-16', evaluationCount: 1 }, today)).toBe('ok');
    expect(documentState(null, today)).toBe('no_expiry');
    expect(documentState('2026-06-14', today)).toBe('expired');
    expect(documentState('2026-07-15', today)).toBe('expiring');
    expect(documentState('2026-07-16', today)).toBe('valid');
    expect([-15, -14, -8, -7, -1, 0, 1, 7, 8, 29, 30, 31].filter(isSupplierReminderMilestone)).toEqual([-14, -7, 0, 7, 30]);
  });

  it('validateSettingsInput : refuse fréquence, seuils, poids et booléen invalides', () => {
    const valid = completeSettings();
    expect(validateSettingsInput(valid).settings).toEqual(valid);
    expect(validateSettingsInput({ ...valid, frequency_months: { ...valid.frequency_months, low: 0 } }).error).toContain('fréquence');
    expect(validateSettingsInput({ ...valid, frequency_months: { ...valid.frequency_months, low: 1.5 } }).error).toContain('fréquence');
    expect(validateSettingsInput({ ...valid, thresholds: { watch: 2, replace: 2 } }).error).toContain('inférieur');
    expect(validateSettingsInput({ ...valid, thresholds: { watch: 6, replace: 2 } }).error).toContain('entre 1 et 5');
    expect(validateSettingsInput({ ...valid, weights: { ...valid.weights, high: { quality: 0, delivery: 0, price: 0, responsiveness: 0 } } }).error).toContain('Au moins un critère');
    expect(validateSettingsInput({ ...valid, weights: { ...valid.weights, high: { quality: 11, delivery: 1, price: 1, responsiveness: 1 } } }).error).toContain('entier');
    expect(validateSettingsInput({ ...valid, auto_suspend_on_replace: 'oui' }).error).toBeTruthy();
    expect(validateSettingsInput(null).error).toBeTruthy();
  });

  it('watchSince : début de la série de décisions non maintenues', () => {
    expect(watchSince([])).toBeNull();
    expect(watchSince([{ decision: 'maintained', evaluation_date: '2026-05-01' }])).toBeNull();
    expect(
      watchSince([
        { decision: 'to_replace', evaluation_date: '2026-05-01' },
        { decision: 'under_watch', evaluation_date: '2026-02-01' },
        { decision: 'under_watch', evaluation_date: '2025-11-01' },
        { decision: 'maintained', evaluation_date: '2025-06-01' },
        { decision: 'under_watch', evaluation_date: '2025-01-01' },
      ])
    ).toBe('2025-11-01');
  });
});

describe('Réglages de l’entreprise (API)', () => {
  it('lisibles par tous (valeurs par défaut) ; modifiables par un admin seulement, avec contrôle', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const [manager, member] = tenant.users;
    const read = await request(app).get('/api/suppliers/settings').set(auth(member.token));
    expect(read.status).toBe(200);
    expect(read.body).toEqual(DEFAULT_SUPPLIER_SETTINGS);

    const settings = completeSettings({ thresholds: { watch: 3.5, replace: 2.5 }, frequency_months: { low: 18, medium: 12, high: 6, critical: 3 } });
    expect((await putSettings(tenant, settings, manager.token)).status).toBe(403);
    const ok = await putSettings(tenant, settings);
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/suppliers/settings').set(auth(member.token))).body).toEqual(settings);

    expect((await putSettings(tenant, { ...settings, thresholds: { watch: 2, replace: 3 } })).status).toBe(400);
    expect((await putSettings(tenant, { ...settings, frequency_months: { ...settings.frequency_months, low: 0 } })).status).toBe(400);
    expect((await putSettings(tenant, {})).status).toBe(400);
    // Les réglages d'une entreprise ne fuient pas chez une autre.
    const other = await newTenant();
    expect((await request(app).get('/api/suppliers/settings').set(auth(other.admin.token))).body).toEqual(DEFAULT_SUPPLIER_SETTINGS);
  });
});

describe('Évaluation : note pondérée, décision proposée, prochaine date automatique', () => {
  it('pondère selon la criticité, conserve les poids avec l’évaluation, propose la décision', async () => {
    const tenant = await newTenant();
    const weights = structuredClone(DEFAULT_SUPPLIER_SETTINGS.weights);
    weights.critical = { quality: 3, delivery: 2, price: 1, responsiveness: 1 };
    await putSettings(tenant, completeSettings({ weights }));
    const supplier = await makeSupplier(tenant, { criticality: 'critical' });

    const res = await evaluate(tenant, supplier.id, { quality_score: 4, delivery_score: 2, price_score: 5, responsiveness_score: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ score: 3.43, weighted_score: 3.43, suggested_decision: 'maintained', decision: 'maintained' });
    expect(Number(res.body.overall_score)).toBe(3.5); // moyenne simple d'origine, inchangée
    expect(res.body.weights).toEqual({ quality: 3, delivery: 2, price: 1, responsiveness: 1 });

    // Les réglages changent ensuite : l'évaluation passée garde ses poids et sa note.
    await putSettings(tenant, completeSettings());
    const detail = await getSupplier(tenant, supplier.id);
    expect(detail.evaluations[0]).toMatchObject({ score: 3.43, weights: { quality: 3, delivery: 2, price: 1, responsiveness: 1 } });
    expect(detail.policy.weights).toEqual({ quality: 1, delivery: 1, price: 1, responsiveness: 1 });
    expect(detail.policy.thresholds).toEqual({ watch: 3, replace: 2 });
  });

  it('prochaine évaluation datée depuis la dernière évaluation selon la criticité (et recalculée à la suppression / au changement de criticité)', async () => {
    const tenant = await newTenant();
    const critical = await makeSupplier(tenant, { name: 'Critique', criticality: 'critical' });
    const low = await makeSupplier(tenant, { name: 'Faible', criticality: 'low' });

    const a = await evaluate(tenant, critical.id, { evaluation_date: '2026-03-31' });
    expect(a.body.supplier_update.next_evaluation_date).toBe('2026-09-30');
    expect((await getSupplier(tenant, critical.id)).next_evaluation_date).toBe('2026-09-30');
    await evaluate(tenant, low.id, { evaluation_date: '2026-03-31' });
    expect((await getSupplier(tenant, low.id)).next_evaluation_date).toBe('2028-03-31');

    // Évaluation antidatée : l'historique se complète, la prochaine date ne bouge pas.
    const older = await evaluate(tenant, critical.id, { evaluation_date: '2025-10-01' });
    expect(older.body.supplier_update).toEqual({});
    expect((await getSupplier(tenant, critical.id)).next_evaluation_date).toBe('2026-09-30');

    // Nouvelle évaluation plus récente puis suppression : retour sur l'évaluation précédente.
    const newer = await evaluate(tenant, critical.id, { evaluation_date: '2026-06-30' });
    expect((await getSupplier(tenant, critical.id)).next_evaluation_date).toBe('2026-12-30');
    await request(app).delete(`/api/suppliers/${critical.id}/evaluations/${newer.body.id}`).set(auth(tenant.admin.token));
    expect((await getSupplier(tenant, critical.id)).next_evaluation_date).toBe('2026-09-30');

    // Changer la criticité recalcule (12 mois pour « medium ») — sauf date fixée à la main dans la même requête.
    const patch = (body) => request(app).patch(`/api/suppliers/${critical.id}`).set(auth(tenant.admin.token)).send(body);
    expect((await patch({ criticality: 'medium' })).body.next_evaluation_date).toBe('2027-03-31');
    expect((await patch({ criticality: 'low', next_evaluation_date: '2026-12-01' })).body.next_evaluation_date).toBe('2026-12-01');
  });

  it('une décision plus indulgente que la proposition exige un commentaire ; plus sévère, seulement la règle habituelle', async () => {
    const tenant = await newTenant();
    const supplier = await makeSupplier(tenant);
    const poor = { quality_score: 2, delivery_score: 2, price_score: 1, responsiveness_score: 1 }; // 1,5 → « à remplacer » proposé

    const lenient = await evaluate(tenant, supplier.id, { ...poor, decision: 'maintained' });
    expect(lenient.status).toBe(400);
    expect(lenient.body.error).toContain('plus indulgente');
    expect((await evaluate(tenant, supplier.id, { ...poor, decision: 'under_watch' })).status).toBe(400);
    const justified = await evaluate(tenant, supplier.id, { ...poor, decision: 'under_watch', comment: 'Plan de progrès accepté par le fournisseur' });
    expect(justified.status).toBe(201);
    expect(justified.body).toMatchObject({ suggested_decision: 'to_replace', decision: 'under_watch' });

    // Plus sévère que proposé : « à remplacer » avec de bonnes notes, justifié comme avant.
    expect((await evaluate(tenant, supplier.id, { decision: 'to_replace' })).status).toBe(400);
    expect((await evaluate(tenant, supplier.id, { decision: 'to_replace', comment: 'Rupture de contrat' })).status).toBe(201);
  });

  it('« à remplacer » suspend le fournisseur (réglage désactivable) ; une évaluation antidatée ne suspend pas', async () => {
    const tenant = await newTenant();
    const a = await makeSupplier(tenant, { name: 'A' });
    const res = await evaluate(tenant, a.id, { quality_score: 1, delivery_score: 1, price_score: 1, responsiveness_score: 1, decision: 'to_replace', comment: 'Qualité inacceptable' });
    expect(res.body.supplier_update.status).toBe('suspended');
    expect((await getSupplier(tenant, a.id)).status).toBe('suspended');

    await putSettings(tenant, completeSettings({ auto_suspend_on_replace: false }));
    const b = await makeSupplier(tenant, { name: 'B' });
    await evaluate(tenant, b.id, { quality_score: 1, delivery_score: 1, price_score: 1, responsiveness_score: 1, decision: 'to_replace', comment: 'x' });
    expect((await getSupplier(tenant, b.id)).status).toBe('active');

    await putSettings(tenant, completeSettings());
    const c = await makeSupplier(tenant, { name: 'C' });
    await evaluate(tenant, c.id, { evaluation_date: isoDate(0) });
    await evaluate(tenant, c.id, { evaluation_date: isoDate(-400), quality_score: 1, delivery_score: 1, price_score: 1, responsiveness_score: 1, decision: 'to_replace', comment: 'ancien' });
    expect((await getSupplier(tenant, c.id)).status).toBe('active');
  });

  it('responsable du suivi : enregistré à la création et à la modification, résolu dans la fiche', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const supplier = await makeSupplier(tenant, { owner: manager.id });
    expect(supplier.owner_user.id).toBe(manager.id);
    const patched = await request(app).patch(`/api/suppliers/${supplier.id}`).set(auth(tenant.admin.token)).send({ owner: tenant.admin.id });
    expect(patched.body.owner_user.id).toBe(tenant.admin.id);
    expect((await request(app).patch(`/api/suppliers/${supplier.id}`).set(auth(tenant.admin.token)).send({ owner: 'pas-un-uuid' })).status).toBe(400);
    expect((await request(app).patch(`/api/suppliers/${supplier.id}`).set(auth(tenant.admin.token)).send({ owner: null })).body.owner).toBeNull();
  });
});

describe('Tableau de synthèse', () => {
  it('note et décision récentes, évolution, retards, critiques jamais évalués, surveillance longue, certificats', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const never = await makeSupplier(tenant, { name: 'Critique jamais évalué', criticality: 'critical' });
    const low = await makeSupplier(tenant, { name: 'Faible jamais évalué', criticality: 'low' });
    const overdue = await makeSupplier(tenant, { name: 'En retard', next_evaluation_date: isoDate(-10) });
    const watch = await makeSupplier(tenant, { name: 'Sous surveillance longue' });
    const good = await makeSupplier(tenant, { name: 'Bon fournisseur' });
    const inactive = await makeSupplier(tenant, { name: 'Inactif' });
    await request(app).patch(`/api/suppliers/${inactive.id}`).set(auth(tenant.admin.token)).send({ status: 'inactive' });

    // Surveillance qui dure : deux évaluations « sous surveillance » dont la première date de 200 jours.
    const weak = { quality_score: 2, delivery_score: 3, price_score: 3, responsiveness_score: 3 }; // 2,75
    await evaluate(tenant, watch.id, { ...weak, evaluation_date: isoDate(-200), decision: 'under_watch', comment: 'à surveiller' });
    await evaluate(tenant, watch.id, { ...weak, evaluation_date: isoDate(-20), decision: 'under_watch', comment: 'toujours' });
    await evaluate(tenant, good.id, { quality_score: 3, delivery_score: 3, price_score: 3, responsiveness_score: 3, evaluation_date: isoDate(-100) });
    await evaluate(tenant, good.id, { quality_score: 5, delivery_score: 4, price_score: 4, responsiveness_score: 5, evaluation_date: isoDate(-10) });

    const doc = (supplier, body) => request(app).post(`/api/suppliers/${supplier.id}/documents`).set(auth(tenant.admin.token)).send(body);
    await doc(good, { title: 'ISO 9001', kind: 'quality_certificate', expires_on: isoDate(-5) });
    await doc(good, { title: 'Assurance', kind: 'insurance', expires_on: isoDate(10) });
    await doc(good, { title: 'Contrat', kind: 'contract', expires_on: isoDate(400) });
    await doc(inactive, { title: 'Ancien certificat', expires_on: isoDate(-100) });

    const res = await request(app).get('/api/suppliers/summary').set(auth(tenant.users[0].token));
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({
      active: 5,
      evaluated: 2,
      overdue: 1,
      due_soon: 0,
      never_evaluated: 3,
      critical_never_evaluated: 1,
      under_watch: 1,
      long_watch: 1,
      expired_documents: 1, // le certificat expiré du fournisseur inactif ne compte pas
      expiring_documents: 1,
    });

    const byName = Object.fromEntries(res.body.suppliers.map((item) => [item.name, item]));
    expect(byName['Critique jamais évalué']).toMatchObject({ evaluation_state: 'never', evaluation_count: 0, latest: null, trend: null });
    expect(byName['En retard'].evaluation_state).toBe('overdue');
    expect(byName['Bon fournisseur']).toMatchObject({ latest: { score: 4.5, decision: 'maintained' }, trend: 1.5, expired_documents: 1, expiring_documents: 1, long_watch: false, evaluation_state: 'ok' });
    expect(byName['Sous surveillance longue']).toMatchObject({ latest: { score: 2.75, decision: 'under_watch' }, trend: 0, long_watch: true, watch_since: isoDate(-200) });
    expect(byName.Inactif.status).toBe('inactive');
  });

  it('un fournisseur d’une catégorie restreinte n’apparaît pas dans la synthèse d’un member sans accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const category = await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'supplier', name: 'Confidentiel', is_restricted: true });
    expect(category.status).toBe(201);
    await makeSupplier(tenant, { name: 'Secret', category_id: category.body.id });
    await makeSupplier(tenant, { name: 'Ouvert' });
    const names = async (token) => (await request(app).get('/api/suppliers/summary').set(auth(token))).body.suppliers.map((item) => item.name);
    expect(await names(tenant.admin.token)).toEqual(['Ouvert', 'Secret']);
    expect(await names(tenant.users[0].token)).toEqual(['Ouvert']);
  });
});

describe('Certificats et pièces', () => {
  const post = (tenant, supplierId, fields, token = tenant.admin.token) => request(app).post(`/api/suppliers/${supplierId}/documents`).set(auth(token)).send(fields);

  it('création sans fichier : type, échéance, état calculé ; validations', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const supplier = await makeSupplier(tenant);
    const ok = await post(tenant, supplier.id, { title: 'Certificat FSSC 22000', kind: 'food_safety_certificate', reference: 'FSSC-123', issuer: 'Bureau Veritas', issued_on: isoDate(-300), expires_on: isoDate(20) });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: 'Certificat FSSC 22000', kind: 'food_safety_certificate', state: 'expiring', has_file: false });
    expect(ok.body.file_path).toBeUndefined();

    expect((await post(tenant, supplier.id, { kind: 'insurance' })).status).toBe(400);
    expect((await post(tenant, supplier.id, { title: 'x', kind: 'inconnu' })).status).toBe(400);
    expect((await post(tenant, supplier.id, { title: 'x', expires_on: 'demain' })).status).toBe(400);
    expect((await post(tenant, supplier.id, { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await post(tenant, supplier.id, { title: 'Interdit' }, tenant.users[0].token)).status).toBe(403);

    const detail = await getSupplier(tenant, supplier.id, tenant.users[0].token);
    expect(detail.documents).toHaveLength(1);
    expect(detail.documents[0].state).toBe('expiring');
  });

  it('modification des métadonnées ; le titre ne peut pas être vidé ; 404 hors tenant', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const supplier = await makeSupplier(tenant);
    const doc = (await post(tenant, supplier.id, { title: 'Assurance RC', kind: 'insurance', expires_on: isoDate(-3) })).body;
    expect(doc.state).toBe('expired');

    const patch = (fields, token = tenant.admin.token) => request(app).patch(`/api/suppliers/${supplier.id}/documents/${doc.id}`).set(auth(token)).send(fields);
    const renewed = await patch({ expires_on: isoDate(365), reference: 'RC-2027' });
    expect(renewed.body).toMatchObject({ state: 'valid', reference: 'RC-2027', title: 'Assurance RC' });
    expect((await patch({ title: '' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ expires_on: null })).body.state).toBe('no_expiry');
    expect((await patch({ title: 'Hack' }, other.admin.token)).status).toBe(404);
    expect((await request(app).patch(`/api/suppliers/${supplier.id}/documents/${supplier.id}`).set(auth(tenant.admin.token)).send({ title: 'x' })).status).toBe(404);
  });

  it('fichier joint : envoi, téléchargement par lien signé, remplacement, suppression', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const supplier = await makeSupplier(tenant);
    const created = await request(app)
      .post(`/api/suppliers/${supplier.id}/documents`)
      .set(auth(tenant.admin.token))
      .field('title', 'Certificat ISO 9001')
      .field('kind', 'quality_certificate')
      .field('expires_on', isoDate(200))
      .attach('file', Buffer.from('%PDF-1.4 contenu du certificat'), 'iso9001.pdf');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ file_name: 'iso9001.pdf', has_file: true, state: 'valid' });
    expect(created.body.file_path).toBeUndefined();

    const link = await request(app).get(`/api/suppliers/${supplier.id}/documents/${created.body.id}/download`).set(auth(tenant.users[0].token));
    expect(link.status).toBe(200);
    expect(link.body.url).toContain('supplier-documents');
    const file = await fetch(link.body.url);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('%PDF-1.4 contenu du certificat');

    // Autre entreprise : pas de lien.
    expect((await request(app).get(`/api/suppliers/${supplier.id}/documents/${created.body.id}/download`).set(auth(other.admin.token))).status).toBe(404);

    // Remplacement (certificat renouvelé) : l'ancien fichier disparaît du stockage.
    const before = await link.body.url;
    const replaced = await request(app).put(`/api/suppliers/${supplier.id}/documents/${created.body.id}/file`).set(auth(tenant.admin.token)).attach('file', Buffer.from('nouveau certificat'), 'iso9001-2027.pdf');
    expect(replaced.status).toBe(200);
    expect(replaced.body.file_name).toBe('iso9001-2027.pdf');
    expect((await fetch(before)).status).not.toBe(200);
    const newLink = await request(app).get(`/api/suppliers/${supplier.id}/documents/${created.body.id}/download`).set(auth(tenant.admin.token));
    expect(await (await fetch(newLink.body.url)).text()).toBe('nouveau certificat');
    expect((await request(app).put(`/api/suppliers/${supplier.id}/documents/${created.body.id}/file`).set(auth(tenant.admin.token))).status).toBe(400);

    // Suppression : document et fichier.
    expect((await request(app).delete(`/api/suppliers/${supplier.id}/documents/${created.body.id}`).set(auth(tenant.users[0].token))).status).toBe(403);
    expect((await request(app).delete(`/api/suppliers/${supplier.id}/documents/${created.body.id}`).set(auth(tenant.admin.token))).status).toBe(204);
    expect((await fetch(newLink.body.url)).status).not.toBe(200);
    expect((await request(app).delete(`/api/suppliers/${supplier.id}/documents/${created.body.id}`).set(auth(tenant.admin.token))).status).toBe(404);
  });

  it('un document sans fichier n’a rien à télécharger (404)', async () => {
    const tenant = await newTenant();
    const supplier = await makeSupplier(tenant);
    const doc = (await post(tenant, supplier.id, { title: 'Sans fichier' })).body;
    expect((await request(app).get(`/api/suppliers/${supplier.id}/documents/${doc.id}/download`).set(auth(tenant.admin.token))).status).toBe(404);
  });

  it('supprimer le fournisseur supprime ses documents', async () => {
    const tenant = await newTenant();
    const supplier = await makeSupplier(tenant);
    await post(tenant, supplier.id, { title: 'À supprimer' });
    await request(app).delete(`/api/suppliers/${supplier.id}`).set(auth(tenant.admin.token));
    const { data } = await admin.from('supplier_documents').select('id').eq('tenant_id', tenant.tenantId);
    expect(data).toEqual([]);
  });
});

describe('Fiche imprimable (PDF et Word)', () => {
  async function richSupplier(tenant) {
    const manager = tenant.users[0];
    const supplier = await makeSupplier(tenant, { name: 'Laiterie du Sud', criticality: 'high', category: 'Matières premières', contact_name: 'Paul Martin', contact_email: 'paul@laiterie.example', owner: manager.id });
    await evaluate(tenant, supplier.id, { evaluation_date: isoDate(-200), quality_score: 3, delivery_score: 3, price_score: 4, responsiveness_score: 3 });
    await evaluate(tenant, supplier.id, { evaluation_date: isoDate(-100), quality_score: 2, delivery_score: 2, price_score: 3, responsiveness_score: 2, decision: 'under_watch', comment: 'Retards de livraison répétés' });
    await request(app).post(`/api/suppliers/${supplier.id}/documents`).set(auth(tenant.admin.token)).send({ title: 'Certificat IFS Food', kind: 'food_safety_certificate', reference: 'IFS-77', issuer: 'SGS', expires_on: isoDate(15) });
    return supplier;
  }

  it('PDF : identité, dernière évaluation, courbe, historique, certificats', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const supplier = await richSupplier(tenant);
    const res = await request(app).get(`/api/suppliers/${supplier.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const { text } = await pdfParse(Buffer.from(res.body));
    for (const expected of ['Laiterie du Sud', 'Matières premières', 'Élevée', 'Paul Martin', 'Évolution des notes', 'Note globale', 'Retards de livraison répétés', 'Sous surveillance', 'Certificat IFS Food', 'IFS-77', 'Expire bientôt', 'Responsable du suivi']) {
      expect(text).toContain(expected);
    }
  });

  it('Word : mêmes rubriques ; 404 hors tenant ; 401 sans jeton ; un member peut l’exporter', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }] });
    const other = await newTenant();
    const supplier = await richSupplier(tenant);
    const res = await request(app).get(`/api/suppliers/${supplier.id}/word`).set(auth(tenant.users[1].token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    for (const expected of ['Laiterie du Sud', 'Évaluations (2)', 'Retards de livraison répétés', 'Certificats et pièces (1)', 'Certificat IFS Food', 'Seuils de décision', 'Poids des critères']) {
      expect(value).toContain(expected);
    }
    expect((await request(app).get(`/api/suppliers/${supplier.id}/word`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/suppliers/${supplier.id}/pdf`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/suppliers/${supplier.id}/pdf`)).status).toBe(401);
  });

  it('un fournisseur sans évaluation ni certificat s’exporte quand même', async () => {
    const tenant = await newTenant();
    const supplier = await makeSupplier(tenant, { name: 'Tout neuf' });
    const pdf = await request(app).get(`/api/suppliers/${supplier.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    expect((await pdfParse(Buffer.from(pdf.body))).text).toContain('Jamais évalué');
    const word = await request(app).get(`/api/suppliers/${supplier.id}/word`).set(auth(tenant.admin.token)).responseType('blob');
    expect((await mammoth.extractRawText({ buffer: Buffer.from(word.body) })).value).toContain('Aucune évaluation.');
  });
});

describe('Rappels : évaluations à faire et certificats qui expirent', () => {
  it('jalons 30 / 7 / 0 jours puis chaque semaine ; responsable (sinon créateur) ; fournisseurs actifs seulement', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const inThirty = await makeSupplier(tenant, { name: 'Dans 30 jours', next_evaluation_date: isoDate(30), owner: manager.id });
    const today = await makeSupplier(tenant, { name: 'Aujourd’hui', next_evaluation_date: isoDate(0) });
    await makeSupplier(tenant, { name: 'Dans 12 jours (pas un jalon)', next_evaluation_date: isoDate(12) });
    const lateWeek = await makeSupplier(tenant, { name: 'Retard 14 j', next_evaluation_date: isoDate(-14) });
    const inactive = await makeSupplier(tenant, { name: 'Inactif', next_evaluation_date: isoDate(0) });
    await request(app).patch(`/api/suppliers/${inactive.id}`).set(auth(tenant.admin.token)).send({ status: 'inactive' });

    const doc = (supplier, title, days) => request(app).post(`/api/suppliers/${supplier.id}/documents`).set(auth(tenant.admin.token)).send({ title, expires_on: isoDate(days) });
    await doc(today, 'Certificat dans 7 jours', 7);
    await doc(inThirty, 'Certificat expiré depuis 7 jours', -7);
    await doc(today, 'Certificat dans 9 jours (pas un jalon)', 9);
    await doc(inactive, 'Certificat d’un inactif', 0);

    const alerts = await getSupplierAlerts(tenant.tenantId);
    expect(alerts.evaluations.map((alert) => alert.name).sort()).toEqual(['Aujourd’hui', 'Dans 30 jours', 'Retard 14 j'].sort());
    expect(alerts.evaluations.find((alert) => alert.id === inThirty.id).user_id).toBe(manager.id);
    expect(alerts.evaluations.find((alert) => alert.id === today.id).user_id).toBe(tenant.admin.id);
    expect(alerts.evaluations.find((alert) => alert.id === lateWeek.id).days_remaining).toBe(-14);
    expect(alerts.documents.map((alert) => alert.title).sort()).toEqual(['Certificat dans 7 jours', 'Certificat expiré depuis 7 jours'].sort());
  });

  it('la préférence email_supplier_alerts existe (activée par défaut) et se désactive', async () => {
    const tenant = await newTenant();
    expect((await request(app).get('/api/users/me/notification-preferences').set(auth(tenant.admin.token))).body.email_supplier_alerts).toBe(true);
    const off = await request(app).patch('/api/users/me/notification-preferences').set(auth(tenant.admin.token)).send({ email_supplier_alerts: false });
    expect(off.body.email_supplier_alerts).toBe(false);
  });
});

describe('Revue de direction : la note moyenne des fournisseurs est pondérée', () => {
  it('utilise la note pondérée quand elle existe, la moyenne simple sinon', async () => {
    const { buildQmsSnapshot } = await import('../services/qmsSnapshot.js');
    const tenant = await newTenant();
    const weights = structuredClone(DEFAULT_SUPPLIER_SETTINGS.weights);
    weights.medium = { quality: 4, delivery: 1, price: 1, responsiveness: 1 };
    await putSettings(tenant, completeSettings({ weights }));
    const supplier = await makeSupplier(tenant);
    await evaluate(tenant, supplier.id, { quality_score: 5, delivery_score: 1, price_score: 1, responsiveness_score: 1 }); // pondérée 3,29 ; simple 2,0
    // Ancienne évaluation (avant cette fonctionnalité) : pas de note pondérée.
    await admin.from('supplier_evaluations').insert({ tenant_id: tenant.tenantId, supplier_id: supplier.id, evaluation_date: isoDate(-5), quality_score: 3, delivery_score: 3, price_score: 3, responsiveness_score: 3, decision: 'maintained' });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart: isoDate(-30), periodEnd: isoDate(0) });
    expect(snapshot.suppliers_period.evaluations).toBe(2);
    expect(snapshot.suppliers_period.average_score).toBe(3.1); // (3,29 + 3) / 2 = 3,145 → 3,1
  });
});
