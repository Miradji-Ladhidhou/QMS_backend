import { supabase } from './supabase.js';

const AI_ACTION_PATHS = [
  /^\/api\/ai\/(?:capa-suggestion|risk-treatment-suggestion|haccp-surveillance-suggestion|haccp-significance-suggestion|haccp-ccp-suggestion)$/,
  /^\/api\/(?:qqoqccp|pdca)\/[^/]+\/generate$/,
  /^\/api\/risks\/service-suggestion$/,
  /^\/api\/haccp\/steps\/[^/]+\/hazard-suggestion$/,
  /^\/api\/audits\/[^/]+\/checklist\/generate$/,
  /^\/api\/management-reviews\/[^/]+\/ai-draft$/,
  /^\/api\/procedures\/(?:generate-draft|generate-full-draft|generate-draft-from-qqoqccp)$/,
  /^\/api\/kpi-imports\/[^/]+\/ai-suggestion$/,
  /^\/api\/procedures\/[^/]+\/suggest-revision-from-capa$/,
  /^\/api\/procedures\/[^/]+\/versions\/[^/]+\/(?:check-compliance|compliance-fix|compare|distribution-sheet)$/,
];

export function isAiActionRequest(req) {
  const path = `${req.baseUrl}${req.path}`.replace(/\/$/, '');
  return req.method === 'POST' && AI_ACTION_PATHS.some((pattern) => pattern.test(path));
}

export async function getAiQuota(tenantId, userId = null) {
  const { data, error } = await supabase.rpc('ai_quota_snapshot', { p_tenant_id: tenantId, p_user_id: userId });
  if (error) throw new Error(`Lecture du quota IA impossible : ${error.message}`);
  return data;
}

export async function settleAiAction(actionId, success) {
  const { error } = await supabase.rpc('settle_ai_action', { p_action_id: actionId, p_success: success });
  if (error) throw new Error(`Finalisation du quota IA impossible : ${error.message}`);
}

export async function attachAiQuota(req, res) {
  if (!isAiActionRequest(req) || req.aiQuotaActionId) return true;
  const { data, error } = await supabase.rpc('reserve_ai_action', { p_tenant_id: req.tenantId, p_user_id: req.user.id });
  if (error) {
    console.error('[quota IA] réservation impossible :', error.message);
    res.status(503).json({ code: 'AI_QUOTA_UNAVAILABLE', error: 'Le contrôle du quota IA est indisponible. Veuillez réessayer.' });
    return false;
  }
  if (!data.allowed) {
    res.status(429).json({
      code: 'AI_QUOTA_EXCEEDED', scope: data.scope, quota: data.quota,
      error: data.scope === 'tenant' ? "Le quota IA mensuel de votre entreprise est atteint." : 'Votre quota IA mensuel est atteint.',
    });
    return false;
  }
  req.aiQuotaActionId = data.action_id;
  const json = res.json.bind(res);
  let settlement;
  const settle = (success) => {
    settlement ||= settleAiAction(data.action_id, success);
    return settlement;
  };
  res.json = (body) => {
    if (req.aiQuotaDeferred && res.statusCode === 202) return json(body);
    settle(res.statusCode < 400).then(() => json(body)).catch((err) => {
      console.error('[quota IA]', err.message);
      if (!res.headersSent) {
        res.status(500);
        json({ error: "Impossible de finaliser le quota de cette action IA." });
      }
    });
    return res;
  };
  res.on('close', () => {
    if (!req.aiQuotaDeferred && !settlement) {
      settle(false).catch((err) => console.error('[quota IA]', err.message));
    }
  });
  return true;
}
