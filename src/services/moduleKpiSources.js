// KPI de module (ISO 9001 §9.1) : alimente le moteur de calcul KPI existant
// (services/kpiCalculation.js) avec les lignes d'une table de module plutôt qu'un fichier
// importé. Chaque source expose fetchRows(tenantId) -> [{ row_index, row_data }] au format
// attendu par groupRowsByPeriod()/summarizeGroups(). row_data contient les colonnes réelles
// + des champs calculés préfixés "_" (le moteur ne sait pas soustraire des dates).
import { supabase } from './supabase.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Nombre de jours entiers entre deux dates (ISO ou timestamptz). '' si l'une manque.
function daysBetween(start, end) {
  if (!start || !end) return '';
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  return Math.round((e.getTime() - s.getTime()) / DAY_MS);
}

// '1' si end <= due (traité dans les délais), '0' si end > due, '' si une date manque.
function onTime(end, due) {
  if (!end || !due) return '';
  const e = new Date(end);
  const d = new Date(due);
  if (Number.isNaN(e.getTime()) || Number.isNaN(d.getTime())) return '';
  return e.getTime() <= d.getTime() + DAY_MS - 1 ? '1' : '0';
}

const bool01 = (v) => (v ? '1' : '0');

async function selectAll(table, columns, tenantId) {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq('tenant_id', tenantId)
    .limit(50000);
  if (error) throw new Error(`Lecture de ${table} : ${error.message}`);
  return data || [];
}

function rowsFrom(records, augment) {
  return records.map((row) => ({ row_index: row.id, row_data: { ...row, ...augment(row) } }));
}

// Clés = valeur stockée dans kpis.source_module.
export const MODULE_KPI_SOURCES = {
  capa: {
    table: 'capas',
    label: 'CAPA',
    async fetchRows(tenantId) {
      const rows = await selectAll('capas', 'id, status, priority, severity, due_date, closed_at, created_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _is_closed: bool01(r.status === 'closed'),
        _resolution_days: daysBetween(r.created_at, r.closed_at),
        _on_time: onTime(r.closed_at, r.due_date),
      }));
    },
  },

  nonconforming_output: {
    table: 'nonconforming_outputs',
    label: 'Non-conformités produit/service',
    async fetchRows(tenantId) {
      const rows = await selectAll('nonconforming_outputs', 'id, status, disposition, detected_at, closed_at, created_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _is_closed: bool01(r.status === 'closed'),
        _resolution_days: daysBetween(r.detected_at, r.closed_at),
      }));
    },
  },

  complaint: {
    table: 'complaints',
    label: 'Réclamations clients',
    async fetchRows(tenantId) {
      const rows = await selectAll(
        'complaints',
        'id, status, severity, received_date, due_date, resolution_date, customer_satisfied, created_at',
        tenantId
      );
      return rowsFrom(rows, (r) => ({
        _is_closed: bool01(r.status === 'resolved' || r.status === 'closed'),
        _resolution_days: daysBetween(r.received_date, r.resolution_date),
        _on_time: onTime(r.resolution_date, r.due_date),
        _customer_satisfied: r.customer_satisfied === null || r.customer_satisfied === undefined ? '' : bool01(r.customer_satisfied),
      }));
    },
  },

  accident: {
    table: 'accidents',
    label: 'Accidents du travail',
    async fetchRows(tenantId) {
      const rows = await selectAll('accidents', 'id, status, severity, lost_days, occurred_at, closed_at, created_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _is_closed: bool01(r.status === 'closed'),
        _with_lost_time: bool01(Number(r.lost_days) > 0),
      }));
    },
  },

  customer_satisfaction: {
    table: 'customer_satisfaction_surveys',
    label: 'Satisfaction client',
    async fetchRows(tenantId) {
      const rows = await selectAll('customer_satisfaction_surveys', 'id, score, method, survey_date, created_at', tenantId);
      return rowsFrom(rows, () => ({}));
    },
  },

  audit: {
    table: 'audits',
    label: 'Audits internes',
    async fetchRows(tenantId) {
      const rows = await selectAll('audits', 'id, status, planned_date, completed_date, created_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _is_done: bool01(r.status === 'completed' || r.status === 'closed'),
        _resolution_days: daysBetween(r.planned_date, r.completed_date),
      }));
    },
  },

  audit_finding: {
    table: 'audit_findings',
    label: 'Constats d’audit',
    async fetchRows(tenantId) {
      const rows = await selectAll('audit_findings', 'id, type, created_at', tenantId);
      return rowsFrom(rows, () => ({}));
    },
  },

  training_record: {
    table: 'training_records',
    label: 'Réalisations de formation',
    async fetchRows(tenantId) {
      const rows = await selectAll('training_records', 'id, completed_at, next_due_date, created_at', tenantId);
      return rowsFrom(rows, () => ({}));
    },
  },
};

// Catalogue de métriques prêtes à l'emploi. `recipe` = ce qui atterrit dans
// kpi_calculation_configs (calc_type / period_column / source_column / group_by_column /
// filters / filter_logic). period_column est toujours une colonne de date brute : le
// bucketing par fréquence est fait par moduleKpiRecompute.js.
export const MODULE_KPI_PRESETS = [
  // --- CAPA ---
  {
    id: 'capa_closed_count',
    module: 'capa',
    label: 'CAPA clôturées',
    description: 'Nombre de CAPA passées au statut « clôturé » sur la période.',
    unit: 'CAPA',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'closed_at', filters: [{ column: 'status', operator: 'equals', value: 'closed' }] },
  },
  {
    id: 'capa_on_time_rate',
    module: 'capa',
    label: 'CAPA clôturées dans les délais',
    description: 'Part des CAPA clôturées dont la date de clôture respecte l’échéance.',
    unit: '%',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'closed_at', filters: [{ column: '_on_time', operator: 'equals', value: '1' }] },
  },
  {
    id: 'capa_resolution_days',
    module: 'capa',
    label: 'Délai moyen de traitement des CAPA',
    description: 'Nombre de jours moyen entre la création et la clôture d’une CAPA.',
    unit: 'jours',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: '_resolution_days',
      period_column: 'closed_at',
      filters: [{ column: 'status', operator: 'equals', value: 'closed' }],
    },
  },
  {
    id: 'capa_opened_count',
    module: 'capa',
    label: 'CAPA ouvertes',
    description: 'Nombre de CAPA créées sur la période.',
    unit: 'CAPA',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'created_at' },
  },

  // --- Non-conformités produit/service ---
  {
    id: 'nc_treated_count',
    module: 'nonconforming_output',
    label: 'Non-conformités traitées',
    description: 'Nombre de non-conformités clôturées sur la période.',
    unit: 'NC',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'closed_at', filters: [{ column: 'status', operator: 'equals', value: 'closed' }] },
  },
  {
    id: 'nc_closed_rate',
    module: 'nonconforming_output',
    label: 'Taux de clôture des non-conformités',
    description: 'Part des non-conformités détectées qui sont clôturées.',
    unit: '%',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'detected_at', filters: [{ column: '_is_closed', operator: 'equals', value: '1' }] },
  },
  {
    id: 'nc_detected_count',
    module: 'nonconforming_output',
    label: 'Non-conformités détectées',
    description: 'Nombre de non-conformités produit/service détectées sur la période.',
    unit: 'NC',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'detected_at' },
  },

  // --- Réclamations ---
  {
    id: 'complaint_received_count',
    module: 'complaint',
    label: 'Réclamations reçues',
    description: 'Nombre de réclamations clients reçues sur la période.',
    unit: 'réclamations',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'received_date' },
  },
  {
    id: 'complaint_resolution_days',
    module: 'complaint',
    label: 'Délai moyen de résolution des réclamations',
    description: 'Nombre de jours moyen entre la réception et la résolution.',
    unit: 'jours',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: '_resolution_days', period_column: 'resolution_date' },
  },
  {
    id: 'complaint_satisfaction_rate',
    module: 'complaint',
    label: 'Clients satisfaits après réclamation',
    description: 'Part des réclamations résolues où le client s’est déclaré satisfait.',
    unit: '%',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'ratio',
      period_column: 'resolution_date',
      filters: [{ column: '_customer_satisfied', operator: 'equals', value: '1' }],
    },
  },

  // --- Accidents du travail ---
  {
    id: 'accident_count',
    module: 'accident',
    label: 'Accidents du travail déclarés',
    description: 'Nombre d’accidents du travail déclarés sur la période.',
    unit: 'accidents',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'occurred_at' },
  },
  {
    id: 'accident_lost_days',
    module: 'accident',
    label: 'Jours d’arrêt cumulés',
    description: 'Somme des jours d’arrêt de travail liés aux accidents de la période.',
    unit: 'jours',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'sum', source_column: 'lost_days', period_column: 'occurred_at' },
  },
  {
    id: 'accident_lost_time_rate',
    module: 'accident',
    label: 'Accidents avec arrêt de travail',
    description: 'Part des accidents déclarés ayant entraîné au moins un jour d’arrêt.',
    unit: '%',
    target_direction: 'min',
    frequency: 'monthly',
    recipe: {
      calc_type: 'ratio',
      period_column: 'occurred_at',
      filters: [{ column: '_with_lost_time', operator: 'equals', value: '1' }],
    },
  },

  // --- Satisfaction client ---
  {
    id: 'satisfaction_avg_score',
    module: 'customer_satisfaction',
    label: 'Note moyenne de satisfaction client',
    description: 'Moyenne des notes (1 à 5) des enquêtes de satisfaction de la période.',
    unit: '/5',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: 'score', period_column: 'survey_date' },
  },
  {
    id: 'satisfaction_survey_count',
    module: 'customer_satisfaction',
    label: 'Enquêtes de satisfaction réalisées',
    description: 'Nombre d’enquêtes de satisfaction consignées sur la période.',
    unit: 'enquêtes',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'survey_date' },
  },

  // --- Audits ---
  {
    id: 'audit_done_count',
    module: 'audit',
    label: 'Audits internes réalisés',
    description: 'Nombre d’audits internes terminés sur la période.',
    unit: 'audits',
    target_direction: 'max',
    frequency: 'quarterly',
    recipe: {
      calc_type: 'count',
      period_column: 'completed_date',
      filters: [{ column: '_is_done', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'audit_lead_days',
    module: 'audit',
    label: 'Écart planifié / réalisé des audits',
    description: 'Nombre de jours moyen entre la date planifiée et la date de réalisation.',
    unit: 'jours',
    target_direction: 'min',
    frequency: 'quarterly',
    recipe: {
      calc_type: 'average',
      source_column: '_resolution_days',
      period_column: 'completed_date',
      filters: [{ column: '_is_done', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'audit_findings_count',
    module: 'audit_finding',
    label: 'Constats d’audit',
    description: 'Nombre de constats relevés lors des audits internes sur la période.',
    unit: 'constats',
    target_direction: 'min',
    frequency: 'quarterly',
    recipe: { calc_type: 'count', period_column: 'created_at' },
  },
  {
    id: 'audit_nc_count',
    module: 'audit_finding',
    label: 'Non-conformités d’audit (majeures + mineures)',
    description: 'Nombre de constats de type non-conformité relevés sur la période.',
    unit: 'NC',
    target_direction: 'min',
    frequency: 'quarterly',
    recipe: {
      calc_type: 'count',
      period_column: 'created_at',
      filter_logic: 'any',
      filters: [
        { column: 'type', operator: 'equals', value: 'major_nc' },
        { column: 'type', operator: 'equals', value: 'minor_nc' },
      ],
    },
  },

  // --- Formations ---
  {
    id: 'training_completions',
    module: 'training_record',
    label: 'Réalisations de formation',
    description: 'Nombre de formations effectivement suivies (par personne) sur la période.',
    unit: 'réalisations',
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'completed_at' },
  },
];

export function getPreset(presetId) {
  return MODULE_KPI_PRESETS.find((p) => p.id === presetId) || null;
}
