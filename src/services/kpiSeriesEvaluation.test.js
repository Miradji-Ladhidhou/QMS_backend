import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { buildQmsSnapshot } from './qmsSnapshot.js';
import { buildInputBlocks } from './managementReviewContent.js';

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

const auth = () => ({ Authorization: `Bearer ${tenant.admin.token}` });

// KPI à deux courbes dont les objectifs vont dans deux sens : « Livraisons » ≥ 95 % (globale, suit le KPI)
// et « Réclamations » ≤ 5 par mois (propre à la série). Livraisons à 97 → atteint ; Réclamations à 9 → non.
async function createTwoSeriesKpi({ deliveries, complaints }) {
  const kpi = await request(app).post('/api/kpis').set(auth()).send({ name: 'Service client', unit: '%', target: 95, target_direction: 'min' });
  const seriesA = await request(app).post(`/api/kpis/${kpi.body.id}/series`).set(auth()).send({ label: 'Livraisons', calc_type: 'manual' });
  const seriesB = await request(app)
    .post(`/api/kpis/${kpi.body.id}/series`)
    .set(auth())
    .send({ label: 'Réclamations', calc_type: 'manual', unit: 'réclam.', target: 5, target_direction: 'max' });
  expect(seriesB.status).toBe(201);
  const day = isoDate(-3);
  await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth()).send({ period_date: day, value: deliveries, config_id: seriesA.body.id });
  await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth()).send({ period_date: day, value: complaints, config_id: seriesB.body.id });
  return kpi.body.id;
}

describe('KPI à plusieurs séries : chaque courbe est jugée sur son propre objectif', () => {
  it('le snapshot détaille chaque courbe (valeur, unité, objectif, sens, verdict) au lieu de les moyenner', async () => {
    tenant = await createTenant();
    const kpiId = await createTwoSeriesKpi({ deliveries: 97, complaints: 9 });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart: isoDate(-10), periodEnd: isoDate(0) });
    const trend = snapshot.kpi_trend.find((k) => k.id === kpiId);

    // Pas de moyenne globale (97 et 9 mélangés = 53 n'a aucun sens).
    expect(trend.current_avg).toBeNull();
    expect(trend.trend).toBeNull();
    expect(trend.series).toHaveLength(2);
    expect(trend.series[0]).toMatchObject({ label: 'Livraisons', unit: '%', target: 95, target_direction: 'min', current_avg: 97, meets_target: true });
    expect(trend.series[1]).toMatchObject({ label: 'Réclamations', unit: 'réclam.', target: 5, target_direction: 'max', current_avg: 9, meets_target: false });
  });

  it('un KPI est hors objectif dès qu\'UNE série rate son objectif (et pas si toutes le tiennent)', async () => {
    tenant = await createTenant();
    await createTwoSeriesKpi({ deliveries: 97, complaints: 9 });
    const snapshot = await buildQmsSnapshot(tenant.tenantId);
    expect(snapshot.kpis.off_target).toBe(1);

    await tenant.cleanup();
    tenant = await createTenant();
    await createTwoSeriesKpi({ deliveries: 97, complaints: 3 });
    expect((await buildQmsSnapshot(tenant.tenantId)).kpis.off_target).toBe(0);
  });

  it("le dashboard désigne la courbe en écart, avec son unité et ses propres relevés", async () => {
    tenant = await createTenant();
    await createTwoSeriesKpi({ deliveries: 97, complaints: 9 });
    const res = await request(app).get('/api/dashboard/stats').set(auth());
    expect(res.body.kpis.off_target).toBe(1);
    expect(res.body.kpis.preview[0]).toMatchObject({ name: 'Service client — Réclamations', unit: 'réclam.', average: 9 });
    expect(res.body.kpis.preview[0].sparkline).toEqual([9]);
  });

  it("le compte rendu liste une ligne par courbe avec son objectif et son verdict", async () => {
    tenant = await createTenant();
    await createTwoSeriesKpi({ deliveries: 97, complaints: 9 });
    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart: isoDate(-10), periodEnd: isoDate(0) });
    const blocks = buildInputBlocks({ input_snapshot: { period: { start: isoDate(-10), end: isoDate(0) }, ...snapshot } });
    const lines = blocks.find((b) => b.title === 'KPI suivis').lines;
    expect(lines[0]).toBe('Service client :');
    expect(lines[1]).toBe('  • Livraisons : 97.0 % (objectif ≥ 95 %), objectif atteint');
    expect(lines[2]).toBe('  • Réclamations : 9.0 réclam. (objectif ≤ 5 réclam.), objectif non atteint');
  });

  it('un KPI à une seule courbe garde la forme et la ligne habituelles (avec le verdict en plus)', async () => {
    tenant = await createTenant();
    const kpi = await request(app).post('/api/kpis').set(auth()).send({ name: 'Rebut', unit: '%', target: 3, target_direction: 'max' });
    await request(app).post(`/api/kpis/${kpi.body.id}/records`).set(auth()).send({ period_date: isoDate(-2), value: 4 });

    const snapshot = await buildQmsSnapshot(tenant.tenantId, { periodStart: isoDate(-10), periodEnd: isoDate(0) });
    const trend = snapshot.kpi_trend.find((k) => k.id === kpi.body.id);
    expect(trend.series).toBeUndefined();
    expect(trend).toMatchObject({ current_avg: 4, target: 3, meets_target: false });
    expect(snapshot.kpis.off_target).toBe(1);
  });
});
