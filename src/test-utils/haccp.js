import { admin } from './tenant.js';

export async function seedHaccpHazards(tenantId, ids) {
  const { data: plan, error: planError } = await admin.from('haccp_plans')
    .insert({ tenant_id: tenantId, title: 'Plan IA de test' }).select('id').single();
  if (planError) throw planError;
  const { data: step, error: stepError } = await admin.from('haccp_process_steps')
    .insert({ tenant_id: tenantId, plan_id: plan.id, step_number: 1, name: 'Stockage' }).select('id').single();
  if (stepError) throw stepError;
  const { error } = await admin.from('haccp_hazards').insert(ids.map((id) => ({
    id, tenant_id: tenantId, step_id: step.id, hazard_type: 'biological',
    description: 'Danger microbiologique', likelihood: 2, severity: 3,
  })));
  if (error) throw error;
  return { plan, step };
}
