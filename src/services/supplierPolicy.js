// Règles de l'évaluation des fournisseurs : rythme d'évaluation selon la criticité, seuils de décision, pondération
// des critères, état d'une évaluation / d'un certificat. Les réglages sont ceux de l'entreprise
// (tenants.supplier_settings) fusionnés avec les valeurs par défaut ci-dessous.

export const CRITICALITIES = ['low', 'medium', 'high', 'critical'];
export const CRITERIA = ['quality', 'delivery', 'price', 'responsiveness'];
export const DECISIONS = ['maintained', 'under_watch', 'to_replace'];
export const DECISION_SEVERITY = { maintained: 0, under_watch: 1, to_replace: 2 };

// Poids égaux par défaut : la note pondérée reprend la moyenne simple tant que l'admin ne règle rien.
const EQUAL_WEIGHTS = { quality: 1, delivery: 1, price: 1, responsiveness: 1 };

export const DEFAULT_SUPPLIER_SETTINGS = {
  // Mois entre deux évaluations selon la criticité du fournisseur.
  frequency_months: { low: 24, medium: 12, high: 9, critical: 6 },
  // Note pondérée (1 à 5) sous laquelle la décision proposée est « sous surveillance » / « à remplacer ».
  thresholds: { watch: 3, replace: 2 },
  weights: Object.fromEntries(CRITICALITIES.map((criticality) => [criticality, { ...EQUAL_WEIGHTS }])),
  // Un fournisseur « à remplacer » passe automatiquement « suspendu ».
  auto_suspend_on_replace: true,
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Réglages effectifs : les valeurs enregistrées par-dessus les défauts (une clé absente ou invalide retombe sur le défaut).
export function mergeSettings(raw) {
  const stored = isPlainObject(raw) ? raw : {};
  const defaults = DEFAULT_SUPPLIER_SETTINGS;
  return {
    frequency_months: Object.fromEntries(
      CRITICALITIES.map((criticality) => {
        const value = Number(stored.frequency_months?.[criticality]);
        return [criticality, Number.isInteger(value) && value >= 1 ? value : defaults.frequency_months[criticality]];
      })
    ),
    thresholds: {
      watch: Number.isFinite(Number(stored.thresholds?.watch)) && stored.thresholds?.watch !== undefined ? Number(stored.thresholds.watch) : defaults.thresholds.watch,
      replace: Number.isFinite(Number(stored.thresholds?.replace)) && stored.thresholds?.replace !== undefined ? Number(stored.thresholds.replace) : defaults.thresholds.replace,
    },
    weights: Object.fromEntries(
      CRITICALITIES.map((criticality) => {
        const weights = Object.fromEntries(
          CRITERIA.map((criterion) => {
            const value = Number(stored.weights?.[criticality]?.[criterion]);
            return [criterion, Number.isFinite(value) && value >= 0 && stored.weights?.[criticality]?.[criterion] !== undefined ? value : defaults.weights[criticality][criterion]];
          })
        );
        return [criticality, CRITERIA.some((criterion) => weights[criterion] > 0) ? weights : { ...defaults.weights[criticality] }];
      })
    ),
    auto_suspend_on_replace: typeof stored.auto_suspend_on_replace === 'boolean' ? stored.auto_suspend_on_replace : defaults.auto_suspend_on_replace,
  };
}

// Contrôle strict d'un réglage envoyé par l'admin : renvoie { error } ou { settings } (déjà complet).
export function validateSettingsInput(input) {
  if (!isPlainObject(input)) return { error: 'Réglages invalides.' };

  for (const criticality of CRITICALITIES) {
    const value = input.frequency_months?.[criticality];
    if (!Number.isInteger(value) || value < 1 || value > 120) {
      return { error: 'La fréquence d’évaluation doit être un nombre entier de mois entre 1 et 120, pour chaque criticité.' };
    }
  }

  const { watch, replace } = input.thresholds || {};
  if (![watch, replace].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5)) {
    return { error: 'Les seuils doivent être des notes entre 1 et 5.' };
  }
  if (replace >= watch) return { error: 'Le seuil « à remplacer » doit être inférieur au seuil « sous surveillance ».' };

  for (const criticality of CRITICALITIES) {
    const weights = input.weights?.[criticality];
    for (const criterion of CRITERIA) {
      const value = weights?.[criterion];
      if (!Number.isInteger(value) || value < 0 || value > 10) return { error: 'Chaque poids doit être un entier entre 0 et 10.' };
    }
    if (CRITERIA.every((criterion) => weights[criterion] === 0)) return { error: 'Au moins un critère doit avoir un poids supérieur à 0 pour chaque criticité.' };
  }

  if (typeof input.auto_suspend_on_replace !== 'boolean') return { error: 'Valeur invalide pour la suspension automatique.' };
  return { settings: mergeSettings(input) };
}

const round2 = (value) => Math.round(value * 100) / 100;

// Note globale pondérée (1 à 5, deux décimales) : chaque critère compte selon son poids.
export function weightedScore(scores, weights) {
  const total = CRITERIA.reduce((sum, criterion) => sum + weights[criterion], 0);
  return round2(CRITERIA.reduce((sum, criterion) => sum + scores[criterion] * weights[criterion], 0) / total);
}

// Décision proposée d'après la note : strictement sous le seuil « à remplacer », puis strictement sous « sous
// surveillance » ; à partir du seuil, le fournisseur est maintenu.
export function suggestDecision(score, thresholds) {
  if (score < thresholds.replace) return 'to_replace';
  if (score < thresholds.watch) return 'under_watch';
  return 'maintained';
}

// Une décision plus indulgente que celle proposée doit être justifiée (garder « maintenu » un fournisseur noté 1,8/5).
export function isMoreLenient(decision, suggested) {
  return DECISION_SEVERITY[decision] < DECISION_SEVERITY[suggested];
}

// Date yyyy-mm-dd, `months` mois plus tard (le jour est ramené au dernier jour du mois cible : 31 janvier + 1 mois = 28 février).
export function addMonths(dateStr, months) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function nextEvaluationDate(evaluationDate, criticality, settings) {
  return addMonths(evaluationDate, settings.frequency_months[criticality] ?? settings.frequency_months.medium);
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function daysUntil(dateStr, today = todayIso()) {
  return Math.round((new Date(`${dateStr}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
}

export const EVALUATION_DUE_SOON_DAYS = 30;
export const CERTIFICATE_EXPIRING_DAYS = 30;

// État de l'évaluation d'un fournisseur : 'never' (aucune, aucune date), 'overdue' (date dépassée), 'due_soon'
// (dans les 30 jours), 'ok'.
export function evaluationState({ next_evaluation_date: nextDate, evaluationCount }, today = todayIso()) {
  if (!nextDate) return evaluationCount === 0 ? 'never' : 'ok';
  const days = daysUntil(nextDate, today);
  if (days < 0) return 'overdue';
  return days <= EVALUATION_DUE_SOON_DAYS ? 'due_soon' : 'ok';
}

// État d'un certificat : 'no_expiry' (sans échéance), 'expired', 'expiring' (dans les 30 jours), 'valid'.
export function documentState(expiresOn, today = todayIso()) {
  if (!expiresOn) return 'no_expiry';
  const days = daysUntil(expiresOn, today);
  if (days < 0) return 'expired';
  return days <= CERTIFICATE_EXPIRING_DAYS ? 'expiring' : 'valid';
}

// Jalons de rappel : 30 jours avant, 7 jours avant, le jour même, puis chaque semaine de retard.
export function isSupplierReminderMilestone(daysRemaining) {
  if (daysRemaining === 30 || daysRemaining === 7 || daysRemaining === 0) return true;
  return daysRemaining < 0 && (-daysRemaining) % 7 === 0;
}

export async function loadSupplierSettings(supabase, tenantId) {
  const { data } = await supabase.from('tenants').select('supplier_settings').eq('id', tenantId).maybeSingle();
  return mergeSettings(data?.supplier_settings);
}
