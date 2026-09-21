import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import app from '../app.js';
import { createTenant, admin } from '../test-utils/tenant.js';
import { getOverdueReadingAlerts, runHaccpReminderJob } from '../jobs/haccpReminderJob.js';
import { getHaccpReviewAlerts } from '../jobs/notificationJob.js';
import { evaluateReading, isWithinLimits, isWithinReminderHours, monitoringState, numericLimitsOf, parseNumber } from '../services/haccpMonitoring.js';
import { diffSnapshots } from '../services/haccpRevisions.js';
import { trainingStatus } from '../services/haccpLinks.js';

// Chaque scénario construit un plan complet (étapes, dangers, CCP) via l'API : sous la charge de toute la suite,
// 5 s par défaut ne suffisent pas.
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

// Chaîne complète : plan -> étape -> danger significatif -> CCP (limites 0 à 4 °C, relevé toutes les 12 h).
async function buildPlan(tenant, { ccp = {}, plan = {}, hazard = {} } = {}) {
  const token = tenant.admin.token;
  const post = (url, body) => request(app).post(url).set(auth(token)).send(body);
  const planRes = await post('/api/haccp/plans', { title: 'Chaîne du froid — produits tranchés', ...plan });
  const step = await post(`/api/haccp/plans/${planRes.body.id}/steps`, { name: 'Stockage en chambre froide' });
  const hazardRes = await post(`/api/haccp/steps/${step.body.id}/hazards`, { hazard_type: 'biological', description: 'Prolifération de Listeria', likelihood: 3, severity: 5, ...hazard });
  await request(app).patch(`/api/haccp/hazards/${hazardRes.body.id}`).set(auth(token)).send({ is_significant: true, justification: 'Danger majeur.' }).expect(200);
  const ccpRes = await post(`/api/haccp/hazards/${hazardRes.body.id}/ccps`, {
    ccp_number: 'CCP1',
    critical_limits: '≤ 4 °C',
    monitoring_procedure: 'Relevé de la sonde',
    monitoring_frequency: '2 fois par jour',
    limit_min: 0,
    limit_max: 4,
    limit_unit: '°C',
    monitoring_interval_hours: 12,
    ...ccp,
  });
  expect(ccpRes.status).toBe(201);
  return { plan: planRes.body, step: step.body, hazard: hazardRes.body, ccp: ccpRes.body };
}

const logReading = (tenant, ccpId, body, token = tenant.admin.token) => request(app).post(`/api/haccp/ccps/${ccpId}/monitoring-logs`).set(auth(token)).send(body);
const activate = (tenant, planId) => request(app).patch(`/api/haccp/plans/${planId}`).set(auth(tenant.admin.token)).send({ status: 'active' });
const getPlan = async (tenant, planId) => (await request(app).get(`/api/haccp/plans/${planId}`).set(auth(tenant.admin.token))).body;

describe('Limites chiffrées et intervalle d’un CCP', () => {
  it('enregistre les bornes (0 inclus), l’unité et l’intervalle ; les efface avec une chaîne vide', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant);
    expect(ccp).toMatchObject({ limit_min: 0, limit_max: 4, limit_unit: '°C', monitoring_interval_hours: 12 });

    const cleared = await request(app).patch(`/api/haccp/ccps/${ccp.id}`).set(auth(tenant.admin.token)).send({ limit_min: '', monitoring_interval_hours: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ limit_min: null, monitoring_interval_hours: null, limit_max: 4 });
  });

  it('refuse des bornes inversées, non numériques ou un intervalle nul — y compris sur une seule borne modifiée', async () => {
    const tenant = await newTenant();
    const { hazard, ccp } = await buildPlan(tenant);
    const patch = (body) => request(app).patch(`/api/haccp/ccps/${ccp.id}`).set(auth(tenant.admin.token)).send(body);

    expect((await patch({ limit_min: 10 })).status).toBe(400); // 10 > max existant (4)
    expect((await patch({ limit_max: -1 })).status).toBe(400); // -1 < min existant (0)
    expect((await patch({ limit_min: 'abc' })).status).toBe(400);
    expect((await patch({ monitoring_interval_hours: 0 })).status).toBe(400);
    expect((await patch({ monitoring_interval_hours: 9999 })).status).toBe(400);
    expect((await patch({ limit_min: 1, limit_max: 3 })).status).toBe(200);

    const second = await request(app).post(`/api/haccp/hazards/${hazard.id}/ccps`).set(auth(tenant.admin.token)).send({ critical_limits: 'x', monitoring_procedure: 'y', limit_min: 5, limit_max: 2 });
    expect(second.status).toBe(400);
    expect(second.body.error).toContain('minimale');
  });
});

describe('Verdict automatique d’un relevé', () => {
  it('avec des limites chiffrées, la valeur décide : bornes incluses, virgule française, jamais le client', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant);

    const atLimit = await logReading(tenant, ccp.id, { numeric_value: 4 });
    expect(atLimit.status).toBe(201);
    expect(atLimit.body).toMatchObject({ within_limits: true, numeric_value: 4, recorded_value: '4 °C' });

    const comma = await logReading(tenant, ccp.id, { recorded_value: '3,5' });
    expect(comma.body).toMatchObject({ within_limits: true, numeric_value: 3.5, recorded_value: '3.5 °C' });
    expect((await logReading(tenant, ccp.id, { numeric_value: 0 })).body.within_limits).toBe(true);

    // Hors limites : action corrective obligatoire, même si le client affirme le contraire.
    const lying = await logReading(tenant, ccp.id, { numeric_value: 7, within_limits: true });
    expect(lying.status).toBe(400);
    expect(lying.body.error).toContain('action corrective');
    const drift = await logReading(tenant, ccp.id, { numeric_value: 4.1, within_limits: true, corrective_action_taken: 'Lot mis en quarantaine' });
    expect(drift.status).toBe(201);
    expect(drift.body.within_limits).toBe(false);
    expect((await logReading(tenant, ccp.id, { numeric_value: -0.5, corrective_action_taken: 'Réglage du groupe froid' })).body.within_limits).toBe(false);
  });

  it('refuse un texte non numérique quand le CCP a des limites chiffrées', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant);
    const res = await logReading(tenant, ccp.id, { recorded_value: 'environ 4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('numérique');
    expect((await logReading(tenant, ccp.id, {})).status).toBe(400);
  });

  it('sans limites chiffrées : comportement d’origine (valeur texte + verdict saisi obligatoires)', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant, { ccp: { limit_min: '', limit_max: '', limit_unit: '' } });
    expect((await logReading(tenant, ccp.id, { recorded_value: 'Aspect conforme' })).status).toBe(400); // verdict manquant
    const ok = await logReading(tenant, ccp.id, { recorded_value: 'Aspect conforme', within_limits: true });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ within_limits: true, recorded_value: 'Aspect conforme', numeric_value: null });
    expect((await logReading(tenant, ccp.id, { recorded_value: 'Odeur anormale', within_limits: false })).status).toBe(400); // action corrective
    expect((await logReading(tenant, ccp.id, { recorded_value: 'Odeur anormale', within_limits: false, corrective_action_taken: 'Lot écarté' })).body.within_limits).toBe(false);
  });

  it('services : parseNumber, isWithinLimits, evaluateReading', () => {
    expect(parseNumber('3,5')).toBe(3.5);
    expect(parseNumber(' -2 ')).toBe(-2);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1,2,3')).toBeNull();
    const limits = numericLimitsOf({ limit_min: 0, limit_max: 4, limit_unit: '°C' });
    expect(isWithinLimits(4, limits)).toBe(true);
    expect(isWithinLimits(4.01, limits)).toBe(false);
    expect(isWithinLimits(0, limits)).toBe(true);
    expect(isWithinLimits(2, { min: null, max: 4 })).toBe(true);
    expect(numericLimitsOf({ limit_min: null, limit_max: null })).toBeNull();
    expect(evaluateReading({ limit_min: 63, limit_max: null, limit_unit: '°C' }, { numeric_value: 60 })).toMatchObject({ withinLimits: false, recordedValue: '60 °C' });
  });
});

describe('Dérives répétées', () => {
  it('le 3e relevé hors limites sur 7 jours le signale, notifie le responsable et l’auteur du plan', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const { ccp } = await buildPlan(tenant, { ccp: { monitoring_responsible: manager.id } });
    const drift = (value) => logReading(tenant, ccp.id, { numeric_value: value, corrective_action_taken: 'Action immédiate' });

    expect((await drift(6)).body.repeated_deviation).toBeNull();
    expect((await drift(7)).body.repeated_deviation).toBeNull();
    const third = await drift(8);
    expect(third.body.repeated_deviation).toEqual({ count: 3 });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (const user of [manager, tenant.admin]) {
      const { data } = await admin.from('notifications').select('type, link').eq('user_id', user.id).eq('type', 'haccp_repeated_deviation');
      expect(data).toHaveLength(1);
    }
    // Un relevé conforme n'ajoute rien.
    expect((await logReading(tenant, ccp.id, { numeric_value: 2 })).body.repeated_deviation).toBeNull();
  });

  it('le CCP et le plan remontent la dérive répétée ; les vieilles dérives ne comptent pas', async () => {
    const tenant = await newTenant();
    const { plan, ccp } = await buildPlan(tenant);
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    await admin.from('haccp_monitoring_logs').insert([1, 2, 3].map(() => ({ tenant_id: tenant.tenantId, ccp_id: ccp.id, recorded_value: '9 °C', numeric_value: 9, within_limits: false, recorded_at: old })));
    let detail = await getPlan(tenant, plan.id);
    expect(detail.steps[0].hazards[0].ccp).toMatchObject({ repeated_deviation: false, recent_deviations: 0 });

    await logReading(tenant, ccp.id, { numeric_value: 9, corrective_action_taken: 'a' });
    await logReading(tenant, ccp.id, { numeric_value: 9, corrective_action_taken: 'a' });
    await logReading(tenant, ccp.id, { numeric_value: 9, corrective_action_taken: 'a' });
    detail = await getPlan(tenant, plan.id);
    expect(detail.steps[0].hazards[0].ccp).toMatchObject({ repeated_deviation: true, recent_deviations: 3 });
  });
});

describe('État de surveillance et rappels', () => {
  it('monitoringState : sans intervalle, à jour, bientôt dû, en retard, jamais relevé (part de la création du CCP)', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const ccp = { monitoring_interval_hours: 12, created_at: '2026-06-01T00:00:00Z' };
    expect(monitoringState({ ...ccp, monitoring_interval_hours: null }, null, now).state).toBe('no_schedule');
    expect(monitoringState(ccp, '2026-06-10T08:00:00Z', now).state).toBe('ok'); // dû à 20:00
    expect(monitoringState(ccp, '2026-06-10T00:30:00Z', now).state).toBe('due_soon'); // dû à 12:30
    const late = monitoringState(ccp, '2026-06-09T20:00:00Z', now); // dû à 08:00 → 4 h de retard
    expect(late).toMatchObject({ state: 'overdue', overdue_hours: 4 });
    expect(monitoringState(ccp, null, now).state).toBe('overdue'); // création le 1er juin, jamais relevé
    expect(monitoringState({ ...ccp, created_at: '2026-06-10T11:00:00Z' }, null, now).state).toBe('ok');
  });

  it('fenêtre horaire des rappels : heure locale de l’entreprise (6 h – 20 h)', () => {
    expect(isWithinReminderHours(new Date('2026-06-10T02:00:00Z'), 'Indian/Reunion')).toBe(true); // 06:00 à La Réunion
    expect(isWithinReminderHours(new Date('2026-06-10T00:00:00Z'), 'Indian/Reunion')).toBe(false); // 04:00
    expect(isWithinReminderHours(new Date('2026-06-10T16:00:00Z'), 'Indian/Reunion')).toBe(false); // 20:00
    expect(isWithinReminderHours(new Date('2026-06-10T12:00:00Z'), 'UTC')).toBe(true);
    expect(isWithinReminderHours(new Date('2026-06-10T12:00:00Z'), 'Fuseau/Inconnu')).toBe(true); // repli UTC
  });

  it('un CCP jamais relevé depuis 30 h (intervalle 12 h) est en retard sur un plan ACTIF seulement ; un relevé le remet à jour', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }] });
    const manager = tenant.users[0];
    const { plan, ccp } = await buildPlan(tenant, { ccp: { monitoring_responsible: manager.id } });
    await admin.from('haccp_ccps').update({ created_at: new Date(Date.now() - 30 * 3600000).toISOString() }).eq('id', ccp.id);

    // Plan brouillon : pas de rappel.
    expect(await getOverdueReadingAlerts(tenant.tenantId)).toEqual([]);
    expect((await getPlan(tenant, plan.id)).steps[0].hazards[0].ccp.monitoring_state).toBe('overdue');

    expect((await activate(tenant, plan.id)).status).toBe(200);
    const alerts = await getOverdueReadingAlerts(tenant.tenantId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].user_id).toBe(manager.id);
    expect(alerts[0].ccp.overdue_hours).toBeGreaterThanOrEqual(17);

    await logReading(tenant, ccp.id, { numeric_value: 3 });
    expect(await getOverdueReadingAlerts(tenant.tenantId)).toEqual([]);
    const after = (await getPlan(tenant, plan.id)).steps[0].hazards[0].ccp;
    expect(after.monitoring_state).toBe('ok');
    expect(after.last_reading).toMatchObject({ recorded_value: '3 °C', within_limits: true });
  });

  it('sans responsable, le rappel va à l’auteur du plan ; le job n’envoie qu’une notification par jour', async () => {
    const tenant = await newTenant();
    const { plan, ccp } = await buildPlan(tenant);
    await activate(tenant, plan.id);
    await admin.from('haccp_ccps').update({ created_at: new Date(Date.now() - 30 * 3600000).toISOString() }).eq('id', ccp.id);
    const [alert] = await getOverdueReadingAlerts(tenant.tenantId);
    expect(alert.user_id).toBe(tenant.admin.id);

    // Midi UTC : dans la fenêtre horaire (fuseau UTC par défaut).
    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    await runHaccpReminderJob(noon);
    await runHaccpReminderJob(noon);
    const { data } = await admin.from('notifications').select('type, link, message').eq('user_id', tenant.admin.id).eq('type', 'haccp_reading_overdue');
    expect(data).toHaveLength(1);
    expect(data[0].link).toBe('/haccp/today');
  });

  it('hors fenêtre horaire (3 h du matin), aucun rappel', async () => {
    const tenant = await newTenant();
    const { plan, ccp } = await buildPlan(tenant);
    await activate(tenant, plan.id);
    await admin.from('haccp_ccps').update({ created_at: new Date(Date.now() - 30 * 3600000).toISOString() }).eq('id', ccp.id);
    const night = new Date();
    night.setUTCHours(3, 0, 0, 0);
    await runHaccpReminderJob(night);
    const { data } = await admin.from('notifications').select('id').eq('user_id', tenant.admin.id).eq('type', 'haccp_reading_overdue');
    expect(data).toHaveLength(0);
  });
});

describe('Relevés du jour (GET /haccp/monitoring-due)', () => {
  it('liste les CCP des plans actifs, en retard d’abord, « mes CCP » avant les autres ; visible d’un member', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const a = await buildPlan(tenant, { plan: { title: 'Plan A' }, ccp: { monitoring_responsible: member.id } });
    const b = await buildPlan(tenant, { plan: { title: 'Plan B' }, ccp: { monitoring_interval_hours: 12 } });
    const draft = await buildPlan(tenant, { plan: { title: 'Plan brouillon' } });
    await activate(tenant, a.plan.id);
    await activate(tenant, b.plan.id);
    // B est en retard ; A vient d'être relevé.
    await admin.from('haccp_ccps').update({ created_at: new Date(Date.now() - 30 * 3600000).toISOString() }).eq('id', b.ccp.id);
    await logReading(tenant, a.ccp.id, { numeric_value: 2 });

    const res = await request(app).get('/api/haccp/monitoring-due').set(auth(member.token));
    expect(res.status).toBe(200);
    expect(res.body.items.map((item) => item.plan.title)).toEqual(['Plan B', 'Plan A']);
    expect(res.body.items.find((item) => item.plan.id === draft.plan.id)).toBeUndefined();
    expect(res.body.items[0]).toMatchObject({ monitoring_state: 'overdue', is_mine: false, limits: { min: 0, max: 4, unit: '°C' }, ccp_number: 'CCP1' });
    expect(res.body.items[1]).toMatchObject({ monitoring_state: 'ok', is_mine: true, last_reading: { recorded_value: '2 °C' } });
    expect(res.body.counts).toMatchObject({ total: 2, overdue: 1 });
  });

  it('un plan d’une catégorie restreinte n’apparaît pas pour un member qui n’y a pas accès', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const member = tenant.users[0];
    const category = await request(app).post('/api/module-categories').set(auth(tenant.admin.token)).send({ resource_type: 'haccp_plan', name: 'Confidentiel', is_restricted: true });
    expect(category.status).toBe(201);
    const secret = await buildPlan(tenant, { plan: { title: 'Plan confidentiel', category_id: category.body.id } });
    await activate(tenant, secret.plan.id);

    expect((await request(app).get('/api/haccp/monitoring-due').set(auth(tenant.admin.token))).body.items).toHaveLength(1);
    expect((await request(app).get('/api/haccp/monitoring-due').set(auth(member.token))).body.items).toHaveLength(0);
    expect((await request(app).get(`/api/haccp/ccps/${secret.ccp.id}/monitoring-summary`).set(auth(member.token))).status).toBe(404);
    expect((await request(app).get(`/api/haccp/ccps/${secret.ccp.id}/pdf`).set(auth(member.token))).status).toBe(404);
  });
});

describe('Synthèse de surveillance d’un CCP', () => {
  it('points, limites, taux de conformité, moyenne / min / max ; période bornée', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant);
    for (const value of [2, 3, 4]) await logReading(tenant, ccp.id, { numeric_value: value });
    await logReading(tenant, ccp.id, { numeric_value: 6, corrective_action_taken: 'Quarantaine' });
    await admin.from('haccp_monitoring_logs').insert({ tenant_id: tenant.tenantId, ccp_id: ccp.id, recorded_value: '1 °C', numeric_value: 1, within_limits: true, recorded_at: new Date(Date.now() - 60 * 86400000).toISOString() });

    const res = await request(app).get(`/api/haccp/ccps/${ccp.id}/monitoring-summary?days=30`).set(auth(tenant.admin.token));
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.limits).toEqual({ min: 0, max: 4, unit: '°C' });
    expect(res.body.limits_text).toBe('≥ 0 °C et ≤ 4 °C');
    expect(res.body.stats).toEqual({ total: 4, within: 3, out: 1, conformity_percent: 75, average: 3.75, min: 2, max: 6 });
    expect(res.body.points).toHaveLength(4);
    expect(res.body.points[3]).toMatchObject({ value: 6, within_limits: false });

    const wide = await request(app).get(`/api/haccp/ccps/${ccp.id}/monitoring-summary?days=90`).set(auth(tenant.admin.token));
    expect(wide.body.stats.total).toBe(5);
    expect((await request(app).get(`/api/haccp/ccps/${ccp.id}/monitoring-summary?days=abc`).set(auth(tenant.admin.token))).body.days).toBe(30);
  });

  it('404 hors tenant', async () => {
    const tenant = await newTenant();
    const other = await newTenant();
    const { ccp } = await buildPlan(tenant);
    expect((await request(app).get(`/api/haccp/ccps/${ccp.id}/monitoring-summary`).set(auth(other.admin.token))).status).toBe(404);
  });
});

describe('Revue annuelle et versions d’un plan', () => {
  it('l’activation enregistre une version « activation » et fixe la revue à +12 mois ; « marquer revu » ajoute une version', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const { plan } = await buildPlan(tenant);
    const activated = await activate(tenant, plan.id);
    expect(activated.body.review_date).toBeTruthy();
    expect(activated.body.review_date > isoDate(360)).toBe(true);

    let revisions = (await request(app).get(`/api/haccp/plans/${plan.id}/revisions`).set(auth(tenant.users[0].token))).body;
    expect(revisions.revisions).toHaveLength(1);
    expect(revisions.revisions[0]).toMatchObject({ revision_number: 1, kind: 'activation', reason: 'Plan activé' });
    expect(revisions.pending_changes).toEqual([]);

    const review = await request(app).post(`/api/haccp/plans/${plan.id}/review`).set(auth(tenant.admin.token)).send({ next_review_date: isoDate(180), reason: 'Revue annuelle 2026' });
    expect(review.status).toBe(200);
    expect(review.body.plan).toMatchObject({ review_date: isoDate(180), last_reviewed_by: tenant.admin.id });
    expect(review.body.plan.last_reviewed_at).toBeTruthy();
    expect(review.body.revision).toMatchObject({ revision_number: 2, kind: 'review', reason: 'Revue annuelle 2026' });

    revisions = (await request(app).get(`/api/haccp/plans/${plan.id}/revisions`).set(auth(tenant.admin.token))).body;
    expect(revisions.revisions.map((r) => r.revision_number)).toEqual([2, 1]);
    expect(revisions.revisions[1].changes).toEqual(['Première version du plan.']);
    expect(revisions.revisions[0].changes).toEqual(['Aucune modification de conception.']);
  });

  it('détecte ce qui a changé : danger ajouté, CCP modifié, statut — dans les versions et depuis la dernière', async () => {
    const tenant = await newTenant();
    const { plan, step, ccp } = await buildPlan(tenant);
    await activate(tenant, plan.id);

    await request(app).patch(`/api/haccp/ccps/${ccp.id}`).set(auth(tenant.admin.token)).send({ limit_max: 5, critical_limits: '≤ 5 °C' });
    await request(app).post(`/api/haccp/steps/${step.id}/hazards`).set(auth(tenant.admin.token)).send({ hazard_type: 'chemical', description: 'Résidus de nettoyage', likelihood: 2, severity: 3 });

    const pending = (await request(app).get(`/api/haccp/plans/${plan.id}/revisions`).set(auth(tenant.admin.token))).body.pending_changes;
    expect(pending.some((line) => line.startsWith('Danger ajouté : « Résidus de nettoyage »'))).toBe(true);
    expect(pending.some((line) => line.includes('CCP CCP1') && line.includes('limite max') && line.includes('limites critiques'))).toBe(true);

    const manual = await request(app).post(`/api/haccp/plans/${plan.id}/revisions`).set(auth(tenant.admin.token)).send({ reason: 'Après revue du procédé' });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ revision_number: 2, kind: 'manual' });
    const listed = (await request(app).get(`/api/haccp/plans/${plan.id}/revisions`).set(auth(tenant.admin.token))).body;
    expect(listed.revisions[0].changes.some((line) => line.startsWith('Danger ajouté'))).toBe(true);
    expect(listed.pending_changes).toEqual([]);
  });

  it('droits : un member consulte mais ne crée rien ; un plan archivé ne se revoit pas ; 404 hors tenant', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const member = tenant.users[0];
    const { plan } = await buildPlan(tenant);

    expect((await request(app).post(`/api/haccp/plans/${plan.id}/review`).set(auth(member.token)).send({})).status).toBe(403);
    expect((await request(app).post(`/api/haccp/plans/${plan.id}/revisions`).set(auth(member.token)).send({})).status).toBe(403);
    expect((await request(app).get(`/api/haccp/plans/${plan.id}/revisions`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).post(`/api/haccp/plans/${plan.id}/review`).set(auth(tenant.admin.token)).send({ reason: 'x'.repeat(501) })).status).toBe(400);

    await request(app).patch(`/api/haccp/plans/${plan.id}`).set(auth(tenant.admin.token)).send({ status: 'archived' });
    expect((await request(app).post(`/api/haccp/plans/${plan.id}/review`).set(auth(tenant.admin.token)).send({})).status).toBe(400);
  });

  it('diffSnapshots : première version, plan et étapes', () => {
    const base = { plan: { title: 'P', status: 'draft' }, steps: [{ id: 's1', step_number: 1, name: 'Réception', description: null, hazards: [] }] };
    expect(diffSnapshots(null, base)).toEqual(['Première version du plan.']);
    const changed = { plan: { title: 'P', status: 'active' }, steps: [{ id: 's1', step_number: 1, name: 'Réception des matières', description: null, hazards: [] }, { id: 's2', step_number: 2, name: 'Stockage', description: null, hazards: [] }] };
    expect(diffSnapshots(base, changed)).toEqual(['Statut : Brouillon → Actif', 'Étape ajoutée : étape 2 — Stockage', 'Étape modifiée : étape 1 — Réception des matières (nom)']);
    expect(diffSnapshots(changed, base)).toContain('Étape supprimée : étape 2 — Stockage');
  });

  it('rappels de revue du plan : responsable de la dernière revue (sinon auteur), plans non archivés, sur un jalon', async () => {
    const tenant = await newTenant();
    const inSeven = await buildPlan(tenant, { plan: { title: 'Dans 7 jours' } });
    const today = await buildPlan(tenant, { plan: { title: 'Aujourd’hui' } });
    const notMilestone = await buildPlan(tenant, { plan: { title: 'Dans 3 jours' } });
    const archived = await buildPlan(tenant, { plan: { title: 'Archivé' } });
    const patch = (id, body) => request(app).patch(`/api/haccp/plans/${id}`).set(auth(tenant.admin.token)).send(body);
    await patch(inSeven.plan.id, { review_date: isoDate(7) });
    await patch(today.plan.id, { review_date: isoDate(0) });
    await patch(notMilestone.plan.id, { review_date: isoDate(3) });
    await patch(archived.plan.id, { review_date: isoDate(0), status: 'archived' });

    const alerts = (await getHaccpReviewAlerts(tenant.tenantId)).sort((a, b) => a.days_remaining - b.days_remaining);
    expect(alerts.map((alert) => alert.title)).toEqual(['Aujourd’hui', 'Dans 7 jours']);
    expect(alerts.every((alert) => alert.user_id === tenant.admin.id)).toBe(true);
  });
});

describe('Liens d’un plan et formations des opérateurs', () => {
  it('rattache un fournisseur, une formation et une procédure ; doublon 409 ; autre tenant 404 ; member en lecture seule', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const { plan } = await buildPlan(tenant);
    const supplier = await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Laiterie du Sud' });
    const training = await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Hygiène — chaîne du froid' });
    const procedure = await request(app).post('/api/procedures').set(auth(tenant.admin.token)).send({ number: 'PR-HACCP', title: 'Relevé des températures' });
    const foreign = await request(app).post('/api/suppliers').set(auth(other.admin.token)).send({ name: 'Étranger' });
    const link = (kind, id, token = tenant.admin.token) => request(app).post(`/api/haccp/plans/${plan.id}/links`).set(auth(token)).send({ kind, ref_id: id });

    expect((await link('supplier', supplier.body.id)).status).toBe(201);
    expect((await link('training', training.body.id)).status).toBe(201);
    const last = await link('procedure', procedure.body.id);
    expect(last.body.map((item) => [item.kind, item.title])).toEqual([
      ['supplier', 'Laiterie du Sud'],
      ['training', 'Hygiène — chaîne du froid'],
      ['procedure', 'PR-HACCP — Relevé des températures'],
    ]);
    expect((await link('supplier', supplier.body.id)).status).toBe(409);
    expect((await link('supplier', foreign.body.id)).status).toBe(404);
    expect((await link('audit', supplier.body.id)).status).toBe(400);
    expect((await link('supplier', supplier.body.id, tenant.users[0].token)).status).toBe(403);

    expect((await request(app).get(`/api/haccp/plans/${plan.id}/links`).set(auth(tenant.users[0].token))).body).toHaveLength(3);
    expect((await request(app).get(`/api/haccp/plans/${plan.id}/links`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get('/api/haccp/link-candidates?kind=supplier').set(auth(tenant.admin.token))).body).toEqual([{ id: supplier.body.id, title: 'Laiterie du Sud' }]);
    expect((await request(app).get('/api/haccp/link-candidates?kind=kpi').set(auth(tenant.admin.token))).status).toBe(400);

    const linkId = last.body[0].id;
    expect((await request(app).delete(`/api/haccp/plans/${plan.id}/links/${linkId}`).set(auth(tenant.admin.token))).status).toBe(204);
    expect((await request(app).delete(`/api/haccp/plans/${plan.id}/links/${linkId}`).set(auth(tenant.admin.token))).status).toBe(404);
  });

  it('couverture de formation : valide / échue / échec / jamais suivie / dispensé pour les responsables de surveillance', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'manager' }, { role: 'member' }, { role: 'member' }, { role: 'member' }, { role: 'member' }] });
    const [valid, expired, failed, none, exempt] = tenant.users;
    const { plan, step } = await buildPlan(tenant, { ccp: { monitoring_responsible: valid.id } });
    // Un CCP par personne suivie : la couverture se calcule sur les responsables de surveillance.
    for (const [index, user] of [expired, failed, none, exempt].entries()) {
      const hazard = await request(app).post(`/api/haccp/steps/${step.id}/hazards`).set(auth(tenant.admin.token)).send({ hazard_type: 'physical', description: `Corps étranger ${index}`, likelihood: 2, severity: 3 });
      await request(app).patch(`/api/haccp/hazards/${hazard.body.id}`).set(auth(tenant.admin.token)).send({ is_significant: true });
      await request(app).post(`/api/haccp/hazards/${hazard.body.id}/ccps`).set(auth(tenant.admin.token)).send({ critical_limits: 'x', monitoring_procedure: 'y', monitoring_responsible: user.id });
    }
    await admin.from('users').update({ training_exempt: true }).eq('id', exempt.id);

    const training = await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Hygiène alimentaire' });
    await request(app).post(`/api/haccp/plans/${plan.id}/links`).set(auth(tenant.admin.token)).send({ kind: 'training', ref_id: training.body.id });
    const insert = (user, extra) => admin.from('training_records').insert({ tenant_id: tenant.tenantId, training_id: training.body.id, user_id: user.id, completed_at: isoDate(-100), ...extra });
    await insert(valid, { next_due_date: isoDate(200) });
    await insert(expired, { next_due_date: isoDate(-5) });
    await insert(failed, { next_due_date: null });
    await admin.from('training_records').update({ evaluation_result: false }).eq('user_id', failed.id);

    const res = await request(app).get(`/api/haccp/plans/${plan.id}/training-coverage`).set(auth(tenant.admin.token));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.trainings[0].people.map((person) => [person.user_id, person.status]));
    expect(byName).toEqual({ [valid.id]: 'valid', [expired.id]: 'expired', [failed.id]: 'failed', [none.id]: 'none', [exempt.id]: 'exempt' });
    expect(res.body.people_without_training).toBe(3);
  });

  it('trainingStatus : pas de réalisation, échec, échue, valide (sans échéance aussi)', () => {
    expect(trainingStatus(null)).toBe('none');
    expect(trainingStatus({ evaluation_result: false })).toBe('failed');
    expect(trainingStatus({ next_due_date: '2020-01-01' }, '2026-01-01')).toBe('expired');
    expect(trainingStatus({ next_due_date: '2030-01-01' }, '2026-01-01')).toBe('valid');
    expect(trainingStatus({ next_due_date: null })).toBe('valid');
  });
});

describe('Exports : Word du plan, fiche CCP, fiche de relevés vierge', () => {
  it('Word du plan : rubriques, limites chiffrées, revue ; 404 hors tenant ; 401 sans jeton', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const { plan } = await buildPlan(tenant, { plan: { title: 'Plan yaourt', product_description: 'Yaourt nature' } });
    await activate(tenant, plan.id);

    const res = await request(app).get(`/api/haccp/plans/${plan.id}/word`).set(auth(tenant.users[0].token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('wordprocessingml');
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(res.body) });
    for (const expected of ['Plan yaourt', 'Analyse des dangers', 'Points critiques (CCP)', 'Surveillance — synthèse', 'Prolifération de Listeria', '≥ 0 °C et ≤ 4 °C', 'Jamais revu', 'Prochaine revue']) {
      expect(value).toContain(expected);
    }
    expect((await request(app).get(`/api/haccp/plans/${plan.id}/word`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/haccp/plans/${plan.id}/word`)).status).toBe(401);
  });

  it('PDF du plan : limites chiffrées et revue affichées', async () => {
    const tenant = await newTenant();
    const { plan } = await buildPlan(tenant);
    const res = await request(app).get(`/api/haccp/plans/${plan.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    const { text } = await pdfParse(Buffer.from(res.body));
    expect(text).toContain('0 °C');
    expect(text).toContain('PROCHAINE REVUE');
  });

  it('fiche CCP (PDF) : définition, synthèse et derniers relevés', async () => {
    const tenant = await newTenant();
    const { ccp } = await buildPlan(tenant);
    await logReading(tenant, ccp.id, { numeric_value: 3 });
    await logReading(tenant, ccp.id, { numeric_value: 8, corrective_action_taken: 'Lot mis en quarantaine' });

    const res = await request(app).get(`/api/haccp/ccps/${ccp.id}/pdf`).set(auth(tenant.admin.token)).responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const { text } = await pdfParse(Buffer.from(res.body));
    for (const expected of ['CCP CCP1', 'Relevé de la sonde', '≥ 0 °C et ≤ 4 °C', 'Taux de conformité', '50 %', 'Lot mis en quarantaine', 'Hors limites']) {
      expect(text).toContain(expected);
    }
  });

  it('fiche de relevés vierge (PDF) : limites, fréquence, colonnes à remplir', async () => {
    const tenant = await newTenant({ extraUsers: [{ role: 'member' }] });
    const other = await newTenant();
    const { ccp } = await buildPlan(tenant);
    const res = await request(app).get(`/api/haccp/ccps/${ccp.id}/record-sheet`).set(auth(tenant.users[0].token)).responseType('blob');
    expect(res.status).toBe(200);
    const buffer = Buffer.from(res.body);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const { text } = await pdfParse(buffer);
    for (const expected of ['Fiche de relevés', 'CCP CCP1', '2 fois par jour', 'Valeur relevée', 'Visa', 'Action corrective']) {
      expect(text).toContain(expected);
    }
    expect((await request(app).get(`/api/haccp/ccps/${ccp.id}/record-sheet`).set(auth(other.admin.token))).status).toBe(404);
    expect((await request(app).get(`/api/haccp/ccps/${ccp.id}/pdf`).set(auth(other.admin.token))).status).toBe(404);
  });
});

describe('Tableau de bord et préférence d’alerte', () => {
  it('le dashboard compte les CCP en retard et en dérive répétée', async () => {
    const tenant = await newTenant();
    const { plan, ccp } = await buildPlan(tenant);
    await activate(tenant, plan.id);
    await admin.from('haccp_ccps').update({ created_at: new Date(Date.now() - 30 * 3600000).toISOString() }).eq('id', ccp.id);
    let stats = (await request(app).get('/api/dashboard/stats').set(auth(tenant.admin.token))).body;
    expect(stats.haccp).toMatchObject({ active_plans: 1, overdue_ccps: 1, deviating_ccps: 0 });

    for (let i = 0; i < 3; i += 1) await logReading(tenant, ccp.id, { numeric_value: 9, corrective_action_taken: 'a' });
    stats = (await request(app).get('/api/dashboard/stats').set(auth(tenant.admin.token))).body;
    expect(stats.haccp).toMatchObject({ overdue_ccps: 0, deviating_ccps: 1 });
  });

  it('la préférence email_haccp_alerts existe (activée par défaut) et se désactive', async () => {
    const tenant = await newTenant();
    expect((await request(app).get('/api/users/me/notification-preferences').set(auth(tenant.admin.token))).body.email_haccp_alerts).toBe(true);
    const off = await request(app).patch('/api/users/me/notification-preferences').set(auth(tenant.admin.token)).send({ email_haccp_alerts: false });
    expect(off.body.email_haccp_alerts).toBe(false);
  });
});
