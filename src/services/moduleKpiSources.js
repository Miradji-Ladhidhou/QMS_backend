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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function inDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Une ligne par fournisseur ACTIF, enrichie de sa dernière évaluation (§8.4). Modèle
// buildCompetenceCells : pas de filtre de catégorie, un KPI fournisseur couvre le panel.
async function buildSupplierRows(tenantId) {
  const today = todayStr();
  const [supRes, evalRes] = await Promise.all([
    supabase.from('suppliers').select('id, name, criticality, status, next_evaluation_date').eq('tenant_id', tenantId).limit(50000),
    supabase
      .from('supplier_evaluations')
      .select('supplier_id, evaluation_date, overall_score, decision')
      .eq('tenant_id', tenantId)
      .limit(50000),
  ]);
  const err = supRes.error || evalRes.error;
  if (err) throw new Error(`Fournisseurs : ${err.message}`);

  const latest = new Map();
  for (const e of evalRes.data || []) {
    const cur = latest.get(e.supplier_id);
    if (!cur || e.evaluation_date > cur.evaluation_date) latest.set(e.supplier_id, e);
  }

  return (supRes.data || [])
    .filter((s) => s.status === 'active')
    .map((s) => {
      const ev = latest.get(s.id);
      const critical = s.criticality === 'high' || s.criticality === 'critical';
      const score = ev ? Number(ev.overall_score) : '';
      return {
        row_index: s.id,
        row_data: {
          name: s.name,
          criticality: s.criticality,
          _is_critical: bool01(critical),
          _eval_overdue: bool01(s.next_evaluation_date && s.next_evaluation_date < today),
          _never_evaluated: bool01(critical && !ev),
          _latest_score: score === '' || Number.isNaN(score) ? '' : score,
          _below_threshold: score !== '' && !Number.isNaN(score) && score < 3 ? '1' : '0',
          _to_replace: bool01(ev && ev.decision === 'to_replace'),
        },
      };
    });
}

// Une ligne par danger HACCP SIGNIFICATIF (is_significant = true) — le seul cas où l'absence
// d'un CCP est une non-conformité de la démarche (un danger jugé non significatif n'a, par
// définition, pas besoin d'un point critique).
async function buildHazardRows(tenantId) {
  const [hazardsRes, ccpsRes] = await Promise.all([
    supabase.from('haccp_hazards').select('id, is_significant').eq('tenant_id', tenantId).limit(50000),
    supabase.from('haccp_ccps').select('hazard_id').eq('tenant_id', tenantId).limit(50000),
  ]);
  const err = hazardsRes.error || ccpsRes.error;
  if (err) throw new Error(`Dangers HACCP : ${err.message}`);

  const hazardsWithCcp = new Set((ccpsRes.data || []).map((c) => c.hazard_id));

  return (hazardsRes.data || [])
    .filter((h) => h.is_significant)
    .map((h) => ({
      row_index: h.id,
      row_data: { _significant_no_ccp: bool01(!hazardsWithCcp.has(h.id)) },
    }));
}

// Une ligne par action issue d'une revue de direction, croisée avec le statut de la CAPA
// éventuellement liée (§9.3.3 : les décisions/actions de revue doivent être suivies).
async function buildManagementReviewActionRows(tenantId) {
  const [actionsRes, capasRes] = await Promise.all([
    supabase.from('management_review_actions').select('id, linked_capa_id, created_at').eq('tenant_id', tenantId).limit(50000),
    supabase.from('capas').select('id, status').eq('tenant_id', tenantId).limit(50000),
  ]);
  const err = actionsRes.error || capasRes.error;
  if (err) throw new Error(`Actions de revue de direction : ${err.message}`);

  const capaStatusById = new Map((capasRes.data || []).map((c) => [c.id, c.status]));

  return (actionsRes.data || []).map((a) => {
    const capaStatus = a.linked_capa_id ? capaStatusById.get(a.linked_capa_id) : null;
    const noCapa = !a.linked_capa_id;
    const capaOpen = Boolean(a.linked_capa_id) && capaStatus && capaStatus !== 'closed';
    return {
      row_index: a.id,
      row_data: {
        _no_capa: bool01(noCapa),
        _unresolved: bool01(noCapa || capaOpen),
      },
    };
  });
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
    // Même groupe que `audit` (pas un label distinct) : dans le catalogue « Depuis un module »,
    // les deux sources doivent apparaître comme une seule section « Audits internes », comme
    // Formations/Fournisseurs/Étalonnage/Documents regroupent déjà leurs sources jumelles.
    label: 'Audits internes',
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

  // Risques & opportunités (§6.1). risk_score est généré (probabilité × gravité, 1-25) ;
  // bandes alignées sur frontend/src/lib/riskStatus.js : ≥ 10 = élevé/critique.
  risk: {
    table: 'risks',
    label: 'Risques',
    async fetchRows(tenantId) {
      const today = todayStr();
      const rows = await selectAll('risks', 'id, type, status, risk_score, treatment_plan, review_date, created_at', tenantId);
      // Les opportunités partagent la table mais pas la logique : « opportunité élevée non
      // traitée » ou « criticité moyenne » n'ont de sens que pour les risques. Ce jeu de KPI
      // mesure la maîtrise des risques.
      const risksOnly = rows.filter((r) => r.type !== 'opportunity');
      return rowsFrom(risksOnly, (r) => {
        const isOpen = r.status === 'identified' || r.status === 'treating';
        const score = Number(r.risk_score);
        return {
          _is_open: bool01(isOpen),
          _high_untreated: bool01(isOpen && score >= 10),
          _no_plan: bool01(isOpen && (!r.treatment_plan || String(r.treatment_plan).trim() === '')),
          _review_overdue: bool01(r.status !== 'closed' && r.review_date && r.review_date < today),
          // Risque « maîtrisé » : traité, accepté en connaissance de cause, ou clôturé.
          _handled: bool01(r.status === 'treated' || r.status === 'accepted' || r.status === 'closed'),
        };
      });
    },
  },

  // Fournisseurs (§8.4) — une ligne par fournisseur actif + sa dernière évaluation.
  supplier: {
    table: 'suppliers',
    label: 'Fournisseurs',
    fetchRows: buildSupplierRows,
  },
  // Évaluations fournisseurs, brut — volume mensuel.
  supplier_evaluation: {
    table: 'supplier_evaluations',
    label: 'Fournisseurs',
    async fetchRows(tenantId) {
      const rows = await selectAll('supplier_evaluations', 'id, evaluation_date, overall_score, decision', tenantId);
      return rowsFrom(rows, () => ({}));
    },
  },

  // Documents (§7.5.3 — revue périodique). Seuls les documents APPROUVÉS ont un cycle de
  // revue qui compte : un brouillon ou une version obsolète n'en a pas besoin.
  document: {
    table: 'documents',
    label: 'Documents',
    async fetchRows(tenantId) {
      const today = todayStr();
      const soon = inDaysStr(RENEWAL_WINDOW_DAYS);
      const rows = await selectAll('documents', 'id, status, review_date', tenantId);
      return rowsFrom(
        rows.filter((r) => r.status === 'approved'),
        (r) => ({
          _review_overdue: bool01(r.review_date && r.review_date < today),
          _review_due_soon: bool01(r.review_date && r.review_date >= today && r.review_date <= soon),
          _no_review_schedule: bool01(!r.review_date),
        })
      );
    },
  },

  // HACCP — dangers significatifs (§ méthode HACCP, principe 6/7).
  haccp_hazard: {
    table: 'haccp_hazards',
    label: 'HACCP',
    fetchRows: buildHazardRows,
  },
  // HACCP — relevés de surveillance des CCP, bruts (un écart = within_limits === false).
  // corrective_action_taken est déjà obligatoire côté API dès qu'un écart est saisi (voir
  // routes/haccp.js POST .../monitoring-logs) : inutile de le re-vérifier ici, ce serait
  // toujours vrai. Ce qui reste un vrai indicateur : l'écart relié ou non à une CAPA formelle.
  haccp_monitoring: {
    table: 'haccp_monitoring_logs',
    label: 'HACCP',
    async fetchRows(tenantId) {
      const rows = await selectAll('haccp_monitoring_logs', 'id, within_limits, linked_capa_id, recorded_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _within_limits: bool01(r.within_limits),
        _deviation: bool01(!r.within_limits),
        _deviation_no_capa: bool01(!r.within_limits && !r.linked_capa_id),
      }));
    },
  },

  // PDCA — projets d'amélioration continue.
  pdca: {
    table: 'pdca_projects',
    label: 'PDCA',
    async fetchRows(tenantId) {
      const today = todayStr();
      const now = new Date();
      const rows = await selectAll('pdca_projects', 'id, status, target_date, closed_at, created_at, updated_at', tenantId);
      return rowsFrom(rows, (r) => {
        const isOpen = r.status !== 'closed';
        return {
          _is_open: bool01(isOpen),
          _overdue: bool01(isOpen && r.target_date && r.target_date < today),
          // Aucune modification depuis 60 jours sur un projet non clôturé — proxy simple de
          // « projet à l'arrêt » (toute mise à jour du contenu réinitialise ce compteur).
          _stalled: bool01(isOpen && daysBetween(r.updated_at, now) > 60),
          _cycle_days: daysBetween(r.created_at, r.closed_at),
        };
      });
    },
  },

  // Planification des modifications (§6.3).
  qms_change: {
    table: 'qms_changes',
    label: 'Planification des modifications',
    async fetchRows(tenantId) {
      const today = todayStr();
      const rows = await selectAll('qms_changes', 'id, status, planned_date, implemented_at, created_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _pending_approval: bool01(r.status === 'planned'),
        // Approuvée mais toujours pas mise en œuvre alors que sa date prévue est dépassée.
        _overdue: bool01(r.status === 'approved' && r.planned_date && r.planned_date < today),
        _lead_days: r.implemented_at ? daysBetween(r.created_at, r.implemented_at) : '',
      }));
    },
  },

  // Actions issues d'une revue de direction (§9.3.3).
  management_review_action: {
    table: 'management_review_actions',
    label: 'Revues de direction',
    fetchRows: buildManagementReviewActionRows,
  },

  // Procédures — cycle de revue et blocages en relecture.
  procedure: {
    table: 'procedures',
    label: 'Procédures',
    async fetchRows(tenantId) {
      const today = todayStr();
      const now = new Date();
      const rows = await selectAll('procedures', 'id, status, next_review_date, updated_at', tenantId);
      return rowsFrom(rows, (r) => ({
        _review_overdue: bool01(r.status !== 'obsolete' && r.next_review_date && r.next_review_date < today),
        // Aucune modification depuis 30 jours sur une procédure en relecture — proxy de blocage
        // (même principe que PDCA _stalled).
        _stuck_in_review: bool01(r.status === 'in_review' && daysBetween(r.updated_at, now) > 30),
      }));
    },
  },

  // Circuits d'approbation documentaire (§7.5.3 — maîtrise avant diffusion).
  document_workflow: {
    table: 'document_workflows',
    label: 'Documents',
    async fetchRows(tenantId) {
      const now = new Date();
      const rows = await selectAll('document_workflows', 'id, status, created_at', tenantId);
      return rowsFrom(rows, (r) => {
        const pending = r.status === 'pending';
        return {
          _pending: bool01(pending),
          _pending_age_days: pending ? daysBetween(r.created_at, now) : '',
        };
      });
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

  // --- Risques & opportunités ---
  // Jeu orienté audit (§6.1). Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'risk_high_untreated_backlog',
    module: 'risk',
    label: 'Risques élevés non traités à ce jour',
    description: 'Nombre de risques de criticité élevée ou critique (score ≥ 10) encore au statut « identifié » ou « en traitement ».',
    unit: 'risques',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_high_untreated', operator: 'equals', value: '1' }] },
  },
  {
    id: 'risk_no_plan_backlog',
    module: 'risk',
    label: 'Risques actifs sans plan de traitement',
    description: 'Nombre de risques non traités dont le champ « plan de traitement » est vide.',
    unit: 'risques',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_no_plan', operator: 'equals', value: '1' }] },
  },
  {
    id: 'risk_review_overdue_backlog',
    module: 'risk',
    label: 'Risques dont la revue est en retard',
    description: 'Nombre de risques non clôturés dont la date de revue est dépassée.',
    unit: 'risques',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_review_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'risk_open_backlog',
    module: 'risk',
    label: 'Risques actifs à ce jour',
    description: 'Nombre de risques au statut « identifié » ou « en traitement » au moment du calcul.',
    unit: 'risques',
    target: 20,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_open', operator: 'equals', value: '1' }] },
  },
  {
    id: 'risk_avg_score',
    module: 'risk',
    label: 'Criticité moyenne des risques actifs',
    description: 'Score moyen (probabilité × gravité) des risques non traités.',
    unit: 'points',
    target: 8,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: 'risk_score',
      period_column: '__snapshot__',
      filters: [{ column: '_is_open', operator: 'equals', value: '1' }],
    },
  },
  {
    id: 'risk_treatment_coverage',
    module: 'risk',
    label: 'Taux de risques maîtrisés',
    description: 'Part des risques qui sont traités, acceptés ou clôturés (par rapport à l’ensemble du registre).',
    unit: '%',
    target: 80,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: '__snapshot__', filters: [{ column: '_handled', operator: 'equals', value: '1' }] },
  },
  {
    id: 'risk_opened_count',
    module: 'risk',
    label: 'Nouveaux risques identifiés',
    description: 'Nombre de risques créés sur la période.',
    unit: 'risques',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'created_at' },
  },

  // --- Fournisseurs ---
  // Jeu orienté audit (§8.4). Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'supplier_eval_overdue_backlog',
    module: 'supplier',
    label: 'Fournisseurs à réévaluer en retard',
    description: 'Nombre de fournisseurs actifs dont la date de prochaine évaluation est dépassée.',
    unit: 'fournisseurs',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_eval_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'supplier_critical_unevaluated_backlog',
    module: 'supplier',
    label: 'Fournisseurs critiques jamais évalués',
    description: 'Nombre de fournisseurs de criticité élevée ou critique sans aucune évaluation enregistrée.',
    unit: 'fournisseurs',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_never_evaluated', operator: 'equals', value: '1' }] },
  },
  {
    id: 'supplier_below_threshold_backlog',
    module: 'supplier',
    label: 'Fournisseurs sous le seuil (note < 3/5)',
    description: 'Nombre de fournisseurs actifs dont la dernière note globale est inférieure à 3 sur 5.',
    unit: 'fournisseurs',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_below_threshold', operator: 'equals', value: '1' }] },
  },
  {
    id: 'supplier_to_replace_backlog',
    module: 'supplier',
    label: 'Fournisseurs « à remplacer » encore actifs',
    description: 'Nombre de fournisseurs dont la dernière évaluation conclut « à remplacer » mais qui restent au statut actif.',
    unit: 'fournisseurs',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_to_replace', operator: 'equals', value: '1' }] },
  },
  {
    id: 'supplier_avg_score',
    module: 'supplier',
    label: 'Note moyenne des fournisseurs évalués',
    description: 'Moyenne de la dernière note globale (sur 5) des fournisseurs actifs qui ont été évalués.',
    unit: '/5',
    target: 4,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: {
      calc_type: 'average',
      source_column: '_latest_score',
      period_column: '__snapshot__',
      filters: [{ column: '_latest_score', operator: 'is_not_empty' }],
    },
  },
  {
    id: 'supplier_evaluations_count',
    module: 'supplier_evaluation',
    label: 'Évaluations fournisseurs réalisées',
    description: 'Nombre d’évaluations de fournisseurs consignées sur la période.',
    unit: 'évaluations',
    target: 1,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'evaluation_date' },
  },

  // --- Documents ---
  // Jeu orienté audit (§7.5.3). Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'document_review_overdue_backlog',
    module: 'document',
    label: 'Documents dont la revue est en retard',
    description: 'Nombre de documents approuvés dont la date de revue périodique est dépassée.',
    unit: 'documents',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_review_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'document_review_due_soon_backlog',
    module: 'document',
    label: 'Documents à revoir sous 60 jours',
    description: 'Nombre de documents approuvés dont la revue arrive à échéance dans les 60 jours — anticipation.',
    unit: 'documents',
    target: 10,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_review_due_soon', operator: 'equals', value: '1' }] },
  },
  {
    id: 'document_no_review_schedule_backlog',
    module: 'document',
    label: 'Documents approuvés sans date de revue',
    description: 'Nombre de documents approuvés sans aucune date de revue programmée.',
    unit: 'documents',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_no_review_schedule', operator: 'equals', value: '1' }] },
  },

  // --- HACCP ---
  // Jeu orienté audit (méthode HACCP). Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'haccp_significant_hazard_no_ccp_backlog',
    module: 'haccp_hazard',
    label: 'Dangers significatifs sans CCP',
    description: 'Nombre de dangers jugés significatifs sans aucun point critique (CCP) associé.',
    unit: 'dangers',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_significant_no_ccp', operator: 'equals', value: '1' }] },
  },
  {
    id: 'haccp_deviation_count',
    module: 'haccp_monitoring',
    label: 'Écarts CCP constatés',
    description: 'Nombre de relevés de surveillance hors limites critiques sur la période.',
    unit: 'écarts',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'recorded_at', filters: [{ column: '_deviation', operator: 'equals', value: '1' }] },
  },
  {
    id: 'haccp_compliance_rate',
    module: 'haccp_monitoring',
    label: 'Taux de conformité des relevés CCP',
    description: 'Part des relevés de surveillance CCP dans les limites critiques.',
    unit: '%',
    target: 98,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'ratio', period_column: 'recorded_at', filters: [{ column: '_within_limits', operator: 'equals', value: '1' }] },
  },
  {
    id: 'haccp_deviation_no_capa_count',
    module: 'haccp_monitoring',
    label: 'Écarts CCP sans CAPA',
    description: 'Nombre d’écarts constatés qui ne sont reliés à aucune action corrective formelle (CAPA).',
    unit: 'écarts',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'recorded_at', filters: [{ column: '_deviation_no_capa', operator: 'equals', value: '1' }] },
  },

  // --- PDCA ---
  // Jeu orienté audit. Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'pdca_overdue_backlog',
    module: 'pdca',
    label: 'Projets PDCA en retard',
    description: 'Nombre de projets d’amélioration non clôturés dont la date cible est dépassée.',
    unit: 'projets',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'pdca_open_backlog',
    module: 'pdca',
    label: 'Projets PDCA en cours à ce jour',
    description: 'Nombre de projets d’amélioration continue actuellement en cours (non clôturés).',
    unit: 'projets',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_is_open', operator: 'equals', value: '1' }] },
  },
  {
    id: 'pdca_stalled_backlog',
    module: 'pdca',
    label: 'Projets PDCA à l’arrêt',
    description: 'Nombre de projets non clôturés sans aucune modification depuis plus de 60 jours.',
    unit: 'projets',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_stalled', operator: 'equals', value: '1' }] },
  },
  {
    id: 'pdca_closed_count',
    module: 'pdca',
    label: 'Projets PDCA clôturés',
    description: 'Nombre de projets d’amélioration menés jusqu’à la clôture sur la période.',
    unit: 'projets',
    target: 1,
    target_direction: 'min',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: 'closed_at', filters: [{ column: '_is_open', operator: 'equals', value: '0' }] },
  },
  {
    id: 'pdca_avg_cycle_days',
    module: 'pdca',
    label: 'Durée moyenne d’un cycle PDCA',
    description: 'Nombre de jours moyen entre l’ouverture et la clôture d’un projet d’amélioration.',
    unit: 'jours',
    target: 90,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: '_cycle_days', period_column: 'closed_at' },
  },

  // --- Planification des modifications ---
  // Jeu orienté audit (§6.3). Une question d'auditeur = un indicateur = une courbe.
  {
    id: 'qms_change_overdue_backlog',
    module: 'qms_change',
    label: 'Modifications approuvées en retard de mise en œuvre',
    description: 'Nombre de modifications approuvées dont la date prévue est dépassée sans être mises en œuvre.',
    unit: 'modifications',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'qms_change_pending_approval_backlog',
    module: 'qms_change',
    label: 'Modifications en attente d’approbation',
    description: 'Nombre de modifications planifiées mais pas encore approuvées.',
    unit: 'modifications',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_pending_approval', operator: 'equals', value: '1' }] },
  },
  {
    id: 'qms_change_lead_days',
    module: 'qms_change',
    label: 'Délai moyen de mise en œuvre d’une modification',
    description: 'Nombre de jours moyen entre le signalement d’une modification et sa mise en œuvre effective.',
    unit: 'jours',
    target: 30,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'average', source_column: '_lead_days', period_column: 'implemented_at' },
  },

  // --- Revues de direction ---
  {
    id: 'management_review_action_no_capa_backlog',
    module: 'management_review_action',
    label: 'Actions de revue de direction sans suivi formalisé',
    description: 'Nombre d’actions décidées en revue de direction sans aucune CAPA associée.',
    unit: 'actions',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_no_capa', operator: 'equals', value: '1' }] },
  },
  {
    id: 'management_review_action_unresolved_backlog',
    module: 'management_review_action',
    label: 'Actions de revue de direction non soldées',
    description: 'Nombre d’actions de revue de direction sans CAPA associée ou dont la CAPA associée n’est pas clôturée.',
    unit: 'actions',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_unresolved', operator: 'equals', value: '1' }] },
  },

  // --- Procédures ---
  {
    id: 'procedure_review_overdue_backlog',
    module: 'procedure',
    label: 'Procédures dont la revue est en retard',
    description: 'Nombre de procédures (hors obsolètes) dont la date de prochaine revue est dépassée.',
    unit: 'procédures',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_review_overdue', operator: 'equals', value: '1' }] },
  },
  {
    id: 'procedure_stuck_in_review_backlog',
    module: 'procedure',
    label: 'Procédures bloquées en relecture',
    description: 'Nombre de procédures en statut « en relecture » sans modification depuis plus de 30 jours.',
    unit: 'procédures',
    target: 0,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_stuck_in_review', operator: 'equals', value: '1' }] },
  },

  // --- Approbations documentaires ---
  {
    id: 'document_approval_pending_backlog',
    module: 'document_workflow',
    label: 'Approbations documentaires en attente',
    description: 'Nombre de circuits d’approbation de documents actuellement en attente d’une décision.',
    unit: 'circuits',
    target: 5,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: { calc_type: 'count', period_column: '__snapshot__', filters: [{ column: '_pending', operator: 'equals', value: '1' }] },
  },
  {
    id: 'document_approval_oldest_pending_age',
    module: 'document_workflow',
    label: 'Ancienneté de la plus vieille approbation en attente',
    description: 'Nombre de jours écoulés depuis l’ouverture du plus ancien circuit d’approbation encore en attente.',
    unit: 'jours',
    target: 10,
    target_direction: 'max',
    frequency: 'monthly',
    recipe: {
      calc_type: 'max',
      source_column: '_pending_age_days',
      period_column: '__snapshot__',
      filters: [{ column: '_pending', operator: 'equals', value: '1' }],
    },
  },
];

export function getPreset(presetId) {
  return MODULE_KPI_PRESETS.find((p) => p.id === presetId) || null;
}
