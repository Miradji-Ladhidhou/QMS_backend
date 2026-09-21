import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { buildQmsSnapshot } from './qmsSnapshot.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

function isoDate(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

describe('buildQmsSnapshot — sans période, non-régression', () => {
  it('renvoie exactement la forme à 6 clés existante (aucune clé period-scoped ajoutée)', async () => {
    tenant = await createTenant();
    const snapshot = await buildQmsSnapshot(tenant.tenantId);
    expect(Object.keys(snapshot).sort()).toEqual(['audits', 'capas', 'documents', 'generated_at', 'kpis', 'trainings']);
  });
});

describe('buildQmsSnapshot — avec période : les 5 groupes agrégés', () => {
  it('KPI : moyenne de la période vs. moyenne de la période précédente de même durée', async () => {
    tenant = await createTenant();
    const kpi = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'Taux de service', target: 90, target_direction: 'min' });

    const periodStart = isoDate(-10);
    const periodEnd = isoDate(0);
    const previousPeriodPoint = isoDate(-20); // période précédente = même durée (11 jours), juste avant periodStart

    await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: periodStart, value: 80 });
    await request(app)
      .post(`/api/kpis/${kpi.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: previousPeriodPoint, value: 60 });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    const trend = snapshot.kpi_trend.find((k) => k.id === kpi.body.id);
    expect(trend.current_avg).toBe(80);
    expect(trend.previous_avg).toBe(60);
    expect(trend.trend).toBe('up');
  });

  it('Audits : compte sur planned_date (pas completed_date) et répartition des constats par type', async () => {
    tenant = await createTenant();
    const periodStart = isoDate(-5);
    const periodEnd = isoDate(5);

    const audit = await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit interne process', planned_date: isoDate(0) });
    await request(app)
      .post(`/api/audits/${audit.body.id}/findings`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ type: 'major_nc', description: 'Non-conformité majeure de test' });

    // Hors période : ne doit pas être compté.
    await request(app)
      .post('/api/audits')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Audit hors période', planned_date: isoDate(-100) });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.audits_period.count).toBe(1);
    expect(snapshot.audits_period.findings_by_type.major_nc).toBe(1);
    expect(snapshot.audits_period.findings_by_type.minor_nc).toBe(0);
  });

  it('Réclamations : reçues sur la période, dont encore ouvertes maintenant', async () => {
    tenant = await createTenant();
    const periodStart = isoDate(-5);
    const periodEnd = isoDate(5);

    await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Client A', received_date: isoDate(0), description: 'Réclamation restée ouverte' });

    const willBeResolved = await request(app)
      .post('/api/complaints')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ customer_name: 'Client B', received_date: isoDate(0), description: 'Réclamation qui sera résolue' });
    await request(app)
      .patch(`/api/complaints/${willBeResolved.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'resolved', resolution: 'Réclamation traitée.' });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.complaints_period.received).toBe(2);
    expect(snapshot.complaints_period.still_open).toBe(1);
  });

  it('CAPA : in_progress global (non period-scopé), clôturées sur la période, taux de clôture dans les délais excluant les échéances nulles', async () => {
    tenant = await createTenant();
    const periodStart = isoDate(-5);
    const periodEnd = isoDate(5);

    const inProgress = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA en cours' });
    await request(app)
      .patch(`/api/capas/${inProgress.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'in_progress' });

    const onTime = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée à temps', due_date: isoDate(1) });
    await request(app)
      .patch(`/api/capas/${onTime.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'closed',
        corrective_action: 'Action corrective appliquée',
        effectiveness_verified: true,
        effectiveness_notes: 'Contrôle de suivi sans récidive, action jugée efficace.',
      });

    const late = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée en retard', due_date: isoDate(-1) });
    await request(app)
      .patch(`/api/capas/${late.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'closed',
        corrective_action: 'Action corrective appliquée',
        effectiveness_verified: true,
        effectiveness_notes: 'Contrôle de suivi sans récidive, action jugée efficace.',
      });

    const noDueDate = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée sans échéance' });
    await request(app)
      .patch(`/api/capas/${noDueDate.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'closed',
        corrective_action: 'Action corrective appliquée',
        effectiveness_verified: true,
        effectiveness_notes: 'Contrôle de suivi sans récidive, action jugée efficace.',
      });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.capas_period.in_progress).toBe(1);
    expect(snapshot.capas_period.closed_in_period).toBe(3);
    // Notées : onTime + late (2), noDueDate exclue du dénominateur -> 1/2 = 50%.
    expect(snapshot.capas_period.on_time_closure_rate).toBe(50);
  });

  it('CAPA : taux à null (pas 0) quand aucune CAPA clôturée sur la période n’a d’échéance', async () => {
    tenant = await createTenant();
    const periodStart = isoDate(-5);
    const periodEnd = isoDate(5);

    const noDueDate = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée sans échéance' });
    await request(app)
      .patch(`/api/capas/${noDueDate.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({
        status: 'closed',
        corrective_action: 'Action corrective appliquée',
        effectiveness_verified: true,
        effectiveness_notes: 'Contrôle de suivi sans récidive, action jugée efficace.',
      });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.capas_period.closed_in_period).toBe(1);
    expect(snapshot.capas_period.on_time_closure_rate).toBeNull();
  });

  it('Risques : répartition par gravité, seulement les risques ouverts (accepted/closed exclus)', async () => {
    tenant = await createTenant();
    const periodStart = isoDate(-5);
    const periodEnd = isoDate(5);

    await request(app)
      .post('/api/risks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Risque critique', likelihood: 5, impact: 5 });

    const accepted = await request(app)
      .post('/api/risks')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'Risque accepté, ne doit pas compter', likelihood: 5, impact: 5 });
    await request(app)
      .patch(`/api/risks/${accepted.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'accepted', residual_likelihood: 2, residual_impact: 2 });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.risks_open.critical).toBe(1);
  });
});

describe('buildQmsSnapshot — éléments d\'entrée complémentaires (satisfaction, fournisseurs, NC, accidents, compétences, politique)', () => {
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const period = { periodStart: isoDate(-30), periodEnd: isoDate(0) };

  it('sans aucune donnée : des zéros et des null propres, jamais d\'erreur', async () => {
    tenant = await createTenant();
    const snapshot = await buildQmsSnapshot(tenant.tenantId, period);
    expect(snapshot.satisfaction_period).toEqual({ count: 0, average_score: null, satisfied_rate: null });
    expect(snapshot.suppliers_period).toEqual({ active: 0, evaluations: 0, average_score: null, under_watch: 0, to_replace: 0, overdue_evaluations: 0 });
    expect(snapshot.nonconforming_period).toEqual({ detected: 0, still_open: 0, by_disposition: {} });
    expect(snapshot.accidents_period).toEqual({ count: 0, with_lost_time: 0, lost_days: 0, still_open: 0, by_severity: {} });
    expect(snapshot.competences).toMatchObject({ records_tracked: 0, compliance_rate: null, auditors: { designated: false, qualified: 0 } });
    expect(snapshot.quality_policy).toEqual({ defined: false, last_updated: null, acknowledged: 0, users: 0 });
  });

  it('satisfaction : moyenne sur 5 et part des notes ≥ 4, bornées à la période', async () => {
    tenant = await createTenant();
    for (const [score, days] of [[5, -5], [4, -6], [2, -7], [1, -90]]) {
      await request(app).post('/api/customer-satisfaction').set(auth(tenant.admin.token)).send({ customer_name: `Client ${score}`, survey_date: isoDate(days), method: 'email', score }).expect(201);
    }
    const { satisfaction_period: sat } = await buildQmsSnapshot(tenant.tenantId, period);
    // La note de 1, il y a 90 jours, est hors période.
    expect(sat).toEqual({ count: 3, average_score: 3.7, satisfied_rate: 67 });
  });

  it('fournisseurs : évaluations de la période, décisions et évaluations en retard', async () => {
    tenant = await createTenant();
    // « Emballages Martin » est évalué : sa prochaine évaluation est alors recalculée (plus en retard). « Autre »,
    // jamais évalué et attendu depuis 10 jours, reste la seule évaluation en retard.
    const active = (await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Emballages Martin', criticality: 'high', next_evaluation_date: isoDate(-10) })).body;
    await request(app).post('/api/suppliers').set(auth(tenant.admin.token)).send({ name: 'Autre', next_evaluation_date: isoDate(-10) }).expect(201);
    await request(app)
      .post(`/api/suppliers/${active.id}/evaluations`)
      .set(auth(tenant.admin.token))
      .send({ evaluation_date: isoDate(-3), quality_score: 4, delivery_score: 4, price_score: 3, responsiveness_score: 5, decision: 'under_watch', comment: 'Retards récurrents.' })
      .expect(201);
    const { suppliers_period: sup } = await buildQmsSnapshot(tenant.tenantId, period);
    expect(sup).toMatchObject({ active: 2, evaluations: 1, average_score: 4, under_watch: 1, to_replace: 0, overdue_evaluations: 1 });
  });

  it('sorties non conformes et accidents : comptes de la période, ouverts, répartitions', async () => {
    tenant = await createTenant();
    await request(app).post('/api/nonconforming-outputs').set(auth(tenant.admin.token)).send({ title: 'Lot A', description: 'Défaut', detected_at: isoDate(-5), disposition: 'scrap' }).expect(201);
    await request(app).post('/api/nonconforming-outputs').set(auth(tenant.admin.token)).send({ title: 'Lot B', description: 'Défaut', detected_at: isoDate(-200), disposition: 'scrap' }).expect(201);
    await request(app).post('/api/accidents').set(auth(tenant.admin.token)).send({ title: 'Chute', occurred_at: isoDate(-4), severity: 'moderate', with_lost_time: true, lost_days: 3 }).expect(201);
    await request(app).post('/api/accidents').set(auth(tenant.admin.token)).send({ title: 'Coupure', occurred_at: isoDate(-2), severity: 'minor' }).expect(201);

    const snapshot = await buildQmsSnapshot(tenant.tenantId, period);
    expect(snapshot.nonconforming_period).toEqual({ detected: 1, still_open: 1, by_disposition: { scrap: 1 } });
    expect(snapshot.accidents_period).toEqual({ count: 2, with_lost_time: 1, lost_days: 3, still_open: 2, by_severity: { moderate: 1, minor: 1 } });
  });

  it('compétences : taux de formations à jour + auditeurs qualifiés ; politique qualité : version et lecture', async () => {
    tenant = await createTenant();
    const training = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Audit interne', qualifies_internal_auditor: true, frequency_months: 12 })).body;
    const other = (await request(app).post('/api/trainings').set(auth(tenant.admin.token)).send({ title: 'Sécurité', frequency_months: 12 })).body;
    await request(app).post(`/api/trainings/${training.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: isoDate(-30) }).expect(201);
    const expired = (await request(app).post(`/api/trainings/${other.id}/records`).set(auth(tenant.admin.token)).send({ user_id: tenant.admin.id, completed_at: isoDate(-30) })).body;
    await (await import('../test-utils/tenant.js')).admin.from('training_records').update({ next_due_date: isoDate(-5) }).eq('id', expired.id);

    await request(app).post('/api/quality-policy').set(auth(tenant.admin.token)).send({ content: 'Notre politique qualité.' }).expect(201);
    const snapshot = await buildQmsSnapshot(tenant.tenantId, period);
    expect(snapshot.competences).toMatchObject({ records_tracked: 2, expired: 1, compliance_rate: 50, auditors: { designated: true, qualified: 1, to_recycle: 0, not_qualified: 0 } });
    expect(snapshot.quality_policy).toMatchObject({ defined: true, acknowledged: 0, users: 1 });
    expect(snapshot.quality_policy.last_updated).toBe(isoDate(0));
  });

  it('la sortie sans période reste inchangée (6 clés) et les nouveaux blocs figurent dans les blocs d\'entrée', async () => {
    tenant = await createTenant();
    expect(Object.keys(await buildQmsSnapshot(tenant.tenantId)).sort()).toEqual(['audits', 'capas', 'documents', 'generated_at', 'kpis', 'trainings']);
    const { buildInputBlocks } = await import('./managementReviewContent.js');
    const titles = buildInputBlocks({ input_snapshot: await buildQmsSnapshot(tenant.tenantId, period) }).map((block) => block.title);
    for (const expected of ['Satisfaction client', 'Performance des fournisseurs', 'Sorties non conformes', 'Accidents', 'Compétences et formations', 'Politique qualité']) {
      expect(titles).toContain(expected);
    }
    // Une revue plus ancienne (sans ces clés) ne casse rien.
    expect(() => buildInputBlocks({ input_snapshot: { period: { start: '2026-01-01', end: '2026-06-30' }, kpi_trend: [], audits_period: { count: 0, findings_by_type: {} }, complaints_period: { received: 0, still_open: 0 }, capas_period: {}, risks_open: {} } })).not.toThrow();
  });
});
