import cron from 'node-cron';
import { supabase } from '../services/supabase.js';
import { computeTenantMetrics } from '../routes/dashboard.js';

// Instantané quotidien des métriques du dashboard, un tenant à la fois — comparé plus tard
// (voir GET /api/dashboard/stats) à l'instantané le plus proche d'il y a 30 jours pour calculer
// les tendances affichées. Après la sauvegarde (2h) pour ne jamais les faire concourir pour les
// mêmes ressources DB. Un tenant en échec n'empêche jamais les suivants : chacun est isolé dans
// son propre try/catch, comme dashboardSnapshotJob doit rester best-effort (une tendance
// manquante un jour n'est jamais aussi grave qu'une sauvegarde manquée).
export function scheduleDashboardSnapshotJob() {
  cron.schedule('0 3 * * *', async () => {
    const { data: tenants, error } = await supabase.from('tenants').select('id');
    if (error || !tenants) {
      console.error('[dashboardSnapshotJob] Impossible de récupérer la liste des tenants :', error?.message);
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    let succeeded = 0;

    for (const tenant of tenants) {
      try {
        const metrics = await computeTenantMetrics(tenant.id);
        const { error: upsertError } = await supabase
          .from('dashboard_metric_snapshots')
          .upsert({ tenant_id: tenant.id, snapshot_date: today, metrics }, { onConflict: 'tenant_id,snapshot_date' });
        if (upsertError) throw upsertError;
        succeeded += 1;
      } catch (err) {
        console.error(`[dashboardSnapshotJob] Échec pour le tenant ${tenant.id} :`, err.message);
      }
    }

    console.log(`[dashboardSnapshotJob] Instantané du ${today} enregistré pour ${succeeded}/${tenants.length} tenant(s).`);
  });
  console.log('[dashboardSnapshotJob] Instantané quotidien du dashboard planifié tous les jours à 3h00.');
}
