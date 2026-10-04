import { Router } from 'express';
import { body, param, validationResult } from 'express-validator';
import { requireAuth, requireRole, requireSuperAdmin } from '../middleware/auth.js';
import { supabase } from '../services/supabase.js';
import { getAiQuota } from '../services/aiQuota.js';
import { logSuperAdminAction } from '../services/superAdminAudit.js';
import { getGroqQuota, GROQ_LIMIT_KEYS } from '../services/groqQuota.js';
import { AI_MODULES, effectiveAiModules } from '../services/aiModules.js';
import aiCommercialRouter, { aiUsageHandler } from './aiCommercial.js';

const router = Router();
router.use(requireAuth);
router.get('/', async (req, res) => {
  try {
    const { users, ...quota } = await getAiQuota(req.tenantId, req.user.id);
    res.json(quota);
  } catch (err) {
    console.error('[quota IA]', err.message);
    res.status(503).json({ error: 'Impossible de charger le quota IA.' });
  }
});
router.get('/usage', requireRole('admin'), aiUsageHandler);
router.use(requireSuperAdmin);
router.use(aiCommercialRouter);
router.get('/tenants/:id/modules', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Entreprise invalide.' });
  const { data, error } = await supabase.from('tenants').select('ai_modules').eq('id', req.params.id).maybeSingle();
  if (error) {
    console.error('[modules IA]', error.message);
    return res.status(500).json({ error: 'Impossible de charger les modules IA.' });
  }
  if (!data) return res.status(404).json({ error: 'Entreprise introuvable.' });
  res.json(effectiveAiModules(data.ai_modules));
});
router.patch('/tenants/:id/modules', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty() || !req.body || Array.isArray(req.body) ||
    Object.keys(req.body).length !== AI_MODULES.length ||
    AI_MODULES.some((key) => typeof req.body[key] !== 'boolean')) {
    return res.status(400).json({ error: 'Configuration des modules IA invalide.' });
  }
  const { data, error } = await supabase.from('tenants').update({ ai_modules: req.body }).eq('id', req.params.id).select('ai_modules').maybeSingle();
  if (error) {
    console.error('[modules IA]', error.message);
    return res.status(500).json({ error: 'Impossible de modifier les modules IA.' });
  }
  if (!data) return res.status(404).json({ error: 'Entreprise introuvable.' });
  await logSuperAdminAction({
    actorId: req.user.id, action: 'ai_modules_updated', targetType: 'tenant', targetId: req.params.id, details: req.body,
  });
  res.json(effectiveAiModules(data.ai_modules));
});
router.get('/groq', async (req, res) => {
  try {
    res.json(await getGroqQuota());
  } catch (err) {
    console.error('[quota Groq]', err.message);
    res.status(503).json({ error: 'Impossible de charger les limites globales Groq.' });
  }
});
router.patch('/groq', async (req, res) => {
  const limits = req.body;
  if (!limits || GROQ_LIMIT_KEYS.some((key) =>
    limits[key] !== null && (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > 1000000000)
  ) || Object.keys(limits).some((key) => !GROQ_LIMIT_KEYS.includes(key))) {
    return res.status(400).json({ error: 'Chaque plafond doit être un entier de 0 à 1 000 000 000, ou null pour désactiver cette limite.' });
  }
  const { error } = await supabase.from('platform_settings').update({
    value: limits, updated_at: new Date().toISOString(), updated_by: req.user.id,
  }).eq('key', 'groq_limits').select('key').single();
  if (error) {
    console.error('[quota Groq] modification impossible :', error.message);
    return res.status(500).json({ error: 'Impossible de modifier les limites globales Groq.' });
  }
  await logSuperAdminAction({ actorId: req.user.id, action: 'groq_limits_updated', targetType: 'platform', details: limits });
  try {
    res.json(await getGroqQuota());
  } catch (err) {
    console.error('[quota Groq]', err.message);
    res.status(503).json({ error: 'Limites enregistrées, mais impossible de charger les compteurs.' });
  }
});
router.get('/tenants/:id', param('id').isUUID(), async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Entreprise invalide.' });
  try {
    res.json(await getAiQuota(req.params.id));
  } catch (err) {
    console.error('[quota IA]', err.message);
    res.status(500).json({ error: 'Impossible de charger les quotas IA.' });
  }
});
router.patch(
  '/tenants/:id',
  [
    param('id').isUUID(),
    body('limit').custom((value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 1000000)),
    body('user_id').optional().isUUID(),
  ],
  async (req, res) => {
    if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Quota invalide (entier de 0 à 1 000 000 ou null pour illimité).' });
    const { user_id: userId, limit } = req.body;
    let query = supabase.from(userId ? 'users' : 'tenants').update({ ai_monthly_limit: limit }).eq('id', userId || req.params.id);
    if (userId) query = query.eq('tenant_id', req.params.id);
    const { data, error } = await query.select('id').maybeSingle();
    if (error) {
      console.error('[quota IA] modification impossible :', error.message);
      return res.status(500).json({ error: 'Impossible de modifier le quota IA.' });
    }
    if (!data) return res.status(404).json({ error: 'Entreprise ou utilisateur introuvable.' });
    await logSuperAdminAction({
      actorId: req.user.id, action: 'ai_quota_updated', targetType: userId ? 'user' : 'tenant',
      targetId: userId || req.params.id, details: { tenant_id: req.params.id, monthly_limit: limit },
    });
    try {
      res.json(await getAiQuota(req.params.id));
    } catch (err) {
      console.error('[quota IA]', err.message);
      res.status(500).json({ error: 'Quota enregistré, mais impossible de recharger la consommation.' });
    }
  },
);
export default router;
