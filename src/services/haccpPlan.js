import { supabase } from './supabase.js';

// Assemble un plan avec ses étapes, chacune avec ses dangers, chacun avec son CCP (le cas
// échéant) — 3 requêtes plutôt qu'un N+1 (une par étape). Réutilisé par GET /plans/:id (JSON)
// et par les exports PDF (un seul plan ou plusieurs) : même forme de données dans les deux cas.
export async function loadPlanSteps(tenantId, plan) {
  const { data: steps, error: stepsError } = await supabase
    .from('haccp_process_steps')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('plan_id', plan.id)
    .order('step_number', { ascending: true });
  if (stepsError) throw new Error('Impossible de récupérer les étapes du procédé.');

  const stepIds = steps.map((step) => step.id);
  let hazards = [];
  if (stepIds.length > 0) {
    const { data, error } = await supabase
      .from('haccp_hazards')
      .select('*')
      .eq('tenant_id', tenantId)
      .in('step_id', stepIds)
      .order('created_at', { ascending: true });
    if (error) throw new Error("Impossible de récupérer l'analyse des dangers.");
    hazards = data;
  }

  const hazardIds = hazards.map((hazard) => hazard.id);
  let ccps = [];
  if (hazardIds.length > 0) {
    const { data, error } = await supabase
      .from('haccp_ccps')
      .select('*, monitoring_responsible_user:users!haccp_ccps_monitoring_responsible_fkey(id, full_name)')
      .eq('tenant_id', tenantId)
      .in('hazard_id', hazardIds);
    if (error) throw new Error('Impossible de récupérer les points critiques.');
    ccps = data;
  }

  const ccpByHazardId = new Map(ccps.map((ccp) => [ccp.hazard_id, ccp]));
  const hazardsByStepId = new Map();
  for (const hazard of hazards) {
    const list = hazardsByStepId.get(hazard.step_id) || [];
    list.push({ ...hazard, ccp: ccpByHazardId.get(hazard.id) || null });
    hazardsByStepId.set(hazard.step_id, list);
  }

  return steps.map((step) => ({ ...step, hazards: hazardsByStepId.get(step.id) || [] }));
}
