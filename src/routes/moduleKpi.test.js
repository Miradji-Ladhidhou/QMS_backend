import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';

let tenant;

afterEach(async () => {
  if (tenant) {
    await tenant.cleanup();
    tenant = undefined;
  }
});

async function makeCapa(token, overrides = {}) {
  const res = await request(app)
    .post('/api/capas')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'CAPA test', origin: 'Test', ...overrides });
  return res.body;
}

async function closeCapa(token, id) {
  // status:'closed' pose closed_at côté backend (à la date du jour). La clôture exige action
  // corrective + vérification d'efficacité justifiée.
  const res = await request(app)
    .patch(`/api/capas/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      status: 'closed',
      corrective_action: 'fait',
      effectiveness_verified: true,
      effectiveness_notes: 'Vérifié sur 3 mois sans récidive.',
    });
  if (res.status !== 200) throw new Error(`closeCapa a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

function fromPreset(token, presetId) {
  return request(app).post('/api/kpis/from-module-preset').set('Authorization', `Bearer ${token}`).send({ preset_id: presetId });
}

describe('KPI de module — catalogue', () => {
  it('GET /api/kpis/module-presets renvoie le catalogue', async () => {
    tenant = await createTenant();
    const res = await request(app).get('/api/kpis/module-presets').set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(5);
    const capaClosed = res.body.find((p) => p.id === 'capa_closed_count');
    expect(capaClosed).toBeTruthy();
    expect(capaClosed.module_label).toBe('CAPA');
  });

  it('un member ne peut pas créer de KPI de module', async () => {
    tenant = await createTenant({ extraUsers: [{ role: 'member' }] });
    const res = await fromPreset(tenant.users[0].token, 'capa_closed_count');
    expect(res.status).toBe(403);
  });

  it('preset inconnu → 400', async () => {
    tenant = await createTenant();
    const res = await fromPreset(tenant.admin.token, 'nope');
    expect(res.status).toBe(400);
  });
});

describe('KPI de module — calcul (count)', () => {
  it('« CAPA clôturées » compte les CAPA clôturées par mois', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    const c2 = await makeCapa(t);
    await makeCapa(t); // reste ouverte

    await closeCapa(t, c1.id);
    await closeCapa(t, c2.id);

    const created = await fromPreset(t, 'capa_closed_count');
    expect(created.status).toBe(201);
    expect(created.body.calculation_type).toBe('module');
    expect(created.body.source_module).toBe('capa');

    // Les deux CAPA clôturées ce mois-ci → une valeur de période = 2.
    const records = created.body.records || [];
    expect(records.length).toBe(1);
    expect(Number(records[0].value)).toBe(2);
    expect(records[0].source).toBe('module');
  });

  it('recompute met à jour après un changement de données', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    await closeCapa(t, c1.id);

    const created = await fromPreset(t, 'capa_closed_count');
    expect(Number((created.body.records || [])[0].value)).toBe(1);

    const c2 = await makeCapa(t);
    await closeCapa(t, c2.id);

    const recompute = await request(app)
      .post(`/api/kpis/${created.body.id}/recompute`)
      .set('Authorization', `Bearer ${t}`);
    expect(recompute.status).toBe(200);
    expect(recompute.body.updated).toBe(1);

    const kpi = await request(app).get(`/api/kpis/${created.body.id}`).set('Authorization', `Bearer ${t}`);
    const rec = (kpi.body.records || []).find((r) => r.value !== null);
    expect(Number(rec.value)).toBe(2);
  });
});

describe('KPI de module — garde-fous', () => {
  it('POST /:id/records refusé sur un KPI de module (409)', async () => {
    tenant = await createTenant();
    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');

    const res = await request(app)
      .post(`/api/kpis/${created.body.id}/records`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ period_date: '2026-01-01', value: 5 });
    expect(res.status).toBe(409);
  });

  it('POST /:id/recompute sur un KPI manuel → 400', async () => {
    tenant = await createTenant();
    const manual = await request(app)
      .post('/api/kpis')
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ name: 'KPI manuel' });

    const res = await request(app)
      .post(`/api/kpis/${manual.body.id}/recompute`)
      .set('Authorization', `Bearer ${tenant.admin.token}`);
    expect(res.status).toBe(400);
  });

  it('PATCH calculation_type sur un KPI de module → 409', async () => {
    tenant = await createTenant();
    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');

    const res = await request(app)
      .patch(`/api/kpis/${created.body.id}`)
      .set('Authorization', `Bearer ${tenant.admin.token}`)
      .send({ calculation_type: 'manual' });
    expect(res.status).toBe(409);
  });

  it('isolation multi-tenant : recompute ne voit que les données de son tenant', async () => {
    tenant = await createTenant();
    const other = await createTenant();

    const oc = await makeCapa(other.admin.token);
    await closeCapa(other.admin.token, oc.id);

    const created = await fromPreset(tenant.admin.token, 'capa_closed_count');
    // Aucune CAPA clôturée dans CE tenant → aucun record.
    expect((created.body.records || []).length).toBe(0);

    await other.cleanup();
  });
});

describe('KPI de module — satisfaction (average)', () => {
  it('« Note moyenne » = moyenne des scores du mois', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;
    const today = new Date().toISOString().slice(0, 10);

    for (const score of [2, 4, 3]) {
      await request(app)
        .post('/api/customer-satisfaction')
        .set('Authorization', `Bearer ${t}`)
        .send({ customer_name: 'C', survey_date: today, score });
    }

    const created = await fromPreset(t, 'satisfaction_avg_score');
    expect(created.status).toBe(201);
    const rec = (created.body.records || [])[0];
    expect(Number(rec.value)).toBe(3);
  });
});
