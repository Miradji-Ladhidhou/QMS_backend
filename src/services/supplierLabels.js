import { formatRiskDate } from './riskLabels.js';

// Libellés de l'évaluation des fournisseurs pour les exports (miroir de frontend/src/lib/supplierPolicy.js).
export const CRITICALITY_LABELS = { low: 'Faible', medium: 'Moyenne', high: 'Élevée', critical: 'Critique' };
export const SUPPLIER_STATUS_LABELS = { active: 'Actif', inactive: 'Inactif', suspended: 'Suspendu' };
export const DECISION_LABELS = { maintained: 'Maintenu', under_watch: 'Sous surveillance', to_replace: 'À remplacer' };
export const CRITERIA_LABELS = { quality: 'Qualité', delivery: 'Délais', price: 'Prix', responsiveness: 'Réactivité' };
export const DOCUMENT_KIND_LABELS = {
  quality_certificate: 'Certificat qualité',
  food_safety_certificate: 'Certificat sécurité des aliments',
  sanitary_approval: 'Agrément sanitaire',
  insurance: 'Assurance',
  contract: 'Contrat',
  other: 'Autre',
};
export const DOCUMENT_STATE_LABELS = { valid: 'Valide', expiring: 'Expire bientôt', expired: 'Expiré', no_expiry: 'Sans échéance' };
export const EVALUATION_STATE_LABELS = { never: 'Jamais évalué', overdue: 'Évaluation en retard', due_soon: 'Évaluation à prévoir', ok: 'À jour' };

export { formatRiskDate as formatDate };

// « Poids : qualité ×3, délais ×2, prix ×1, réactivité ×1 » — les poids en vigueur d'une évaluation ou de la criticité.
export function describeWeights(weights) {
  if (!weights) return 'Poids égaux';
  return Object.entries(CRITERIA_LABELS)
    .map(([key, label]) => `${label.toLowerCase()} ×${weights[key]}`)
    .join(', ');
}
