import { formatDateTimeInZone } from './trainingQuiz.js';

// Libellés du registre des risques pour les exports (miroir de frontend/src/lib/riskStatus.js).
export const RISK_TYPE_LABELS = { risk: 'Risque', opportunity: 'Opportunité' };
export const RISK_STATUS_LABELS = { identified: 'Identifié', treating: 'En traitement', treated: 'Traité', accepted: 'Accepté', closed: 'Clôturé' };
export const LIKELIHOOD_LABELS = { 1: 'Rare', 2: 'Peu probable', 3: 'Possible', 4: 'Probable', 5: 'Quasi certain' };
export const IMPACT_LABELS = { 1: 'Négligeable', 2: 'Mineur', 3: 'Modéré', 4: 'Majeur', 5: 'Critique' };
export const CAPA_STATUS_LABELS = { open: 'Ouverte', in_progress: 'En cours', pending_verification: 'En vérification', closed: 'Clôturée', overdue: 'En retard' };
export const RISK_LEVEL_LABELS = { low: 'Faible', medium: 'Modéré', high: 'Élevé', critical: 'Critique' };

export function riskLevel(score) {
  if (score === null || score === undefined) return null;
  if (score >= 16) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

// « 4 × 3 = 12 (Élevé) » — ou « Non évaluée » tant que la cotation n'existe pas.
export function describeScore(likelihood, impact) {
  if (!likelihood || !impact) return 'Non évaluée';
  const score = likelihood * impact;
  return `${likelihood} × ${impact} = ${score} (${RISK_LEVEL_LABELS[riskLevel(score)]})`;
}

export function formatRiskDate(value, timeZone) {
  if (!value) return '—';
  return formatDateTimeInZone(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, timeZone, { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatRiskDateTime(value, timeZone) {
  return value ? formatDateTimeInZone(value, timeZone, { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

// Phrase de conclusion sur l'acceptabilité du risque, d'après le seuil de l'entreprise.
export function acceptabilityText(risk, threshold) {
  if (risk.type !== 'risk') return 'Opportunité : pas de seuil d’acceptabilité.';
  const scope = risk.residual_score !== null && risk.residual_score !== undefined ? 'résiduel' : 'brut';
  if (risk.is_unacceptable) {
    return `Inacceptable : le score ${scope} (${risk.current_score}) atteint le seuil de ${threshold}.${risk.needs_capa ? ' Aucune CAPA liée : à traiter.' : ' Une CAPA est liée.'}`;
  }
  return `Acceptable : le score ${scope} (${risk.current_score}) est sous le seuil de ${threshold}.`;
}
