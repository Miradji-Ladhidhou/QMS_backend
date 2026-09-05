import { supabase } from './supabase.js';

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

// Même fenêtre que routes/dashboard.js#KPI_RECENT_WINDOW, Kpis.jsx et kpiReportPdf.js : le
// statut hors objectif reflète les relevés RÉCENTS, jamais toute la vie du KPI — sinon
// l'instantané d'une revue de direction pourrait contredire ce que montre l'app elle-même.
const KPI_RECENT_WINDOW = 6;

// Miroir de getKpiStatus (frontend/src/lib/kpiStatus.js), déjà dupliqué dans
// kpiReportPdf.js et dashboard.js pour la même raison.
async function countOffTargetKpis(tenantId) {
  const { data, error } = await supabase
    .from('kpis')
    .select('id, target, target_direction, records:kpi_records(period_date, value)')
    .eq('tenant_id', tenantId);
  if (error || !data) return 0;

  let count = 0;
  for (const kpi of data) {
    if (kpi.target === null || kpi.target === undefined || kpi.records.length === 0) continue;
    const recentValues = [...kpi.records]
      .sort((a, b) => (a.period_date < b.period_date ? -1 : 1))
      .slice(-KPI_RECENT_WINDOW)
      .map((r) => r.value);
    const average = recentValues.reduce((sum, value) => sum + value, 0) / recentValues.length;
    const meetsTarget = kpi.target_direction === 'max' ? average <= kpi.target : average >= kpi.target;
    if (!meetsTarget) count += 1;
  }
  return count;
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
    .select('id, name, unit, target, target_direction, records:kpi_records(period_date, value)')
    .eq('tenant_id', tenantId);
  if (error || !data) return [];

  const periodLengthDays = daysBetween(periodStart, periodEnd) + 1;
  const previousEnd = addDaysToDate(periodStart, -1);
  const previousStart = addDaysToDate(periodStart, -periodLengthDays);

  return data.map((kpi) => {
    const currentAvg = averageOf(
      kpi.records.filter((r) => r.period_date >= periodStart && r.period_date <= periodEnd).map((r) => r.value)
    );
    const previousAvg = averageOf(
      kpi.records.filter((r) => r.period_date >= previousStart && r.period_date <= previousEnd).map((r) => r.value)
    );
    let trend = null;
    if (currentAvg !== null && previousAvg !== null) {
      trend = currentAvg > previousAvg ? 'up' : currentAvg < previousAvg ? 'down' : 'stable';
    }
    return {
      id: kpi.id,
      name: kpi.name,
      unit: kpi.unit,
      target: kpi.target,
      target_direction: kpi.target_direction,
      current_avg: currentAvg,
      previous_avg: previousAvg,
      trend,
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
    const [kpiTrend, auditsPeriod, complaintsPeriod, capasPeriod, risksOpen] = await Promise.all([
      computeKpiTrend(tenantId, periodStart, periodEnd),
      computeAuditsPeriod(tenantId, periodStart, periodEnd),
      computeComplaintsPeriod(tenantId, periodStart, periodEnd),
      computeCapasPeriod(tenantId, periodStart, periodEnd),
      computeOpenRisksBySeverity(tenantId),
    ]);
    snapshot.period = { start: periodStart, end: periodEnd };
    snapshot.kpi_trend = kpiTrend;
    snapshot.audits_period = auditsPeriod;
    snapshot.complaints_period = complaintsPeriod;
    snapshot.capas_period = capasPeriod;
    snapshot.risks_open = risksOpen;
  }

  return snapshot;
}
