import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { recomputeModuleKpi } from '../services/moduleKpiRecompute.js';
import { withJobRunTracking } from '../services/jobRunTracker.js';

// Recalcul quotidien de tous les KPI de module (calculation_type='module'). Best-effort : un
// KPI ou un tenant en échec n'empêche jamais les suivants — une valeur pas encore à jour se
// rattrape au prochain recalcul ou via le bouton « Actualiser ».
//
// rowsCache (une Map pour tout le run, clé "tenantId:sourceModule") : un tenant qui a plusieurs
// KPI sur le même module (ex. 3 KPI CAPA) ne fait lire sa table source qu'une seule fois au
// lieu d'une fois par KPI — recomputeModuleKpi ne mute jamais les lignes qu'il reçoit, donc les
// partager entre plusieurs KPI de cette façon est sûr (voir moduleKpiRecompute.js).
//
// Exportée pour pouvoir être appelée manuellement, comme les autres jobs (voir
// notificationJob.js) : node -e "import('./src/jobs/moduleKpiJob.js').then(m => m.runModuleKpiJob())"
export async function runModuleKpiJob() {
  const { data: kpis, error } = await supabase
    .from('kpis')
    .select('id, tenant_id')
    .eq('calculation_type', 'module')
    .limit(50000);

  if (error || !kpis) {
    // Relancée (jamais un { ok: 0, total: 0 } silencieux) : ce chiffre se lirait comme un
    // succès sans rien à traiter plutôt que comme l'échec réel qu'il est — voir
    // services/jobRunTracker.js, qui doit pouvoir distinguer les deux (statut 'failed' avec le
    // vrai message d'erreur, pas un résumé "0/0 traité(s) avec succès." trompeur).
    throw new Error(`Impossible de lister les KPI de module : ${error?.message || 'réponse vide'}`);
  }

  const rowsCache = new Map();
  let ok = 0;
  for (const kpi of kpis) {
    try {
      await recomputeModuleKpi({ tenantId: kpi.tenant_id, kpiId: kpi.id, rowsCache });
      ok += 1;
    } catch (err) {
      console.error(`[moduleKpiJob] Échec du KPI ${kpi.id} (tenant ${kpi.tenant_id}) :`, err.message);
    }
  }

  console.log(`[moduleKpiJob] ${ok}/${kpis.length} KPI de module recalculés.`);
  return { ok, total: kpis.length };
}

// Après l'instantané du dashboard (3h) pour ne pas concourir pour les mêmes ressources DB.
export function scheduleModuleKpiJob() {
  cron.schedule('30 3 * * *', () => {
    withJobRunTracking('moduleKpiJob', runModuleKpiJob).catch((err) => console.error('[moduleKpiJob] Échec :', err.message));
  });
  console.log('[moduleKpiJob] Recalcul quotidien des KPI de module planifié tous les jours à 3h30.');
}
