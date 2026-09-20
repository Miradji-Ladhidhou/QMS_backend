import { supabase } from './supabase.js';

// Seuil par défaut du risque résiduel inacceptable (« élevé » ou « critique » sur la matrice 5×5) :
// la valeur appliquée en dur avant que le seuil devienne un réglage de l'entreprise.
export const DEFAULT_UNACCEPTABLE_SCORE = 10;

// Statuts qui affirment qu'une décision a été prise sur le risque — un risque dans l'un d'eux n'est
// plus « à revoir » ni à traiter.
export const CLOSED_RISK_STATUSES = ['accepted', 'closed'];

export async function getUnacceptableScore(tenantId) {
  const { data } = await supabase.from('tenants').select('risk_unacceptable_score').eq('id', tenantId).maybeSingle();
  return data?.risk_unacceptable_score ?? DEFAULT_UNACCEPTABLE_SCORE;
}

// Score en vigueur : le résiduel dès qu'il est évalué (c'est lui qui dit où en est le risque après
// traitement), sinon le score brut.
export function currentScore(risk) {
  return risk.residual_score ?? risk.risk_score;
}

// Un risque (pas une opportunité) non clos dont le score en vigueur atteint le seuil est inacceptable ;
// `needs_capa` = il n'a encore aucune CAPA liée pour porter son traitement.
export function unacceptableFlags(risk, threshold) {
  const active = risk.type === 'risk' && !CLOSED_RISK_STATUSES.includes(risk.status);
  const unacceptable = active && currentScore(risk) >= threshold;
  return { current_score: currentScore(risk), is_unacceptable: unacceptable, needs_capa: unacceptable && !risk.linked_capa_id };
}

export function withUnacceptableFlags(risks, threshold) {
  return risks.map((risk) => ({ ...risk, ...unacceptableFlags(risk, threshold) }));
}

const TRACKED_FIELDS = ['likelihood', 'impact', 'residual_likelihood', 'residual_impact', 'status'];

// Vrai si la cotation, la cotation résiduelle ou le statut diffère entre l'état avant et après.
export function assessmentChanged(before, after) {
  return TRACKED_FIELDS.some((field) => (before?.[field] ?? null) !== (after?.[field] ?? null));
}

// Ajoute une ligne à l'historique de cotation avec l'état ACTUEL du risque (`risk` : ligne relue après
// mise à jour). Une erreur d'historique ne doit jamais faire échouer la modification du risque elle-même.
export async function recordAssessment({ tenantId, risk, userId, reason }) {
  const { error } = await supabase.from('risk_assessments').insert({
    tenant_id: tenantId,
    risk_id: risk.id,
    likelihood: risk.likelihood,
    impact: risk.impact,
    residual_likelihood: risk.residual_likelihood ?? null,
    residual_impact: risk.residual_impact ?? null,
    status: risk.status,
    reason: reason || null,
    assessed_by: userId || null,
  });
  if (error) console.error("[risks] Échec d'écriture de l'historique de cotation :", error.message);
}

export async function fetchAssessments(tenantId, riskId) {
  const { data, error } = await supabase
    .from('risk_assessments')
    .select('id, likelihood, impact, score, residual_likelihood, residual_impact, residual_score, status, reason, assessed_at, assessed_by_user:users!risk_assessments_assessed_by_fkey(id, full_name)')
    .eq('tenant_id', tenantId)
    .eq('risk_id', riskId)
    .order('assessed_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function daysUntil(dateStr, today = todayIso()) {
  return Math.round((new Date(`${dateStr}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
}

// État d'échéance de revue : 'overdue' (date dépassée), 'soon' (dans la fenêtre), 'unplanned' (aucune date).
export function reviewState(reviewDate, windowDays, today = todayIso()) {
  if (!reviewDate) return 'unplanned';
  const days = daysUntil(reviewDate, today);
  if (days < 0) return 'overdue';
  return days <= windowDays ? 'soon' : null;
}

// Jalons de rappel de revue : 7 jours avant, le jour même, puis chaque semaine de retard (+7, +14…).
// Un jalon = un jour précis, jamais répété le lendemain (même principe que les procédures à réviser).
export const RISK_REVIEW_REMINDER_LEAD_DAYS = 7;

export function isReminderMilestone(daysRemaining) {
  if (daysRemaining === RISK_REVIEW_REMINDER_LEAD_DAYS || daysRemaining === 0) return true;
  return daysRemaining < 0 && (-daysRemaining) % 7 === 0;
}
