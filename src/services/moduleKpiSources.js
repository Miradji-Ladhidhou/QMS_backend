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

// Fenêtre « bientôt à renouveler » — alignée sur trainings.js (RENEWAL_WINDOW_DAYS).
const RENEWAL_WINDOW_DAYS = 60;

// job_title est un texte libre : comparaison insensible à la casse/aux espaces. Une formation
// sans required_job_titles concerne tout le monde (même règle que la matrice de trainings.js).
function matchesJobTitle(personJobTitle, requiredJobTitles) {
  if (!requiredJobTitles || requiredJobTitles.length === 0) return true;
  const normalized = String(personJobTitle || '').trim().toLowerCase();
  return requiredJobTitles.some((t) => String(t).trim().toLowerCase() === normalized);
}

// Reconstruit la matrice compétences (personnel × formations) — même logique que
// buildMatrix() dans routes/trainings.js, mais sans le filtre de catégorie : un KPI de
// compétence couvre tout l'effectif. Renvoie une cellule par couple (personne, formation)
// CONCERNÉ (les postes non concernés sont exclus). state : 'valid' | 'due_soon' | 'expired'
// | 'missing'.
async function buildCompetenceCells(tenantId) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date();
  soon.setDate(soon.getDate() + RENEWAL_WINDOW_DAYS);
  const soonStr = soon.toISOString().slice(0, 10);

  const [usersRes, employeesRes, trainingsRes, recordsRes] = await Promise.all([
    supabase.from('users').select('id, full_name, job_title').eq('tenant_id', tenantId).eq('training_exempt', false),
    supabase
      .from('employees')
      .select('id, full_name, job_title')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .eq('training_exempt', false),
    supabase.from('trainings').select('id, title, required_job_titles').eq('tenant_id', tenantId),
    supabase
      .from('training_records')
      .select('training_id, user_id, employee_id, completed_at, next_due_date')
      .eq('tenant_id', tenantId)
      .limit(50000),
  ]);

  const err = usersRes.error || employeesRes.error || trainingsRes.error || recordsRes.error;
  if (err) throw new Error(`Matrice compétences : ${err.message}`);

  const people = [
    ...(usersRes.data || []).map((u) => ({ key: `u:${u.id}`, name: u.full_name, job_title: u.job_title })),
    ...(employeesRes.data || []).map((e) => ({ key: `e:${e.id}`, name: e.full_name, job_title: e.job_title })),
  ];

  // Dernier enregistrement par couple (formation, personne).
  const latest = new Map();
  for (const rec of recordsRes.data || []) {
    const pk = rec.user_id ? `u:${rec.user_id}` : `e:${rec.employee_id}`;
    const key = `${rec.training_id}:${pk}`;
    const cur = latest.get(key);
    if (!cur || rec.completed_at > cur.completed_at) latest.set(key, rec);
  }

  const cells = [];
  for (const training of trainingsRes.data || []) {
    const required = training.required_job_titles || [];
    for (const person of people) {
      const record = latest.get(`${training.id}:${person.key}`);
      let state;
      if (!record) {
        if (required.length > 0 && !matchesJobTitle(person.job_title, required)) continue; // poste non concerné
        state = 'missing';
      } else if (record.next_due_date && record.next_due_date < today) {
        state = 'expired';
      } else if (record.next_due_date && record.next_due_date <= soonStr) {
        state = 'due_soon';
      } else {
        state = 'valid';
      }
      cells.push({
        id: `${training.id}:${person.key}`,
        state,
        person_key: person.key,
        person: person.name,
        training_title: training.title,
        days_overdue: state === 'expired' ? daysBetween(record.next_due_date, today) : '',
      });
    }
  }
  return cells;
}

// Clés = valeur stockée dans kpis.source_module.
export const MODULE_KPI_SOURCES = {
  capa: {
    table: 'capas',
    label: 'CAPA',
    async fetchRows(tenantId) {
      const rows = await selectAll('capas', 'id, status, due_date, closed_at, created_at, root_cause', tenantId);
      const now = new Date();
      const past = (d) => {
        if (!d) return false;
        const t = new Date(d);
        return !Number.isNaN(t.getTime()) && now.getTime() > t.getTime() + DAY_MS - 1;
      };
      return rowsFrom(rows, (r) => {
        const isOpen = r.status !== 'closed';
        return {
          _resolution_days: daysBetween(r.created_at, r.closed_at),
          _on_time: onTime(r.closed_at, r.due_date),
          _is_open: bool01(isOpen),
          _is_overdue: bool01(isOpen && r.due_date && past(r.due_date)),
          _open_age_days: isOpen ? daysBetween(r.created_at, now) : '',
          // CAPA rouverte : elle a une date de clôture mais son statut est repassé en cours.
          // C'est le seul signal automatique qu'une action corrective n'a pas tenu (§10.2.1 f).
          // (Une CAPA n'est jamais clôturée sans effectiveness_verified === true — un « échec »
          // de vérification la laisse ouverte, sans closed_at.)
          _reopened: bool01(r.closed_at && r.status !== 'closed'),
          // CAPA ouverte sans analyse de cause consignée — check direct du §10.2.1 b).
          _no_root_cause: bool01(isOpen && (!r.root_cause || String(r.root_cause).trim() === '')),
        };
      });
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
        'id, status, severity, received_date, due_date, resolution_date, customer_satisfied, root_cause, linked_capa_id, created_at',
        tenantId
      );
      const now = new Date();
      const past = (d) => {
        if (!d) return false;
        const t = new Date(d);
        return !Number.isNaN(t.getTime()) && now.getTime() > t.getTime() + DAY_MS - 1;
      };
      return rowsFrom(rows, (r) => {
        const isOpen = r.status === 'received' || r.status === 'investigating';
        const isResolved = r.status === 'resolved' || r.status === 'closed';
        const noFeedback = r.customer_satisfied === null || r.customer_satisfied === undefined;
        const severe = r.severity === 'high' || r.severity === 'critical';
        return {
          _resolution_days: daysBetween(r.received_date, r.resolution_date),
          _on_time: onTime(r.resolution_date, r.due_date),
          _is_open: bool01(isOpen),
          _is_overdue: bool01(isOpen && r.due_date && past(r.due_date)),
          _open_age_days: isOpen ? daysBetween(r.received_date, now) : '',
          // Client qui s'est explicitement déclaré insatisfait de la résolution.
          _customer_dissatisfied: bool01(r.customer_satisfied === false),
          // Réclamation traitée mais dont on n'a jamais recueilli l'avis du client (§9.1.2).
          _resolved_no_feedback: bool01(isResolved && noFeedback),
          // Réclamation ouverte sans analyse de cause consignée (§10.2.1 b).
          _no_root_cause: bool01(isOpen && (!r.root_cause || String(r.root_cause).trim() === '')),
          // Réclamation grave sans action corrective formalisée (CAPA) (§10.2).
          _severe_no_capa: bool01(severe && !r.linked_capa_id),
        };
      });
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
    label: 'Formations',
    async fetchRows(tenantId) {
      const rows = await selectAll('training_records', 'id, completed_at, next_due_date, created_at', tenantId);
      return rowsFrom(rows, () => ({}));
    },
  },

  // Compétences (§7.2) : une ligne par cellule concernée de la matrice personnel × formations.
  competence: {
    table: 'trainings',
    label: 'Formations',
    async fetchRows(tenantId) {
      const cells = await buildCompetenceCells(tenantId);
      return cells.map((c) => ({
        row_index: c.id,
        row_data: {
          state: c.state,
          person: c.person,
          training_title: c.training_title,
          _expired: bool01(c.state === 'expired'),
          _missing: bool01(c.state === 'missing'),
          _due_soon: bool01(c.state === 'due_soon'),
          _up_to_date: bool01(c.state === 'valid' || c.state === 'due_soon'),
          _days_overdue: c.days_overdue,
        },
      }));
    },
  },

  // Compétences (§7.2), vue par personne : une ligne par salarié concerné par ≥ 1 formation.
  competence_person: {
    table: 'trainings',
    label: 'Formations',
    async fetchRows(tenantId) {
      const cells = await buildCompetenceCells(tenantId);
      const byPerson = new Map();
      for (const c of cells) {
        const p = byPerson.get(c.person_key) || { person: c.person, gap: false, expired: false };
        if (c.state === 'expired' || c.state === 'missing') p.gap = true;
        if (c.state === 'expired') p.expired = true;
        byPerson.set(c.person_key, p);
      }
      return [...byPerson.entries()].map(([key, p]) => ({
        row_index: key,
        row_data: {
          person: p.person,
          _has_gap: bool01(p.gap),
          _has_expired: bool01(p.expired),
          _fully_covered: bool01(!p.gap),
        },
      }));
    },
  },
};

// Catalogue de métriques prêtes à l'emploi. `recipe` = ce qui atterrit dans
// kpi_calculation_configs (calc_type / period_column / source_column / group_by_column /
// filters / filter_logic). period_column est toujours une colonne de date brute : le
// bucketing par fréquence est fait par moduleKpiRecompute.js.
//
// target / target_direction : chaque preset porte une CIBLE par défaut, ajustable ensuite
// par l'utilisateur (le formulaire d'édition laisse target/target_direction modifiables sur
// un KPI de module). Convention alignée sur lib/kpiStatus.js :
//   - target_direction: 'min' → objectif PLANCHER, la réalisation doit rester ≥ cible
//     (plus la valeur est haute, mieux c'est : taux de couverture, % dans les délais…) ;
//   - target_direction: 'max' → objectif PLAFOND, la réalisation doit rester ≤ cible
//     (plus la valeur est basse, mieux c'est : délais, retards, écarts, accidents…).
export const MODULE_KPI_PRESETS = [
  // --- CAPA ---
  // Jeu orienté audit (§10.2 / §9.1) : une question d'auditeur = un indicateur = une courbe.
  // Cibles par défaut à ajuster à votre contexte ; 0 là où tout écart est une non-conformité.

  // Maîtrise du stock (photo à date).
  {
    id: 'capa_overdue_backlog',
    module: 'capa',
    label: 'CAPA en retard à ce jour',
    description: 'Nombre de CAPA non clôturées dont l’échéance est dépassée au moment du calcul.',
    unit: 'CAPA',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'capa_oldest_open_age',
    module: 'capa',
    label: 'Ancienneté de la plus ancienne CAPA ouverte',
    description: 'Nombre de jours écoulés depuis la création de la plus vieille CAPA encore ouverte.',
    unit: 'jours',
    target: 90,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'max',
      source_column: '_open_age_days',
      period_column: '__snapshot__',
      filters: [{ column: '_is_open', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'capa_open_backlog',
    module: 'capa',
    label: 'CAPA ouvertes à ce jour',
    description: 'Nombre de CAPA non clôturées au moment du calcul — suit la résorption du stock.',
    unit: 'CAPA',
    target: 10,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_open', operator: 'equals', value: '1' }] },
  },
  {
    id: 'capa_open_age_days',
    module: 'capa',
    label: 'Âge moyen des CAPA ouvertes',
    description: 'Ancienneté moyenne (jours) des CAPA non clôturées au moment du calcul.',
    unit: 'jours',
    target: 45,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: '_open_age_days',
      period_column: '__snapshot__',
      filters: [{ column: '_is_open', operator: 'equals', value: '1' }],
    },
  },

  // Délais de traitement (par mois de clôture).
  {
    id: 'capa_resolution_days',
    module: 'capa',
    label: 'Délai moyen de traitement des CAPA',
    description: 'Nombre de jours moyen entre la création et la clôture d’une CAPA.',
    unit: 'jours',
    target: 30,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: '_resolution_days',
      period_column: 'closed_at',
      filters: [{ column: 'status', operator: 'equals', value: 'closed' }],
    },
  },
  {
    id: 'capa_on_time_rate',
    module: 'capa',
    label: 'CAPA clôturées dans les délais',
    description: 'Part des CAPA clôturées dont la date de clôture respecte l’échéance (CAPA sans échéance incluses au dénominateur).',
    unit: '%',
    target: 90,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'closed_at', filters: [{ column: '_on_time', operator: 'equals', value: '1' }] },
  },

  // Efficacité / rigueur (photo à date, toute valeur > 0 est une non-conformité).
  {
    id: 'capa_reopened_backlog',
    module: 'capa',
    label: 'CAPA rouvertes',
    description: 'Nombre de CAPA actuellement dans un état rouvert (date de clôture posée, statut repassé en cours) — §10.2.1 f).',
    unit: 'CAPA',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_reopened', operator: 'equals', value: '1' }] },
  },
  {
    id: 'capa_no_root_cause_backlog',
    module: 'capa',
    label: 'CAPA ouvertes sans analyse de cause',
    description: 'Nombre de CAPA non clôturées dont le champ « cause racine » est vide — §10.2.1 b).',
    unit: 'CAPA',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_no_root_cause', operator: 'equals', value: '1' }] },
  },

  // Activité (par mois).
  {
    id: 'capa_opened_count',
    module: 'capa',
    label: 'Nouvelles CAPA',
    description: 'Nombre de CAPA créées sur la période.',
    unit: 'CAPA',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'created_at' },
  },
  {
    id: 'capa_closed_count',
    module: 'capa',
    label: 'CAPA clôturées',
    description: 'Nombre de CAPA passées au statut « clôturé » sur la période — à comparer aux CAPA ouvertes.',
    unit: 'CAPA',
    target: 1,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'closed_at', filters: [{ column: 'status', operator: 'equals', value: 'closed' }] },
  },

  // --- Non-conformités produit/service ---
  {
    id: 'nc_treated_count',
    module: 'nonconforming_output',
    label: 'Non-conformités traitées',
    description: 'Nombre de non-conformités clôturées sur la période — à comparer aux non-conformités détectées.',
    unit: 'NC',
    target: 1,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'closed_at', filters: [{ column: 'status', operator: 'equals', value: 'closed' }] },
  },
  {
    id: 'nc_closed_rate',
    module: 'nonconforming_output',
    label: 'Taux de clôture des non-conformités',
    description: 'Part des non-conformités détectées qui sont clôturées.',
    unit: '%',
    target: 90,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'detected_at', filters: [{ column: '_is_closed', operator: 'equals', value: '1' }] },
  },
  {
    id: 'nc_detected_count',
    module: 'nonconforming_output',
    label: 'Non-conformités détectées',
    description: 'Nombre de non-conformités produit/service détectées sur la période.',
    unit: 'NC',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'detected_at' },
  },

  // --- Réclamations ---
  // Jeu orienté audit (§8.2 / §9.1.2 / §10.2). Une question d'auditeur = un indicateur = une
  // courbe. Cibles par défaut à ajuster ; 0 là où tout écart est une non-conformité.

  // Réactivité / stock (photo à date).
  {
    id: 'complaint_overdue_backlog',
    module: 'complaint',
    label: 'Réclamations en retard à ce jour',
    description: 'Nombre de réclamations non résolues dont l’échéance est dépassée au moment du calcul.',
    unit: 'réclamations',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'complaint_oldest_open_age',
    module: 'complaint',
    label: 'Ancienneté de la plus ancienne réclamation ouverte',
    description: 'Nombre de jours écoulés depuis la réception de la plus vieille réclamation non résolue.',
    unit: 'jours',
    target: 60,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'max',
      source_column: '_open_age_days',
      period_column: '__snapshot__',
      filters: [{ column: '_is_open', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'complaint_open_backlog',
    module: 'complaint',
    label: 'Réclamations ouvertes à ce jour',
    description: 'Nombre de réclamations non résolues au moment du calcul — suit la résorption du stock.',
    unit: 'réclamations',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_open', operator: 'equals', value: '1' }] },
  },
  {
    id: 'complaint_open_age_days',
    module: 'complaint',
    label: 'Âge moyen des réclamations ouvertes',
    description: 'Ancienneté moyenne (jours) des réclamations non résolues au moment du calcul.',
    unit: 'jours',
    target: 30,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: '_open_age_days',
      period_column: '__snapshot__',
      filters: [{ column: '_is_open', operator: 'equals', value: '1' }],
    },
  },

  // Délais de traitement (par mois de résolution).
  {
    id: 'complaint_resolution_days',
    module: 'complaint',
    label: 'Délai moyen de résolution des réclamations',
    description: 'Nombre de jours moyen entre la réception et la résolution.',
    unit: 'jours',
    target: 30,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: '_resolution_days', period_column: 'resolution_date' },
  },
  {
    id: 'complaint_on_time_rate',
    module: 'complaint',
    label: 'Réclamations résolues dans les délais',
    description: 'Part des réclamations résolues dont la date de résolution respecte l’échéance (réclamations sans échéance incluses au dénominateur).',
    unit: '%',
    target: 90,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'resolution_date', filters: [{ column: '_on_time', operator: 'equals', value: '1' }] },
  },

  // Boucle client & causes (photo à date ou mensuel, toute valeur > 0 est une non-conformité).
  {
    id: 'complaint_dissatisfied_count',
    module: 'complaint',
    label: 'Clients insatisfaits à ce jour',
    description: 'Nombre de réclamations où le client s’est explicitement déclaré insatisfait de la résolution (§9.1.2).',
    unit: 'réclamations',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'count',
      period_column: '__snapshot__',
      filters: [{ column: '_customer_dissatisfied', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'complaint_no_feedback_backlog',
    module: 'complaint',
    label: 'Réclamations résolues sans retour client',
    description: 'Nombre de réclamations résolues ou clôturées dont l’avis du client n’a jamais été recueilli (§9.1.2).',
    unit: 'réclamations',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'count',
      period_column: '__snapshot__',
      filters: [{ column: '_resolved_no_feedback', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'complaint_no_root_cause_backlog',
    module: 'complaint',
    label: 'Réclamations ouvertes sans analyse de cause',
    description: 'Nombre de réclamations non résolues dont le champ « cause racine » est vide (§10.2.1 b).',
    unit: 'réclamations',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_no_root_cause', operator: 'equals', value: '1' }] },
  },
  {
    id: 'complaint_severe_no_capa_backlog',
    module: 'complaint',
    label: 'Réclamations graves sans CAPA',
    description: 'Nombre de réclamations de gravité élevée ou critique non reliées à une action corrective (§10.2).',
    unit: 'réclamations',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_severe_no_capa', operator: 'equals', value: '1' }] },
  },

  // Volume (par mois de réception).
  {
    id: 'complaint_received_count',
    module: 'complaint',
    label: 'Réclamations reçues',
    description: 'Nombre de réclamations clients reçues sur la période.',
    unit: 'réclamations',
    target: 3,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'received_date' },
  },

  // --- Accidents du travail ---
  {
    id: 'accident_count',
    module: 'accident',
    label: 'Accidents du travail déclarés',
    description: 'Nombre d’accidents du travail déclarés sur la période.',
    unit: 'accidents',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'occurred_at' },
  },
  {
    id: 'accident_lost_days',
    module: 'accident',
    label: 'Jours d’arrêt cumulés',
    description: 'Somme des jours d’arrêt de travail liés aux accidents de la période.',
    unit: 'jours',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'sum', source_column: 'lost_days', period_column: 'occurred_at' },
  },
  {
    id: 'accident_lost_time_rate',
    module: 'accident',
    label: 'Accidents avec arrêt de travail',
    description: 'Part des accidents déclarés ayant entraîné au moins un jour d’arrêt.',
    unit: '%',
    target: 0,
    target_direction: 'max',
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
    target: 4,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: 'score', period_column: 'survey_date' },
  },
  {
    id: 'satisfaction_survey_count',
    module: 'customer_satisfaction',
    label: 'Enquêtes de satisfaction réalisées',
    description: 'Nombre d’enquêtes de satisfaction consignées sur la période.',
    unit: 'enquêtes',
    target: 1,
    target_direction: 'min',
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
    target: 1,
    target_direction: 'min',
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
    target: 15,
    target_direction: 'max',
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
    target: 10,
    target_direction: 'max',
    frequency: 'quarterly',
    recipe: { calc_type: 'count', period_column: 'created_at' },
  },
  {
    id: 'audit_nc_count',
    module: 'audit_finding',
    label: 'Non-conformités d’audit (majeures + mineures)',
    description: 'Nombre de constats de type non-conformité relevés sur la période.',
    unit: 'NC',
    target: 3,
    target_direction: 'max',
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

  // --- Formations / compétences ---
  // Jeu orienté audit (§7.2 compétence). Une question d'auditeur = un indicateur = une
  // courbe. Cibles par défaut à ajuster ; 0 là où tout écart est une non-conformité.

  // Écarts de compétence (photo à date, sur la matrice personnel × formations obligatoires).
  {
    id: 'competence_expired_backlog',
    module: 'competence',
    label: 'Formations obligatoires expirées',
    description: 'Nombre de compétences requises dont la date de renouvellement est dépassée (§7.2).',
    unit: 'compétences',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_expired', operator: 'equals', value: '1' }] },
  },
  {
    id: 'competence_missing_backlog',
    module: 'competence',
    label: 'Formations obligatoires jamais suivies',
    description: 'Nombre de compétences requises pour un poste sans aucune réalisation enregistrée (§7.2).',
    unit: 'compétences',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_missing', operator: 'equals', value: '1' }] },
  },
  {
    id: 'competence_people_with_gap',
    module: 'competence_person',
    label: 'Personnes non pleinement qualifiées',
    description: 'Nombre de personnes ayant au moins une formation obligatoire expirée ou jamais suivie (§7.2).',
    unit: 'personnes',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_has_gap', operator: 'equals', value: '1' }] },
  },
  {
    id: 'competence_coverage_rate',
    module: 'competence',
    label: 'Taux de couverture des compétences',
    description: 'Part des compétences requises qui sont à jour (valides ou à renouveler prochainement).',
    unit: '%',
    target: 95,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: '__snapshot__', filters: [{ column: '_up_to_date', operator: 'equals', value: '1' }] },
  },
  {
    id: 'competence_oldest_overdue_days',
    module: 'competence',
    label: 'Retard de la formation la plus en retard',
    description: 'Nombre de jours écoulés depuis l’échéance de renouvellement la plus ancienne non traitée.',
    unit: 'jours',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'max',
      source_column: '_days_overdue',
      period_column: '__snapshot__',
      filters: [{ column: '_expired', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'competence_due_soon_backlog',
    module: 'competence',
    label: 'Formations à renouveler sous 60 jours',
    description: 'Nombre de compétences requises dont le renouvellement arrive à échéance dans les 60 jours — anticipation.',
    unit: 'compétences',
    target: 10,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_due_soon', operator: 'equals', value: '1' }] },
  },

  // Activité (par mois de réalisation).
  {
    id: 'training_completions',
    module: 'training_record',
    label: 'Réalisations de formation',
    description: 'Nombre de formations effectivement suivies (par personne) sur la période.',
    unit: 'réalisations',
    target: 1,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'completed_at' },
  },
];

export function getPreset(presetId) {
  return MODULE_KPI_PRESETS.find((p) => p.id === presetId) || null;
}
