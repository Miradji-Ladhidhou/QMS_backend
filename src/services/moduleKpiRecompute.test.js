// Vérifie le partage de rowsCache entre plusieurs recalculs (voir jobs/moduleKpiJob.js) :
// recomputeModuleKpi ne doit JAMAIS muter les lignes qu'il reçoit d'une source, sinon un
// second KPI qui partage le même cache verrait des données déjà altérées par le premier.
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { recomputeModuleKpi } from './moduleKpiRecompute.js';
import { MODULE_KPI_SOURCES } from './moduleKpiSources.js';

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

async function createModuleKpi(token, presetId) {
  const res = await request(app).post('/api/kpis/from-module-preset').set('Authorization', `Bearer ${token}`).send({ preset_id: presetId });
  if (res.status !== 201) throw new Error(`from-module-preset a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('recomputeModuleKpi — rowsCache partagé entre plusieurs KPI', () => {
  it('ne mute jamais les lignes en cache : deux recettes différentes sur le même module restent correctes', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;

    const c1 = await makeCapa(t);
    const c2 = await makeCapa(t);
    await makeCapa(t); // reste ouverte
    await closeCapa(t, c1.id);
    await closeCapa(t, c2.id);

    // Une recette « photo à date » (period_column = '__snapshot__') et une recette « période
    // réelle » (period_column = 'closed_at') sur le même module — le pire cas pour une fuite
    // de mutation, puisque les deux réécrivent une colonne de période différente.
    const backlog = await createModuleKpi(t, 'capa_open_backlog');
    const closedCount = await createModuleKpi(t, 'capa_closed_count');

    const rowsCache = new Map();
    const cacheKey = `${tenant.tenantId}:capa`;

    const r1 = await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: backlog.id, rowsCache });
    const cachedRows = rowsCache.get(cacheKey);
    expect(cachedRows).toBeTruthy();
    const snapshotBefore = JSON.stringify(cachedRows);

    const r2 = await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: closedCount.id, rowsCache });

    // Les lignes en cache n'ont pas été modifiées par le premier calcul.
    expect(JSON.stringify(cachedRows)).toBe(snapshotBefore);
    // Toujours la même référence de tableau : pas re-fetché pour le 2e KPI.
    expect(rowsCache.get(cacheKey)).toBe(cachedRows);

    // Et les deux résultats restent corrects malgré le partage.
    expect(r1.periods.find((p) => p.persisted)?.value).toBe(1); // 1 CAPA encore ouverte
    expect(r2.periods.find((p) => p.persisted)?.value).toBe(2); // 2 CAPA clôturées ce mois
  });

  it('un rowsCache partagé lit la table source une seule fois pour plusieurs KPI du même tenant/module', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;
    await makeCapa(t);

    const backlog = await createModuleKpi(t, 'capa_open_backlog');
    const oldest = await createModuleKpi(t, 'capa_oldest_open_age');

    const spy = vi.spyOn(MODULE_KPI_SOURCES.capa, 'fetchRows');
    try {
      const rowsCache = new Map();
      await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: backlog.id, rowsCache });
      await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: oldest.id, rowsCache });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('sans rowsCache (appel unitaire — bouton Actualiser), chaque recalcul relit la source', async () => {
    tenant = await createTenant();
    const t = tenant.admin.token;
    await makeCapa(t);
    const backlog = await createModuleKpi(t, 'capa_open_backlog');

    const spy = vi.spyOn(MODULE_KPI_SOURCES.capa, 'fetchRows');
    try {
      await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: backlog.id });
      await recomputeModuleKpi({ tenantId: tenant.tenantId, kpiId: backlog.id });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
