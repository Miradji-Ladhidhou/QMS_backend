import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { recomputeModuleKpi } from '../services/moduleKpiRecompute.js';

// Recalcul quotidien de tous les KPI de module (calculation_type='module'), un tenant à la
// fois. Après l'instantané du dashboard (3h) pour ne pas concourir pour les mêmes ressources
// DB. Best-effort : un KPI ou un tenant en échec n'empêche jamais les suivants — une valeur
// pas encore à jour se rattrape au prochain recalcul ou via le bouton « Actualiser ».
export function scheduleModuleKpiJob() {
  cron.schedule('30 3 * * *', async () => {
    const { data: kpis, error } = await supabase
      .from('kpis')
      .select('id, tenant_id')
      .eq('calculation_type', 'module');

    if (error || !kpis) {
      console.error('[moduleKpiJob] Impossible de lister les KPI de module :', error?.message);
      return;
    }

    let ok = 0;
    for (const kpi of kpis) {
      try {
        await recomputeModuleKpi({ tenantId: kpi.tenant_id, kpiId: kpi.id });
        ok += 1;
      } catch (err) {
        console.error(`[moduleKpiJob] Échec du KPI ${kpi.id} (tenant ${kpi.tenant_id}) :`, err.message);
      }
    }

    console.log(`[moduleKpiJob] ${ok}/${kpis.length} KPI de module recalculés.`);
  });
  console.log('[moduleKpiJob] Recalcul quotidien des KPI de module planifié tous les jours à 3h30.');
}
