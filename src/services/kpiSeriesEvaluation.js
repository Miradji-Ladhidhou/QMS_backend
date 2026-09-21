import { buildSeriesInfo, resolveSeriesSettings } from './kpiReportPdf.js';

// Un KPI peut porter plusieurs séries (courbes), chacune avec son unité, son objectif cible et
// son sens (voir kpi_calculation_configs). Mélanger leurs valeurs en une seule moyenne n'a aucun
// sens : chaque série est donc évaluée séparément, contre SON objectif — les mêmes règles que la
// carte KPI (Kpis.jsx) et le rapport PDF (kpiReportPdf.js).

// Colonnes à charger pour évaluer un KPI (à passer dans .select()).
export const KPI_EVALUATION_SELECT =
  'id, name, unit, target, target_direction, records:kpi_records(period_date, value, config_id), calculation_configs:kpi_calculation_configs(id, label, calc_type, unit, target, target_direction, created_at)';

// Même fenêtre que routes/dashboard.js#KPI_RECENT_WINDOW et Kpis.jsx.
export const KPI_RECENT_WINDOW = 6;

function averageOf(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function meetsTarget(value, target, direction) {
  if (value === null || value === undefined || target === null || target === undefined) return null;
  return direction === 'max' ? value <= target : value >= target;
}

// Séries d'un KPI ayant au moins un relevé. Mono-série : toujours les paramètres du KPI ; plusieurs
// séries : ceux de chaque série (les siens si elle est paramétrée à part, sinon ceux du KPI).
// Chaque série : { label, custom, unit, target, direction, records (triés par date) }.
export function evaluateKpiSeries(kpi) {
  // Les séries dans l'ordre de leur création : l'ordre des lignes embarquées n'est pas garanti par la base.
  const configs = [...(kpi.calculation_configs || [])].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  const { showMultiSeries, seriesList } = buildSeriesInfo({ ...kpi, calculation_configs: configs, records: kpi.records || [] });
  return {
    showMultiSeries,
    series: seriesList.map((series) => {
      const settings = showMultiSeries ? series.settings : resolveSeriesSettings(kpi, null);
      return {
        label: series.label,
        custom: settings.custom,
        unit: settings.unit,
        target: settings.target,
        direction: settings.direction,
        records: series.records,
      };
    }),
  };
}

// Moyenne des KPI_RECENT_WINDOW derniers relevés d'une série (records triés par date croissante).
export function recentAverage(records) {
  return averageOf(records.slice(-KPI_RECENT_WINDOW).map((r) => r.value));
}

// Séries d'un KPI qui n'atteignent pas leur propre objectif, d'après leurs relevés RÉCENTS.
// Une série sans objectif n'est jamais « hors objectif ».
export function offTargetSeries(kpi) {
  return evaluateKpiSeries(kpi)
    .series.map((series) => ({ series, average: recentAverage(series.records) }))
    .filter(({ series, average }) => meetsTarget(average, series.target, series.direction) === false);
}
