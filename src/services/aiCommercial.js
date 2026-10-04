import { AI_MODULES, effectiveAiModules } from './aiModules.js';
import { supabase } from './supabase.js';

export const AI_PLAN_KEYS = ['essential', 'pro', 'premium'];
export function tenantWithUnifiedPlan(tenant) {
  return { ...tenant, legacy_plan: tenant.plan, plan: tenant.ai_plan_key || 'manual' };
}
export const validAiLimit = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 1000000);
export const validAiModules = (value) => value && !Array.isArray(value) &&
  Object.keys(value).length === AI_MODULES.length && AI_MODULES.every((key) => typeof value[key] === 'boolean');

export function aiUsageMonth(value) {
  if (value === undefined) return new Date().toISOString().slice(0, 7);
  return typeof value === 'string' && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

export async function getAiCommercialSettings(tenantId) {
  const { data, error } = await supabase.from('tenants')
    .select('ai_plan_key, ai_monthly_limit, ai_default_user_limit, ai_modules').eq('id', tenantId).maybeSingle();
  if (error) throw new Error(`Lecture des réglages commerciaux IA impossible : ${error.message}`);
  return data ? { ...data, ai_modules: effectiveAiModules(data.ai_modules) } : null;
}

const METRICS = ['succeeded', 'failed', 'pending', 'expired', 'calls', 'actual_tokens', 'estimated_tokens', 'pending_tokens'];
function sumRows(rows) {
  return Object.fromEntries(METRICS.map((key) => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
}
export function summarizeAiUsage(data) {
  const modules = [...new Set(data.rows.map((row) => row.module))].map((module) => ({
    module, ...sumRows(data.rows.filter((row) => row.module === module)),
  }));
  const users = [...new Set(data.rows.map((row) => row.user_id))].map((id) => {
    const rows = data.rows.filter((row) => row.user_id === id);
    return { id, full_name: rows[0].full_name, ...sumRows(rows) };
  });
  return { ...data, totals: sumRows(data.rows), modules, users };
}
export async function getAiUsage(tenantId, month) {
  const { data, error } = await supabase.rpc('ai_usage_breakdown', { p_tenant_id: tenantId, p_month: `${month}-01` });
  if (error) throw new Error(`Lecture de la consommation IA impossible : ${error.message}`);
  return summarizeAiUsage(data);
}
