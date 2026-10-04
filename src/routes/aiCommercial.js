import { Router } from 'express';
import { param, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { logSuperAdminAction } from '../services/superAdminAudit.js';
import { effectiveAiModules } from '../services/aiModules.js';
import { effectiveAppModules, validAppModules } from '../services/appModules.js';
import { AI_PLAN_KEYS, aiUsageMonth, getAiCommercialSettings, getAiUsage, validAiLimit, validAiModules } from '../services/aiCommercial.js';

export function aiCommercialHandler(handler) {
  return async (req, res) => {
    try {
      if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Entreprise invalide.' });
      await handler(req, res);
    } catch (err) {
      console.error('[gestion IA]', err.message);
      res.status(500).json({ error: 'Impossible de traiter les réglages ou la consommation IA. Veuillez réessayer.' });
    }
  };
}
export const aiUsageHandler = aiCommercialHandler(async (req, res) => {
  const month = aiUsageMonth(req.query.month);
  if (!month) return res.status(400).json({ error: 'Mois invalide : format AAAA-MM attendu.' });
  const tenantId = req.params.id || req.tenantId;
  if (!(await getAiCommercialSettings(tenantId))) return res.status(404).json({ error: 'Entreprise introuvable.' });
  res.json(await getAiUsage(tenantId, month));
});

const router = Router();
router.get('/plans', aiCommercialHandler(async (req, res) => {
  const { data, error } = await supabase.from('ai_plans').select('*').order('key');
  if (error) throw error;
  res.json(AI_PLAN_KEYS.map((key) => data.find((plan) => plan.key === key))
    .filter(Boolean).map((plan) => ({
      ...plan,
      modules: effectiveAiModules(plan.modules),
      app_modules: effectiveAppModules(plan.app_modules),
    })));
}));
router.patch('/plans/:key', aiCommercialHandler(async (req, res) => {
  const body = req.body || {};
  const { monthly_limit, default_user_limit, modules, app_modules: appModules } = body;
  if (!AI_PLAN_KEYS.includes(req.params.key) || !validAiLimit(monthly_limit) || !validAiLimit(default_user_limit) ||
    !validAiModules(modules) || (appModules !== undefined && !validAppModules(appModules)) ||
    Object.keys(body).some((key) => !['monthly_limit', 'default_user_limit', 'modules', 'app_modules'].includes(key))) {
    return res.status(400).json({ error: 'Forfait invalide : plafonds entiers, et configurations de modules valides requises.' });
  }
  const update = {
    monthly_limit, default_user_limit, modules, configured: true, updated_at: new Date().toISOString(),
  };
  if (appModules !== undefined) update.app_modules = appModules;
  const { data, error } = await supabase.from('ai_plans').update(update)
    .eq('key', req.params.key).select('*').single();
  if (error) throw error;
  await logSuperAdminAction({ actorId: req.user.id, action: 'ai_plan_updated', targetType: 'platform', details: data });
  res.json({ ...data, modules: effectiveAiModules(data.modules), app_modules: effectiveAppModules(data.app_modules) });
}));
router.get('/alerts', aiCommercialHandler(async (req, res) => {
  const { data, error } = await supabase.rpc('ai_tenant_quota_alerts');
  if (error) throw error;
  res.json(data);
}));
router.get('/tenants/:id/usage', param('id').isUUID(), aiUsageHandler);
router.get('/tenants/:id/commercial', param('id').isUUID(), aiCommercialHandler(async (req, res) => {
  const settings = await getAiCommercialSettings(req.params.id);
  if (!settings) return res.status(404).json({ error: 'Entreprise introuvable.' });
  res.json(settings);
}));
router.patch('/tenants/:id/default-user-limit', param('id').isUUID(), aiCommercialHandler(async (req, res) => {
  if (!validAiLimit(req.body?.limit) || Object.keys(req.body).some((key) => key !== 'limit')) {
    return res.status(400).json({ error: 'Quota par défaut invalide : entier de 0 à 1 000 000 ou null.' });
  }
  const { data, error } = await supabase.from('tenants').update({ ai_default_user_limit: req.body.limit })
    .eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw error;
  if (!data) return res.status(404).json({ error: 'Entreprise introuvable.' });
  await logSuperAdminAction({ actorId: req.user.id, action: 'ai_default_user_limit_updated', targetType: 'tenant',
    targetId: req.params.id, details: { limit: req.body.limit } });
  res.json(await getAiCommercialSettings(req.params.id));
}));
router.post('/tenants/:id/plan', param('id').isUUID(), aiCommercialHandler(async (req, res) => {
  if (!AI_PLAN_KEYS.includes(req.body?.key) || Object.keys(req.body).some((key) => key !== 'key')) {
    return res.status(400).json({ error: 'Forfait IA invalide.' });
  }
  const { data: plan, error } = await supabase.from('ai_plans').select('configured').eq('key', req.body.key).single();
  if (error) throw error;
  if (!plan.configured) return res.status(409).json({ error: 'Configurez et enregistrez ce forfait avant de l’appliquer.' });
  const before = await getAiCommercialSettings(req.params.id);
  if (!before) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const applied = await supabase.rpc('apply_ai_plan', { p_tenant_id: req.params.id, p_plan_key: req.body.key });
  if (applied.error) throw applied.error;
  await logSuperAdminAction({ actorId: req.user.id, action: 'ai_plan_applied', targetType: 'tenant',
    targetId: req.params.id, details: { before, after: applied.data } });
  res.json({
    ...applied.data,
    ai_modules: effectiveAiModules(applied.data.ai_modules),
    app_modules: effectiveAppModules(applied.data.app_modules),
  });
}));
export default router;
