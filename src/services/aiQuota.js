import { supabase } from './supabase.js';
import { aiModuleForRequest } from './aiModules.js';

export function isAiActionRequest(req) {
  return aiModuleForRequest(req) !== null;
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
  const module = aiModuleForRequest(req);
  const { data: tenant, error: moduleError } = await supabase.from('tenants').select('ai_modules').eq('id', req.tenantId).maybeSingle();
  if (moduleError || !tenant) {
    console.error('[modules IA] lecture impossible :', moduleError?.message || 'Entreprise absente');
    res.status(503).json({ error: "Impossible de vérifier l'accès IA de votre entreprise." });
    return false;
  }
  if (tenant.ai_modules[module] === false) {
    res.status(403).json({ code: 'AI_MODULE_DISABLED', module, error: "L'assistance IA de ce module est désactivée pour votre entreprise. Contactez votre administrateur." });
    return false;
  }
  const { data, error } = await supabase.rpc('reserve_ai_module_action', {
    p_tenant_id: req.tenantId, p_user_id: req.user.id, p_module: module,
  });
  if (error) {
    console.error('[quota IA] réservation impossible :', error.message);
    res.status(503).json({ code: 'AI_QUOTA_UNAVAILABLE', error: 'Le contrôle du quota IA est indisponible. Veuillez réessayer.' });
    return false;
  }
  if (!data.allowed) {
    if (data.scope === 'module') {
      res.status(403).json({ code: 'AI_MODULE_DISABLED', module, error: "L'assistance IA de ce module n'est pas incluse dans les accès de votre entreprise. Contactez votre administrateur." });
      return false;
    }
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
