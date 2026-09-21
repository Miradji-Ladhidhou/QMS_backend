import { supabase } from './supabase.js';
import { loadPlanSteps } from './haccpPlan.js';

const HAZARD_TYPE_LABELS = { biological: 'biologique', chemical: 'chimique', physical: 'physique', allergen: 'allergène' };
const PLAN_STATUS_LABELS = { draft: 'Brouillon', active: 'Actif', under_review: 'En revue', archived: 'Archivé' };

const PLAN_FIELDS = { title: 'Titre', product_description: 'Produit', scope: 'Périmètre', team: 'Équipe HACCP', status: 'Statut' };
const HAZARD_FIELDS = {
  hazard_type: 'type',
  description: 'description',
  existing_controls: 'mesures de maîtrise',
  likelihood: 'probabilité',
  severity: 'gravité',
  is_significant: 'caractère significatif',
  justification: 'justification',
};
const CCP_FIELDS = {
  ccp_number: 'numéro',
  critical_limits: 'limites critiques',
  limit_min: 'limite min',
  limit_max: 'limite max',
  limit_unit: 'unité',
  monitoring_procedure: 'procédure de surveillance',
  monitoring_frequency: 'fréquence',
  monitoring_interval_hours: 'intervalle de rappel',
  monitoring_responsible: 'responsable',
  corrective_action_procedure: 'actions correctives',
  verification_procedure: 'vérification',
  verification_frequency: 'fréquence de vérification',
  record_keeping_procedure: 'enregistrements',
};
const STEP_FIELDS = { step_number: 'numéro', name: 'nom', description: 'description' };

const norm = (value) => (value === undefined || value === '' ? null : value);
const pick = (source, fields) => Object.fromEntries(Object.keys(fields).map((key) => [key, norm(source?.[key])]));

// Instantané d'un plan : ses champs, ses étapes, leurs dangers et le CCP de chaque danger. Uniquement des
// données de conception (jamais les relevés de surveillance, qui ont leur propre historique).
export async function buildPlanSnapshot(tenantId, plan) {
  const steps = await loadPlanSteps(tenantId, plan);
  return {
    plan: pick(plan, PLAN_FIELDS),
    steps: steps.map((step) => ({
      id: step.id,
      ...pick(step, STEP_FIELDS),
      hazards: step.hazards.map((hazard) => ({
        id: hazard.id,
        ...pick(hazard, HAZARD_FIELDS),
        ccp: hazard.ccp ? { id: hazard.ccp.id, ...pick(hazard.ccp, CCP_FIELDS) } : null,
      })),
    })),
  };
}

function fieldChanges(before, after, fields) {
  return Object.entries(fields)
    .filter(([key]) => String(norm(before[key]) ?? '') !== String(norm(after[key]) ?? ''))
    .map(([, label]) => label);
}

const stepLabel = (step) => `étape ${step.step_number} — ${step.name}`;
const hazardLabel = (hazard, step) => `« ${hazard.description} » (${stepLabel(step)}, danger ${HAZARD_TYPE_LABELS[hazard.hazard_type] || hazard.hazard_type})`;
const ccpLabel = (ccp, hazard) => `CCP ${ccp.ccp_number || ''} de « ${hazard.description} »`.replace('CCP  de', 'CCP de');

// Liste lisible des différences entre deux instantanés (`before` peut être null : première version).
export function diffSnapshots(before, after) {
  if (!before) return ['Première version du plan.'];
  const changes = [];

  for (const [key, label] of Object.entries(PLAN_FIELDS)) {
    if (String(norm(before.plan[key]) ?? '') === String(norm(after.plan[key]) ?? '')) continue;
    changes.push(key === 'status' ? `Statut : ${PLAN_STATUS_LABELS[before.plan.status] || before.plan.status} → ${PLAN_STATUS_LABELS[after.plan.status] || after.plan.status}` : `${label} modifié(e)`);
  }

  const beforeSteps = new Map(before.steps.map((step) => [step.id, step]));
  const afterSteps = new Map(after.steps.map((step) => [step.id, step]));
  for (const step of after.steps) if (!beforeSteps.has(step.id)) changes.push(`Étape ajoutée : ${stepLabel(step)}`);
  for (const step of before.steps) if (!afterSteps.has(step.id)) changes.push(`Étape supprimée : ${stepLabel(step)}`);
  for (const step of after.steps) {
    const previous = beforeSteps.get(step.id);
    if (!previous) continue;
    const fields = fieldChanges(previous, step, STEP_FIELDS);
    if (fields.length > 0) changes.push(`Étape modifiée : ${stepLabel(step)} (${fields.join(', ')})`);
  }

  const collect = (snapshot) => new Map(snapshot.steps.flatMap((step) => step.hazards.map((hazard) => [hazard.id, { hazard, step }])));
  const beforeHazards = collect(before);
  const afterHazards = collect(after);
  for (const [id, { hazard, step }] of afterHazards) if (!beforeHazards.has(id)) changes.push(`Danger ajouté : ${hazardLabel(hazard, step)}`);
  for (const [id, { hazard, step }] of beforeHazards) if (!afterHazards.has(id)) changes.push(`Danger supprimé : ${hazardLabel(hazard, step)}`);
  for (const [id, { hazard, step }] of afterHazards) {
    const previous = beforeHazards.get(id)?.hazard;
    if (!previous) continue;
    const fields = fieldChanges(previous, hazard, HAZARD_FIELDS);
    if (fields.length > 0) changes.push(`Danger modifié : ${hazardLabel(hazard, step)} (${fields.join(', ')})`);
    if (!previous.ccp && hazard.ccp) changes.push(`${ccpLabel(hazard.ccp, hazard)} ajouté`);
    else if (previous.ccp && !hazard.ccp) changes.push(`${ccpLabel(previous.ccp, hazard)} supprimé`);
    else if (previous.ccp && hazard.ccp) {
      const ccpFields = fieldChanges(previous.ccp, hazard.ccp, CCP_FIELDS);
      if (ccpFields.length > 0) changes.push(`${ccpLabel(hazard.ccp, hazard)} modifié (${ccpFields.join(', ')})`);
    }
  }

  return changes.length > 0 ? changes : ['Aucune modification de conception.'];
}

export async function fetchRevisions(tenantId, planId) {
  const { data, error } = await supabase
    .from('haccp_plan_revisions')
    .select('id, revision_number, kind, reason, snapshot, created_at, created_by_user:users!haccp_plan_revisions_created_by_fkey(id, full_name)')
    .eq('tenant_id', tenantId)
    .eq('plan_id', planId)
    .order('revision_number', { ascending: true });
  if (error) throw new Error('Impossible de récupérer les versions du plan.');
  return data;
}

// Versions d'un plan (les plus récentes d'abord) avec la liste de leurs changements par rapport à la version
// précédente, et les modifications faites depuis la dernière version (`pending_changes`, vide = plan à jour).
export async function describeRevisions(tenantId, plan) {
  const revisions = await fetchRevisions(tenantId, plan.id);
  const items = revisions
    .map((revision, index) => ({
      id: revision.id,
      revision_number: revision.revision_number,
      kind: revision.kind,
      reason: revision.reason,
      created_at: revision.created_at,
      created_by_user: revision.created_by_user,
      changes: diffSnapshots(index === 0 ? null : revisions[index - 1].snapshot, revision.snapshot),
    }))
    .reverse();

  const last = revisions[revisions.length - 1];
  let pendingChanges = [];
  if (last) {
    const current = await buildPlanSnapshot(tenantId, plan);
    pendingChanges = diffSnapshots(last.snapshot, current);
    if (pendingChanges.length === 1 && pendingChanges[0] === 'Aucune modification de conception.') pendingChanges = [];
  }
  return { revisions: items, pending_changes: pendingChanges };
}

// Enregistre une nouvelle version (numérotation continue par plan). La contrainte unique (plan_id,
// revision_number) protège de deux enregistrements simultanés : le second réessaie avec le numéro suivant.
export async function createRevision({ tenantId, plan, kind, reason, userId }) {
  const snapshot = await buildPlanSnapshot(tenantId, plan);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: last } = await supabase
      .from('haccp_plan_revisions')
      .select('revision_number')
      .eq('tenant_id', tenantId)
      .eq('plan_id', plan.id)
      .order('revision_number', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data, error } = await supabase
      .from('haccp_plan_revisions')
      .insert({ tenant_id: tenantId, plan_id: plan.id, revision_number: (last?.revision_number || 0) + 1, kind, reason: reason || null, snapshot, created_by: userId || null })
      .select('id, revision_number, kind, reason, created_at')
      .single();
    if (!error) return data;
    if (error.code !== '23505') throw new Error(error.message);
  }
  throw new Error("Impossible d'enregistrer la version du plan.");
}
