// Recalcul d'un KPI de module (calculation_type='module') : lit les lignes de la table de
// module (moduleKpiSources.js), les regroupe par période selon la fréquence du KPI, applique
// la recette de calcul via le moteur partagé (kpiCalculation.js), et remplace les kpi_records
// correspondants. Miroir de POST /api/kpi-imports/:id/apply, mais sans fichier importé.
import { supabase } from './supabase.js';
import { groupRowsByPeriod, summarizeGroups } from './kpiCalculation.js';
import { MODULE_KPI_SOURCES } from './moduleKpiSources.js';

// Valeur sentinelle de kpi_calculation_configs.period_column pour un preset « photo à date »
// (voir MODULE_KPI_PRESETS). N'est jamais une vraie colonne de module.
export const SNAPSHOT_COLUMN = '__snapshot__';

// Ramène une date au début de sa période selon la fréquence du KPI. Toujours un yyyy-MM-dd
// valide (accepté par normalizeAnyDate). Rend '' si la valeur n'est pas une date — la ligne
// sera alors groupée en "__raw__:" et non persistée (comportement du moteur).
export function bucketDate(raw, frequency) {
  if (raw === null || raw === undefined || raw === '') return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  const pad = (n) => String(n).padStart(2, '0');

  switch (frequency) {
    case 'yearly':
      return `${y}-01-01`;
    case 'quarterly': {
      const qStartMonth = Math.floor(m / 3) * 3; // 0,3,6,9
      return `${y}-${pad(qStartMonth + 1)}-01`;
    }
    case 'weekly': {
      // Lundi de la semaine ISO.
      const day = (d.getUTCDay() + 6) % 7; // 0 = lundi
      const monday = new Date(Date.UTC(y, m, d.getUTCDate() - day));
      return monday.toISOString().slice(0, 10);
    }
    case 'daily':
      return d.toISOString().slice(0, 10);
    case 'monthly':
    default:
      return `${y}-${pad(m + 1)}-01`;
  }
}

// Lit les lignes d'une source, avec réutilisation optionnelle entre plusieurs KPI qui
// partagent le même (tenant, module) — voir jobs/moduleKpiJob.js, où un tenant avec 3 KPI sur
// le module CAPA ne doit interroger `capas` qu'une seule fois par nuit, pas 3. Sûr par
// construction : `source.fetchRows` ne renvoie que des données, jamais mutées ensuite (voir
// plus bas — recomputeModuleKpi construit toujours de nouveaux objets, ne réécrit jamais
// row_data en place). Sans rowsCache (appel unitaire — bouton « Actualiser », création depuis
// un preset), comportement inchangé : une lecture fraîche à chaque appel.
async function fetchSourceRows(source, sourceModule, tenantId, rowsCache) {
  if (!rowsCache) return source.fetchRows(tenantId);
  const key = `${tenantId}:${sourceModule}`;
  if (rowsCache.has(key)) return rowsCache.get(key);
  const rows = await source.fetchRows(tenantId);
  rowsCache.set(key, rows);
  return rows;
}

// Renvoie { periods, updated, deleted }. Lève si le KPI n'est pas un KPI de module valide.
// `rowsCache` (Map optionnelle, clé "tenantId:sourceModule") permet à un appelant qui
// recalcule plusieurs KPI d'affilée (le job nocturne) de ne lire chaque table source qu'une
// fois par tenant plutôt qu'une fois par KPI — voir fetchSourceRows ci-dessus.
export async function recomputeModuleKpi({ tenantId, kpiId, recordedBy = null, rowsCache = null }) {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id, tenant_id, calculation_type, source_module, frequency')
    .eq('tenant_id', tenantId)
    .eq('id', kpiId)
    .single();

  if (kpiError || !kpi) throw new Error('KPI introuvable.');
  if (kpi.calculation_type !== 'module') throw new Error("Ce KPI n'est pas un KPI de module.");

  const source = MODULE_KPI_SOURCES[kpi.source_module];
  if (!source) throw new Error(`Source de module inconnue : "${kpi.source_module}".`);

  const { data: configs, error: configError } = await supabase
    .from('kpi_calculation_configs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('kpi_id', kpi.id)
    .limit(1);

  if (configError || !configs || configs.length === 0) {
    throw new Error('Recette de calcul introuvable pour ce KPI de module.');
  }
  const config = configs[0];
  if (!config.period_column) {
    // Sans colonne de période, groupRowsByPeriod grouperait tout sous une seule clé null que
    // summarizeGroups ne sait pas traiter. Tous les presets Phase 1 en ont une ; garde-fou
    // pour un futur preset mal formé.
    throw new Error("La recette de ce KPI de module n'a pas de colonne de période.");
  }

  // Mode « photo à date » : le KPI mesure l'état courant (CAPA ouvertes, en retard, âge du
  // stock…), pas un agrégat par période de rattachement. On date toutes les lignes du même
  // bucket — celui du jour du calcul — pour obtenir une seule valeur, ré-écrite à chaque
  // recalcul du mois, qui construit une courbe de backlog au fil du temps.
  const isSnapshot = config.period_column === SNAPSHOT_COLUMN;

  const rows = await fetchSourceRows(source, kpi.source_module, tenantId, rowsCache);

  // Ne JAMAIS muter row_data des lignes renvoyées par fetchSourceRows : avec rowsCache, ce
  // même tableau est réutilisé tel quel par le prochain KPI qui partage cette source — le
  // muter ici ferait fuiter le bucketage (voire la colonne de période) de ce KPI vers le
  // suivant. On construit donc toujours de nouveaux objets row_data.
  const snapshotBucket = isSnapshot ? bucketDate(new Date(), kpi.frequency) : null;
  const bucketedRows = rows.map((row) => ({
    row_index: row.row_index,
    row_data: {
      ...row.row_data,
      [config.period_column]: isSnapshot ? snapshotBucket : bucketDate(row.row_data[config.period_column], kpi.frequency),
    },
  }));

  const groups = groupRowsByPeriod(bucketedRows, config.period_column, null);
  const { periods } = summarizeGroups(config, groups);

  const persisted = periods.filter((p) => p.persisted);
  const keptDates = new Set(persisted.map((p) => p.period_date));

  if (persisted.length > 0) {
    const { error: upsertError } = await supabase.from('kpi_records').upsert(
      persisted.map((p) => ({
        tenant_id: tenantId,
        kpi_id: kpi.id,
        config_id: config.id,
        period_date: p.period_date,
        value: p.value,
        source: 'module',
        recorded_by: recordedBy,
      })),
      { onConflict: 'config_id,period_date' }
    );
    if (upsertError) throw new Error(`Écriture des valeurs calculées : ${upsertError.message}`);
  }

  // Une période qui n'apparaît plus dans les données courantes (ex. la dernière CAPA de ce
  // mois a été rouverte) doit disparaître de l'historique — un KPI de module reflète l'état
  // actuel, pas un cumul figé. Exception : en mode photo à date, chaque valeur mensuelle est
  // un relevé du backlog à ce moment-là et reste valable — on ne touche qu'au bucket courant.
  let deleted = 0;
  if (!isSnapshot) {
    const { data: existing, error: existingError } = await supabase
      .from('kpi_records')
      .select('id, period_date')
      .eq('tenant_id', tenantId)
      .eq('config_id', config.id);

    if (!existingError && existing) {
      const stale = existing.filter((r) => !keptDates.has(r.period_date)).map((r) => r.id);
      if (stale.length > 0) {
        await supabase.from('kpi_records').delete().eq('tenant_id', tenantId).in('id', stale);
        deleted = stale.length;
      }
    }
  }

  return { periods, updated: persisted.length, deleted };
}
