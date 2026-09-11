import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { createTenant } from '../test-utils/tenant.js';
import { runModuleKpiJob } from './moduleKpiJob.js';

let tenantA;
let tenantB;

afterEach(async () => {
  if (tenantA) {
    await tenantA.cleanup();
    tenantA = undefined;
  }
  if (tenantB) {
    await tenantB.cleanup();
    tenantB = undefined;
  }
});

async function makeCapa(token) {
  const res = await request(app).post('/api/capas').set('Authorization', `Bearer ${token}`).send({ title: 'CAPA test', origin: 'Test' });
  return res.body;
}

async function createModuleKpi(token, presetId) {
  const res = await request(app).post('/api/kpis/from-module-preset').set('Authorization', `Bearer ${token}`).send({ preset_id: presetId });
  if (res.status !== 201) throw new Error(`from-module-preset a échoué (${res.status}) : ${JSON.stringify(res.body)}`);
  return res.body;
}

async function getKpi(token, id) {
  const res = await request(app).get(`/api/kpis/${id}`).set('Authorization', `Bearer ${token}`);
  return res.body;
}

function latestValue(kpi) {
  const rec = (kpi.records || []).find((r) => r.value !== null);
  return rec ? Number(rec.value) : null;
}

describe('runModuleKpiJob', () => {
  it(
    'recalcule les KPI de module de plusieurs tenants sans mélanger leurs données malgré le rowsCache partagé',
    async () => {
      tenantA = await createTenant();
      tenantB = await createTenant();

      // Tenant A : 2 CAPA ouvertes, 2 KPI sur le module 'capa' (même cas que le rowsCache
      // partagé est censé optimiser).
      await makeCapa(tenantA.admin.token);
      await makeCapa(tenantA.admin.token);
      const kpiA1 = await createModuleKpi(tenantA.admin.token, 'capa_open_backlog');
      const kpiA2 = await createModuleKpi(tenantA.admin.token, 'capa_oldest_open_age');

      // Tenant B : 5 CAPA ouvertes, 1 KPI sur le même module — un compte très différent du
      // tenant A pour qu'un mélange entre les deux soit immédiatement visible.
      for (let i = 0; i < 5; i += 1) await makeCapa(tenantB.admin.token);
      const kpiB1 = await createModuleKpi(tenantB.admin.token, 'capa_open_backlog');

      const result = await runModuleKpiJob();
      expect(result.ok).toBeGreaterThanOrEqual(3);
      expect(result.total).toBeGreaterThanOrEqual(result.ok);

      const a1 = await getKpi(tenantA.admin.token, kpiA1.id);
      const a2 = await getKpi(tenantA.admin.token, kpiA2.id);
      const b1 = await getKpi(tenantB.admin.token, kpiB1.id);

      expect(latestValue(a1)).toBe(2);
      expect(latestValue(a2)).not.toBeNull();
      // Le tenant B ne doit jamais voir les CAPA du tenant A (ni l'inverse) : la clé du
      // rowsCache partagé du job inclut le tenant, pas seulement le module.
      expect(latestValue(b1)).toBe(5);
    },
    30000
  );
});
