import { supabase } from './supabase.js';
import { fetchAuditorQualifications } from './auditorQualification.js';
import { KPI_EVALUATION_SELECT, evaluateKpiSeries, meetsTarget, offTargetSeries } from './kpiSeriesEvaluation.js';

// Photo chiffrée de l'état du SMQ, tenant-wide (pas de scope par service : une revue de
// direction concerne l'entreprise dans son ensemble) — utilisée pour figer le snapshot d'une
// revue de direction à sa clôture (voir schema.sql, management_reviews.snapshot) sans dépendre
// des fonctions de dashboard.js (qui, elles, gèrent le scope par service/rôle, un besoin
// différent). Volontairement indépendante plutôt que réutilisée : coupler ce module à
// dashboard.js risquerait de casser une route déjà testée pour un besoin qui n'est pas le sien.
const RENEWAL_WINDOW_DAYS = 60;
const DOCUMENT_REVIEW_WINDOW_DAYS = 30;

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function countCapasByStatus(tenantId) {
  const { data, error } = await supabase.from('capas').select('status').eq('tenant_id', tenantId);
  const counts = { open: 0, in_progress: 0, pending_verification: 0, closed: 0, overdue: 0 };
  if (error || !data) return counts;
  for (const capa of data) {
    if (capa.status in counts) counts[capa.status] += 1;
  }
  return counts;
}

async function countAuditsByStatus(tenantId) {
  const { data, error } = await supabase.from('audits').select('status').eq('tenant_id', tenantId);
  const counts = { planned: 0, in_progress: 0, completed: 0, closed: 0 };
  if (error || !data) return counts;
  for (const audit of data) {
    if (audit.status in counts) counts[audit.status] += 1;
  }
  return counts;
}

async function countDocumentsToReview(tenantId) {
  const threshold = isoDateInDays(DOCUMENT_REVIEW_WINDOW_DAYS);
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .not('review_date', 'is', null)
    .lte('review_date', threshold);
  return error ? 0 : count || 0;
}

// Même logique de déduplication (dernier enregistrement par formation/personne) que
// dashboard.js/planningItems.js — dupliquée ici plutôt qu'importée, ce module reste
// volontairement autonome (voir commentaire en tête de fichier).
async function countTrainingsToRenew(tenantId) {
  const { data, error } = await supabase
    .from('training_records')
    .select('training_id, user_id, employee_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);
  if (error || !data) return 0;

  const latestByPair = new Map();
  for (const record of data) {
    const personKey = record.user_id ? `u:${record.user_id}` : `e:${record.employee_id}`;
    const key = `${record.training_id}:${personKey}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  const threshold = isoDateInDays(RENEWAL_WINDOW_DAYS);
  let count = 0;
  for (const record of latestByPair.values()) {
    if (record.next_due_date && record.next_due_date <= threshold) count += 1;
  }
  return count;
}

// Le statut hors objectif reflète les relevés RÉCENTS (fenêtre de kpiSeriesEvaluation.js, la même
// que Kpis.jsx, le dashboard et kpiReportPdf.js), jamais toute la vie du KPI — sinon l'instantané
// d'une revue de direction pourrait contredire ce que montre l'app elle-même. Un KPI est hors
// objectif dès qu'une de ses séries (courbes) n'atteint pas SON objectif : jamais de moyenne de
// séries qui n'ont ni la même unité ni le même objectif.
async function countOffTargetKpis(tenantId) {
  const { data, error } = await supabase.from('kpis').select(KPI_EVALUATION_SELECT).eq('tenant_id', tenantId);
  if (error || !data) return 0;
  return data.filter((kpi) => offTargetSeries(kpi).length > 0).length;
}

function averageOf(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function addDaysToDate(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

// Moyenne des relevés sur la période vs. sur une période précédente de même durée, calculée en
// JS après un seul fetch (même style que countOffTargetKpis ci-dessus) — pas de SQL
// d'agrégation. Toujours tous les KPI du tenant, avec ou sans objectif chiffré : un KPI sans
// target reste "suivi", sa tendance a du sens même sans statut bon/mauvais à en tirer.
async function computeKpiTrend(tenantId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('kpis')
    .select(KPI_EVALUATION_SELECT)
    .eq('tenant_id', tenantId);
  if (error || !data) return [];

  const periodLengthDays = daysBetween(periodStart, periodEnd) + 1;
  const previousEnd = addDaysToDate(periodStart, -1);
  const previousStart = addDaysToDate(periodStart, -periodLengthDays);

  const inRange = (records, start, end) => records.filter((r) => r.period_date >= start && r.period_date <= end).map((r) => r.value);
  const trendOf = (current, previous) => (current !== null && previous !== null ? (current > previous ? 'up' : current < previous ? 'down' : 'stable') : null);

  return data.map((kpi) => {
    const { showMultiSeries, series } = evaluateKpiSeries(kpi);
    const base = { id: kpi.id, name: kpi.name, unit: kpi.unit, target: kpi.target, target_direction: kpi.target_direction };

    // Plusieurs séries : une ligne par série, avec SON unité, SON objectif et SON sens — le KPI n'a
    // alors ni moyenne ni tendance globales, elles n'auraient aucun sens.
    if (showMultiSeries) {
      return {
        ...base,
        current_avg: null,
        previous_avg: null,
        trend: null,
        series: series.map((item) => {
          const currentAvg = averageOf(inRange(item.records, periodStart, periodEnd));
          const previousAvg = averageOf(inRange(item.records, previousStart, previousEnd));
          return {
            label: item.label,
            unit: item.unit,
            target: item.target,
            target_direction: item.direction,
            current_avg: currentAvg,
            previous_avg: previousAvg,
            trend: trendOf(currentAvg, previousAvg),
            meets_target: meetsTarget(currentAvg, item.target, item.direction),
          };
        }),
      };
    }

    const currentAvg = averageOf(inRange(kpi.records, periodStart, periodEnd));
    const previousAvg = averageOf(inRange(kpi.records, previousStart, previousEnd));
    return {
      ...base,
      current_avg: currentAvg,
      previous_avg: previousAvg,
      trend: trendOf(currentAvg, previousAvg),
      meets_target: meetsTarget(currentAvg, kpi.target, kpi.target_direction),
    };
  });
}

// planned_date (not null) plutôt que completed_date (nullable, exclurait à tort les audits
// planifiés/en cours de "la période") : on veut le programme d'audit de la période, pas
// seulement ceux déjà terminés. Seul axe de gravité qui existe pour les audits : le type des
// constats (audit_findings.type), les audits eux-mêmes n'ont qu'un statut d'avancement.
const AUDIT_FINDING_TYPES = ['major_nc', 'minor_nc', 'observation', 'strength'];

async function computeAuditsPeriod(tenantId, periodStart, periodEnd) {
  const emptyFindings = Object.fromEntries(AUDIT_FINDING_TYPES.map((type) => [type, 0]));
  const { data: audits, error } = await supabase
    .from('audits')
    .select('id')
    .eq('tenant_id', tenantId)
    .gte('planned_date', periodStart)
    .lte('planned_date', periodEnd);
  if (error || !audits || audits.length === 0) return { count: 0, findings_by_type: emptyFindings };

  const { data: findings, error: findingsError } = await supabase
    .from('audit_findings')
    .select('type')
    .eq('tenant_id', tenantId)
    .in('audit_id', audits.map((audit) => audit.id));

  const findingsByType = { ...emptyFindings };
  if (!findingsError && findings) {
    for (const finding of findings) {
      if (finding.type in findingsByType) findingsByType[finding.type] += 1;
    }
  }
  return { count: audits.length, findings_by_type: findingsByType };
}

// "Ouvertes" = pas encore résolues au moment du calcul, même filtre déjà établi dans
// services/planningItems.js — pas un filtre sur la période, une réclamation reçue avant la
// période peut très bien être encore ouverte aujourd'hui.
async function computeComplaintsPeriod(tenantId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('complaints')
    .select('status')
    .eq('tenant_id', tenantId)
    .gte('received_date', periodStart)
    .lte('received_date', periodEnd);
  if (error || !data) return { received: 0, still_open: 0 };

  const stillOpen = data.filter((complaint) => !['resolved', 'closed'].includes(complaint.status)).length;
  return { received: data.length, still_open: stillOpen };
}

// in_progress reste un compte global actuel (pas de sens à le borner à la période — une CAPA en
// cours l'est "maintenant", pas "pendant telle fenêtre"). closed_in_period/on_time_closure_rate
// sont les seules métriques réellement period-scoped ici. Borne haute EXCLUSIVE
// (< periodEnd + 1 jour) : closed_at est un timestamptz, une comparaison <= periodEnd (date nue)
// comparerait contre minuit UTC de ce jour-là et exclurait à tort une CAPA clôturée plus tard le
// dernier jour de la période.
async function computeCapasPeriod(tenantId, periodStart, periodEnd) {
  const { count: inProgress, error: inProgressError } = await supabase
    .from('capas')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'in_progress');

  const periodEndExclusive = addDaysToDate(periodEnd, 1);
  const { data: closed, error: closedError } = await supabase
    .from('capas')
    .select('due_date, closed_at')
    .eq('tenant_id', tenantId)
    .eq('status', 'closed')
    .gte('closed_at', periodStart)
    .lt('closed_at', periodEndExclusive);

  const closedInPeriod = closedError || !closed ? [] : closed;
  // Une CAPA sans échéance n'a rien à respecter : exclue du dénominateur plutôt que comptée
  // "à l'heure" par défaut, ce qui gonflerait artificiellement le taux.
  const rated = closedInPeriod.filter((capa) => capa.due_date);
  const onTime = rated.filter((capa) => capa.closed_at.slice(0, 10) <= capa.due_date);

  return {
    in_progress: inProgressError ? 0 : inProgress || 0,
    closed_in_period: closedInPeriod.length,
    // null (pas 0) quand rated est vide, pour afficher "—" plutôt qu'un pourcentage trompeur.
    on_time_closure_rate: rated.length > 0 ? Math.round((onTime.length / rated.length) * 100) : null,
  };
}

// Miroir de riskLevel (frontend/src/lib/riskStatus.js) : qmsSnapshot.js ne peut pas importer de
// code frontend (voir commentaire en tête de fichier), même duplication assumée que
// getKpiStatus/countOffTargetKpis ci-dessus. Pas de period-scope : "risques actuellement
// ouverts" est un instantané, pas une fenêtre temporelle.
function riskLevel(score) {
  if (score === null || score === undefined) return null;
  if (score >= 16) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

async function computeOpenRisksBySeverity(tenantId) {
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  const { data, error } = await supabase
    .from('risks')
    .select('risk_score, status')
    .eq('tenant_id', tenantId)
    .not('status', 'in', '(accepted,closed)');
  if (error || !data) return counts;

  for (const risk of data) {
    const level = riskLevel(risk.risk_score);
    if (level) counts[level] += 1;
  }
  return counts;
}


// --- Éléments d'entrée complémentaires (ISO 9001 §9.3.2 c, d, e) : satisfaction client, performance des
// fournisseurs, sorties non conformes, accidents, compétences, politique qualité. Chaque fonction est
// tolérante à une erreur de lecture (retourne des zéros) : une revue ne doit jamais échouer à la création
// parce qu'un module secondaire est momentanément illisible.

const round1 = (value) => Math.round(value * 10) / 10;

// Satisfaction client (§9.1.2) : enquêtes de la période, note moyenne sur 5 et part des notes ≥ 4.
async function computeSatisfactionPeriod(tenantId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('customer_satisfaction_surveys')
    .select('score')
    .eq('tenant_id', tenantId)
    .gte('survey_date', periodStart)
    .lte('survey_date', periodEnd);
  if (error || !data || data.length === 0) return { count: 0, average_score: null, satisfied_rate: null };
  const total = data.reduce((sum, row) => sum + row.score, 0);
  return {
    count: data.length,
    average_score: round1(total / data.length),
    satisfied_rate: Math.round((data.filter((row) => row.score >= 4).length / data.length) * 100),
  };
}

// Performance des prestataires externes (§8.4) : fournisseurs actifs, évaluations de la période (note
// moyenne, décisions « sous surveillance » / « à remplacer ») et évaluations en retard.
async function computeSuppliersPeriod(tenantId, periodStart, periodEnd) {
  const empty = { active: 0, evaluations: 0, average_score: null, under_watch: 0, to_replace: 0, overdue_evaluations: 0 };
  const [{ data: suppliers, error: suppliersError }, { data: evaluations, error: evaluationsError }] = await Promise.all([
    supabase.from('suppliers').select('id, next_evaluation_date').eq('tenant_id', tenantId).eq('status', 'active'),
    supabase
      .from('supplier_evaluations')
      .select('overall_score, decision')
      .eq('tenant_id', tenantId)
      .gte('evaluation_date', periodStart)
      .lte('evaluation_date', periodEnd),
  ]);
  if (suppliersError || evaluationsError) return empty;

  const today = isoDateInDays(0);
  const scores = (evaluations || []).map((row) => Number(row.overall_score));
  return {
    active: (suppliers || []).length,
    evaluations: (evaluations || []).length,
    average_score: scores.length > 0 ? round1(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
    under_watch: (evaluations || []).filter((row) => row.decision === 'under_watch').length,
    to_replace: (evaluations || []).filter((row) => row.decision === 'to_replace').length,
    overdue_evaluations: (suppliers || []).filter((supplier) => supplier.next_evaluation_date && supplier.next_evaluation_date < today).length,
  };
}

// Sorties non conformes (§8.7) détectées sur la période, dont celles encore ouvertes aujourd'hui.
async function computeNonconformingPeriod(tenantId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('nonconforming_outputs')
    .select('status, disposition')
    .eq('tenant_id', tenantId)
    .gte('detected_at', periodStart)
    .lte('detected_at', periodEnd);
  if (error || !data) return { detected: 0, still_open: 0, by_disposition: {} };
  const byDisposition = {};
  for (const row of data) byDisposition[row.disposition] = (byDisposition[row.disposition] || 0) + 1;
  return { detected: data.length, still_open: data.filter((row) => row.status !== 'closed').length, by_disposition: byDisposition };
}

// Accidents (santé-sécurité) survenus sur la période : gravité, avec arrêt de travail, jours perdus, ouverts.
async function computeAccidentsPeriod(tenantId, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('accidents')
    .select('severity, with_lost_time, lost_days, status')
    .eq('tenant_id', tenantId)
    .gte('occurred_at', periodStart)
    .lte('occurred_at', periodEnd);
  const empty = { count: 0, with_lost_time: 0, lost_days: 0, still_open: 0, by_severity: {} };
  if (error || !data) return empty;
  const bySeverity = {};
  for (const row of data) bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1;
  return {
    count: data.length,
    with_lost_time: data.filter((row) => row.with_lost_time).length,
    lost_days: data.reduce((sum, row) => sum + (row.lost_days || 0), 0),
    still_open: data.filter((row) => row.status !== 'closed').length,
    by_severity: bySeverity,
  };
}

// Compétences (§7.2) : part des formations à jour (dernière réalisation de chaque personne × formation,
// échéance non dépassée) et qualification des auditeurs internes. Instantané du jour, pas une fenêtre.
async function computeCompetences(tenantId) {
  const empty = { records_tracked: 0, up_to_date: 0, to_renew: 0, expired: 0, compliance_rate: null, auditors: { designated: false, qualified: 0, to_recycle: 0, not_qualified: 0 } };
  const { data, error } = await supabase.from('training_records').select('training_id, user_id, employee_id, completed_at, next_due_date').eq('tenant_id', tenantId);
  if (error || !data) return empty;

  const latestByPair = new Map();
  for (const record of data) {
    const key = `${record.training_id}:${record.user_id ? `u:${record.user_id}` : `e:${record.employee_id}`}`;
    const known = latestByPair.get(key);
    if (!known || record.completed_at > known.completed_at) latestByPair.set(key, record);
  }

  const today = isoDateInDays(0);
  const soon = isoDateInDays(RENEWAL_WINDOW_DAYS);
  let expired = 0;
  let toRenew = 0;
  for (const record of latestByPair.values()) {
    if (record.next_due_date && record.next_due_date < today) expired += 1;
    else if (record.next_due_date && record.next_due_date <= soon) toRenew += 1;
  }
  const total = latestByPair.size;

  let auditors = empty.auditors;
  try {
    const { trainings, byUser } = await fetchAuditorQualifications({ tenantId, userId: null, userRole: 'admin' });
    const statuses = Object.values(byUser).map((qualification) => qualification.status);
    auditors = {
      designated: trainings.length > 0,
      qualified: statuses.filter((status) => status === 'qualified').length,
      to_recycle: statuses.filter((status) => status === 'expired').length,
      not_qualified: statuses.filter((status) => status === 'failed').length,
    };
  } catch {
    // Compétence des auditeurs : complément, jamais bloquant.
  }

  return {
    records_tracked: total,
    up_to_date: total - expired - toRenew,
    to_renew: toRenew,
    expired,
    compliance_rate: total > 0 ? Math.round(((total - expired) / total) * 100) : null,
    auditors,
  };
}

// Politique qualité (§5.2) : date de la version en vigueur et part des utilisateurs actifs l'ayant lue.
async function computeQualityPolicy(tenantId) {
  const { data: version, error } = await supabase
    .from('quality_policy_versions')
    .select('id, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !version) return { defined: false, last_updated: null, acknowledged: 0, users: 0 };

  const [{ count: acknowledged }, { count: users }] = await Promise.all([
    supabase.from('quality_policy_acknowledgments').select('id', { count: 'exact', head: true }).eq('quality_policy_version_id', version.id),
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('is_active', true),
  ]);
  return { defined: true, last_updated: version.created_at.slice(0, 10), acknowledged: acknowledged || 0, users: users || 0 };
}

// period : { periodStart, periodEnd } optionnel — le calcul point-in-time existant (capas/
// audits/documents/trainings/kpis) tourne TOUJOURS et garde exactement la même forme qu'avant
// cette fonctionnalité (zéro régression sur le snapshot de clôture, voir managementReviews.js,
// qui continue d'appeler buildQmsSnapshot(tenantId) sans période). Les 5 groupes period-scoped
// ne sont ajoutés que si une période est fournie (panneau "données d'entrée", voir
// management_reviews.input_snapshot).
export async function buildQmsSnapshot(tenantId, period) {
  const [capas, audits, documentsToReview, trainingsToRenew, kpisOffTarget] = await Promise.all([
    countCapasByStatus(tenantId),
    countAuditsByStatus(tenantId),
    countDocumentsToReview(tenantId),
    countTrainingsToRenew(tenantId),
    countOffTargetKpis(tenantId),
  ]);

  const snapshot = {
    generated_at: new Date().toISOString(),
    capas,
    audits,
    documents: { to_review: documentsToReview },
    trainings: { to_renew: trainingsToRenew },
    kpis: { off_target: kpisOffTarget },
  };

  if (period?.periodStart && period?.periodEnd) {
    const { periodStart, periodEnd } = period;
    const [kpiTrend, auditsPeriod, complaintsPeriod, capasPeriod, risksOpen, satisfaction, suppliers, nonconforming, accidents, competences, qualityPolicy] = await Promise.all([
      computeKpiTrend(tenantId, periodStart, periodEnd),
      computeAuditsPeriod(tenantId, periodStart, periodEnd),
      computeComplaintsPeriod(tenantId, periodStart, periodEnd),
      computeCapasPeriod(tenantId, periodStart, periodEnd),
      computeOpenRisksBySeverity(tenantId),
      computeSatisfactionPeriod(tenantId, periodStart, periodEnd),
      computeSuppliersPeriod(tenantId, periodStart, periodEnd),
      computeNonconformingPeriod(tenantId, periodStart, periodEnd),
      computeAccidentsPeriod(tenantId, periodStart, periodEnd),
      computeCompetences(tenantId),
      computeQualityPolicy(tenantId),
    ]);
    snapshot.period = { start: periodStart, end: periodEnd };
    snapshot.kpi_trend = kpiTrend;
    snapshot.audits_period = auditsPeriod;
    snapshot.complaints_period = complaintsPeriod;
    snapshot.capas_period = capasPeriod;
    snapshot.risks_open = risksOpen;
    // Éléments d'entrée complémentaires : absents des revues créées avant cette version (l'affichage et les exports
    // les traitent comme optionnels).
    snapshot.satisfaction_period = satisfaction;
    snapshot.suppliers_period = suppliers;
    snapshot.nonconforming_period = nonconforming;
    snapshot.accidents_period = accidents;
    snapshot.competences = competences;
    snapshot.quality_policy = qualityPolicy;
  }

  return snapshot;
}
