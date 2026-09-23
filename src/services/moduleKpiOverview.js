import { supabase } from './supabase.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';
import { MODULE_KPI_PRESETS, MODULE_KPI_SOURCES } from './moduleKpiSources.js';
import { MODULE_KPI_DOMAINS, ESSENTIAL_PRESET_IDS, domainOfPreset, getEssentialPresets, isEssential } from './moduleKpiCatalog.js';
import { createModuleKpiFromPreset } from './moduleKpiCreate.js';

// Historique gardé par indicateur pour la courbe et les comparaisons.
const SERIES_LENGTH = 12;
// Comme getKpiStatus (frontend/src/lib/kpiStatus.js) : à moins de 10 % de l'objectif, « à surveiller » plutôt que « hors objectif ».
const WARNING_MARGIN_RATIO = 0.1;

const round2 = (value) => Math.round(value * 100) / 100;

// 'good' | 'warning' | 'bad' | 'neutral' (pas d'objectif ou pas de valeur) — 'min' = plancher (≥), 'max' = plafond (≤).
export function statusOf(value, target, direction) {
  if (value === null || value === undefined || target === null || target === undefined) return 'neutral';
  const meets = direction === 'max' ? value <= target : value >= target;
  if (meets) return 'good';
  const margin = Math.abs(target) * WARNING_MARGIN_RATIO;
  const near = direction === 'max' ? value <= target + margin : value >= target - margin;
  return near ? 'warning' : 'bad';
}

// Même jour, une année plus tôt (les dates de période sont des débuts de période : le décalage est exact).
export function yearAgo(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${Number(year) - 1}-${month}-${day}`;
}

// Comparaisons de la valeur la plus récente (points : { period_date, value } triés par date croissante, sans valeur nulle) :
//  - previous : la période précédente ;
//  - year_ago : la même période un an plus tôt ;
//  - average_6 : la moyenne des 6 périodes précédentes (la dernière exclue).
// Chaque valeur vaut null quand l'historique ne la permet pas encore (un indicateur « photo à date » se construit mois après mois).
export function buildComparisons(points, empty = false) {
  if (points.length === 0 || empty) return { latest: null, previous: null, year_ago: null, average_6: null };
  const latest = points[points.length - 1];
  const before = points.slice(0, -1);
  const previous = before[before.length - 1] || null;
  const yearAgoPoint = points.find((point) => point.period_date === yearAgo(latest.period_date)) || null;
  const lastSix = before.slice(-6);
  return {
    latest: { period_date: latest.period_date, value: latest.value },
    previous: previous ? { period_date: previous.period_date, value: previous.value } : null,
    year_ago: yearAgoPoint ? { period_date: yearAgoPoint.period_date, value: yearAgoPoint.value } : null,
    average_6: lastSix.length > 0 ? { count: lastSix.length, value: round2(lastSix.reduce((sum, point) => sum + point.value, 0) / lastSix.length) } : null,
  };
}

// Résumé des relevés d'une plage : nombre, moyenne, minimum, maximum. null si la plage est vide.
export function rangeStats(points) {
  if (points.length === 0) return null;
  const values = points.map((point) => point.value);
  return { count: values.length, average: round2(values.reduce((sum, value) => sum + value, 0) / values.length), min: Math.min(...values), max: Math.max(...values) };
}

// Objectif réaliste proposé d'après les résultats : la meilleure valeur des 6 dernières périodes (la plus basse pour un
// plafond, la plus haute pour un plancher). null sans historique. Simple suggestion, jamais appliquée seule.
export function suggestTarget(points, direction) {
  const recent = points.slice(-6).map((point) => point.value);
  if (recent.length < 2) return null;
  return round2(direction === 'max' ? Math.min(...recent) : Math.max(...recent));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (value) => typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

// Début de la période qui contient la date (les dates de période sont des débuts de période) : une plage qui commence
// le 15 juin doit inclure la période de juin, datée du 1er juin.
export function periodStart(dateStr, frequency) {
  const [year, month] = dateStr.split('-');
  if (frequency === 'monthly') return `${year}-${month}-01`;
  if (frequency === 'quarterly') return `${year}-${String(Math.floor((Number(month) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (frequency === 'yearly') return `${year}-01-01`;
  return dateStr;
}

// Relevés compris dans la plage { from, to } (bornes facultatives, incluses). Sans plage : tous.
export function pointsInRange(points, range, frequency) {
  if (!range) return points;
  const from = range.from ? periodStart(range.from, frequency) : null;
  return points.filter((point) => (!from || point.period_date >= from) && (!range.to || point.period_date <= range.to));
}

// Lit le paramètre ?ranges= (JSON { <clé de domaine>: { from, to } }) ; ignore les domaines inconnus. Renvoie
// { ranges } ou { error }.
export function parseRanges(raw) {
  if (raw === undefined || raw === null || raw === '') return { ranges: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'Plage de dates invalide.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Plage de dates invalide.' };
  const known = new Set(MODULE_KPI_DOMAINS.map((domain) => domain.key));
  const ranges = {};
  for (const [key, range] of Object.entries(parsed)) {
    if (!known.has(key) || !range || typeof range !== 'object') continue;
    const from = range.from || null;
    const to = range.to || null;
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return { error: 'Dates de la plage invalides.' };
    if (from && to && from > to) return { error: 'La date de début doit précéder la date de fin.' };
    if (from || to) ranges[key] = { from, to };
  }
  return { ranges };
}

// Rattache aux presets les KPI de module créés avant l'existence de module_preset_id : même nom que le preset, même
// module. Persisté (une seule fois par KPI) pour que la vue s'appuie ensuite sur l'identifiant.
async function backfillPresetIds(tenantId, kpis) {
  const byKey = new Map(MODULE_KPI_PRESETS.map((preset) => [`${preset.module}:${preset.label}`, preset.id]));
  const claimed = new Set(kpis.filter((kpi) => kpi.module_preset_id).map((kpi) => kpi.module_preset_id));
  for (const kpi of kpis) {
    if (kpi.module_preset_id) continue;
    const presetId = byKey.get(`${kpi.source_module}:${kpi.name}`);
    if (!presetId || claimed.has(presetId)) continue;
    const { error } = await supabase.from('kpis').update({ module_preset_id: presetId }).eq('tenant_id', tenantId).eq('id', kpi.id);
    if (!error) {
      kpi.module_preset_id = presetId;
      claimed.add(presetId);
    }
  }
}

// Vue « Indicateurs des modules » : par domaine, ses indicateurs (le noyau essentiel d'abord, puis « autres »), chacun
// suivi ou non ; pour un indicateur suivi : valeur la plus récente, objectif, état, comparaisons et courbe.
export async function buildModuleOverview({ tenantId, viewer, ranges = {} }) {
  const { data: rows, error } = await supabase
    .from('kpis')
    .select('id, name, unit, target, target_direction, frequency, source_module, module_preset_id, updated_at, category_id, folder_id, folder:kpi_folders(id, name), category:categories(id, is_restricted), records:kpi_records(period_date, value)')
    .eq('tenant_id', tenantId)
    .eq('calculation_type', 'module');
  if (error) throw new Error('Impossible de récupérer les indicateurs des modules.');

  const kpis = await filterViewableByCategory({ ...viewer, items: rows });
  await backfillPresetIds(tenantId, kpis);
  const kpiByPreset = new Map(kpis.filter((kpi) => kpi.module_preset_id).map((kpi) => [kpi.module_preset_id, kpi]));

  const domains = MODULE_KPI_DOMAINS.map((domain) => {
    const range = ranges[domain.key] || null;
    const presets = MODULE_KPI_PRESETS.filter((preset) => domainOfPreset(preset)?.key === domain.key);
    const indicators = presets.map((preset) => {
      const kpi = kpiByPreset.get(preset.id) || null;
      const base = {
        preset_id: preset.id,
        label: preset.label,
        description: preset.description,
        unit: preset.unit || '',
        frequency: preset.frequency,
        snapshot: preset.recipe?.period_column === '__snapshot__',
        essential: isEssential(preset.id),
        default_target: preset.target ?? null,
        default_direction: preset.target_direction || 'min',
        tracked: Boolean(kpi),
        kpi_id: kpi?.id || null,
      };
      if (!kpi) return base;

      const points = (kpi.records || [])
        .filter((record) => record.value !== null && record.value !== undefined)
        .map((record) => ({ period_date: record.period_date, value: Number(record.value) }))
        .sort((a, b) => (a.period_date < b.period_date ? -1 : 1));
      const direction = kpi.target_direction || 'min';
      const target = kpi.target === null || kpi.target === undefined ? null : Number(kpi.target);
      // Avec une plage : la valeur, l'état et la courbe se rapportent au dernier relevé de la plage ; les comparaisons
      // (période précédente, N-1, moyenne) restent prises dans tout l'historique avant ce relevé.
      const scoped = pointsInRange(points, range, preset.frequency);
      const comparisons = buildComparisons(range ? points.filter((point) => !scoped.length || point.period_date <= scoped[scoped.length - 1].period_date) : points, range && scoped.length === 0);
      return {
        ...base,
        folder_id: kpi.folder_id || null,
        folder_name: kpi.folder?.name || null,
        target,
        target_direction: direction,
        target_changed: target !== base.default_target || direction !== base.default_direction,
        status: statusOf(comparisons.latest?.value, target, direction),
        ...comparisons,
        suggested_target: suggestTarget(points, direction),
        series: range ? scoped : points.slice(-SERIES_LENGTH),
        range_stats: range ? rangeStats(scoped) : null,
      };
    });
    // Le noyau essentiel dans l'ordre du catalogue, puis le reste dans l'ordre des presets.
    const ordered = [
      ...domain.essential.map((id) => indicators.find((indicator) => indicator.preset_id === id)).filter(Boolean),
      ...indicators.filter((indicator) => !indicator.essential),
    ];
    const tracked = ordered.filter((indicator) => indicator.tracked);
    return {
      key: domain.key,
      label: domain.label,
      range,
      question: domain.question,
      menu_keys: domain.menu_keys,
      indicators: ordered,
      counts: {
        tracked: tracked.length,
        good: tracked.filter((indicator) => indicator.status === 'good').length,
        warning: tracked.filter((indicator) => indicator.status === 'warning').length,
        bad: tracked.filter((indicator) => indicator.status === 'bad').length,
      },
    };
  });

  const tracked = domains.flatMap((domain) => domain.indicators).filter((indicator) => indicator.tracked);
  return {
    domains,
    summary: {
      tracked: tracked.length,
      good: tracked.filter((indicator) => indicator.status === 'good').length,
      warning: tracked.filter((indicator) => indicator.status === 'warning').length,
      bad: tracked.filter((indicator) => indicator.status === 'bad').length,
      essential_total: ESSENTIAL_PRESET_IDS.length,
      essential_tracked: tracked.filter((indicator) => indicator.essential).length,
    },
  };
}

// Suit d'un coup tous les indicateurs essentiels pas encore suivis (un premier calcul chacun, en partageant la lecture des
// tables source). Renvoie { created, failed } ; un échec isolé n'empêche pas les autres.
export async function enableEssentialIndicators({ tenantId, userId, only = null }) {
  const { data: existing } = await supabase.from('kpis').select('name, source_module, module_preset_id').eq('tenant_id', tenantId).eq('calculation_type', 'module');
  const already = new Set((existing || []).map((kpi) => kpi.module_preset_id || `${kpi.source_module}:${kpi.name}`));
  const rowsCache = new Map();
  const created = [];
  const failed = [];
  for (const preset of getEssentialPresets()) {
    if (only && !only.includes(domainOfPreset(preset)?.key)) continue;
    if (already.has(preset.id) || already.has(`${preset.module}:${preset.label}`)) continue;
    try {
      await createModuleKpiFromPreset({ tenantId, userId, preset, rowsCache });
      created.push(preset.id);
    } catch (err) {
      console.error(`[moduleKpi] Indicateur essentiel « ${preset.id} » non créé :`, err.message);
      failed.push(preset.id);
    }
  }
  return { created, failed };
}

export { MODULE_KPI_SOURCES };
