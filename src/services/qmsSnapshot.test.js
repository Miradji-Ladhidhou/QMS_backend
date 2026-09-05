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
      .send({ status: 'resolved' });

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
      .send({ status: 'closed' });

    const late = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée en retard', due_date: isoDate(-1) });
    await request(app)
      .patch(`/api/capas/${late.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });

    const noDueDate = await request(app)
      .post('/api/capas')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ title: 'CAPA clôturée sans échéance' });
    await request(app)
      .patch(`/api/capas/${noDueDate.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ status: 'closed' });

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
      .send({ status: 'closed' });

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
      .send({ status: 'accepted' });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart, periodEnd });
    expect(snapshot.risks_open.critical).toBe(1);
  });
});
