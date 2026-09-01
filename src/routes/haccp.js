import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { generateHaccpHazardSuggestion } from '../services/groq.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { buildHaccpAuditPdf } from '../services/haccpAuditPdf.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const PLAN_STATUSES = ['draft', 'active', 'under_review', 'archived'];
const HAZARD_TYPES = ['biological', 'chemical', 'physical', 'allergen'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans risks.js/audits.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('haccp'));

const PLAN_SELECT = '*, service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/haccp/plans — liste tenant-wide, tous les rôles (même transparence que le registre
// des risques/audits). Une catégorie explicitement restreinte peut limiter l'accès.
router.get('/plans', async (req, res) => {
  let query = supabase.from('haccp_plans').select(PLAN_SELECT).eq('tenant_id', req.tenantId).order('created_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les plans HACCP.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

async function loadPlanForTenant(tenantId, planId) {
  const { data, error } = await supabase.from('haccp_plans').select(PLAN_SELECT).eq('tenant_id', tenantId).eq('id', planId).single();
  if (error || !data) return null;
  return data;
}

// Assemble un plan avec ses étapes, chacune avec ses dangers, chacun avec son CCP (le cas
// échéant) — 3 requêtes plutôt qu'un N+1 (une par étape). Réutilisé par GET /plans/:id (JSON)
// et par les exports PDF (un seul plan ou plusieurs) : même forme de données dans les deux cas.
async function loadPlanSteps(tenantId, plan) {
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

// GET /api/haccp/plans/:id — plan complet avec ses étapes, chacune avec ses dangers, chacun
// avec son CCP (le cas échéant).
router.get('/plans/:id', async (req, res) => {
  const plan = await loadPlanForTenant(req.tenantId, req.params.id);
  if (!plan) {
    return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: plan.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  }

  let stepsWithHazards;
  try {
    stepsWithHazards = await loadPlanSteps(req.tenantId, plan);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  res.json({ ...plan, steps: stepsWithHazards, is_private_to_me: plan.category?.owner_user_id === req.user.id });
});

// POST /api/haccp/plans — admin/manager uniquement : la constitution d'un plan HACCP est une
// activité de pilotage SMQ, comme pour les audits/risques.
router.post(
  '/plans',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('product_description').optional({ values: 'falsy' }).trim(),
    body('scope').optional({ values: 'falsy' }).trim(),
    body('team').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('status').optional({ values: 'falsy' }).isIn(PLAN_STATUSES).withMessage('Statut invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('haccp_plan'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      product_description: productDescription,
      scope,
      team,
      service_id: serviceId,
      status,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('haccp_plans')
      .insert({
        tenant_id: req.tenantId,
        title,
        product_description: productDescription || null,
        scope: scope || null,
        team: team || null,
        service_id: serviceId || null,
        status: status || undefined,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(PLAN_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du plan HACCP.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/haccp/plans/bulk-category — placée avant PATCH /plans/:id pour ne pas être
// capturée comme un id, même convention que risks.js/audits.js.
router.patch(
  '/plans/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un plan.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('haccp_plan'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('haccp_plans')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids)
      .select('id');

    if (error) {
      return res.status(500).json({ error: 'Erreur lors du déplacement.' });
    }

    res.json({ updated: data.length });
  }
);

router.patch(
  '/plans/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('product_description').optional({ values: 'falsy' }).trim(),
    body('scope').optional({ values: 'falsy' }).trim(),
    body('team').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('status').optional().isIn(PLAN_STATUSES).withMessage('Statut invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('haccp_plan'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'product_description', 'scope', 'team', 'status']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('haccp_plans')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(PLAN_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Plan HACCP introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/haccp/plans/bulk — placée avant DELETE /plans/:id, même convention.
router.delete(
  '/plans/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un plan.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('haccp_plans')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/haccp/plans/:id — admin/manager uniquement. Cascade sur étapes/dangers/CCP/
// surveillance (voir schema.sql, on delete cascade en chaîne) ; les CAPA déjà créées à partir
// d'une dérive gardent leur trace (haccp_monitoring_log_id passe à null, même principe que
// audits/risks).
router.delete('/plans/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('haccp_plans').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du plan HACCP.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  }

  res.status(204).end();
});

// --- Étapes du procédé -------------------------------------------------------------------

// POST /api/haccp/plans/:planId/steps — step_number auto-incrémenté si non fourni.
router.post(
  '/plans/:planId/steps',
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Le nom de l’étape est requis.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('step_number').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Numéro d’étape invalide.'),
  ],
  async (req, res) => {
    const plan = await loadPlanForTenant(req.tenantId, req.params.planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan HACCP introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    let stepNumber = req.body.step_number;
    if (!stepNumber) {
      const { data: lastStep } = await supabase
        .from('haccp_process_steps')
        .select('step_number')
        .eq('tenant_id', req.tenantId)
        .eq('plan_id', plan.id)
        .order('step_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      stepNumber = (lastStep?.step_number || 0) + 1;
    }

    const { data, error } = await supabase
      .from('haccp_process_steps')
      .insert({
        tenant_id: req.tenantId,
        plan_id: plan.id,
        step_number: stepNumber,
        name: req.body.name,
        description: req.body.description || null,
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'étape." });
    }

    res.status(201).json(data);
  }
);

router.patch(
  '/steps/:id',
  requireRole('admin', 'manager'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom de l’étape ne peut pas être vide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('step_number').optional().isInt({ min: 1 }).withMessage('Numéro d’étape invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['name', 'description']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('step_number' in req.body) update.step_number = req.body.step_number;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('haccp_process_steps')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Étape introuvable.' });
    }

    res.json(data);
  }
);

router.delete('/steps/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('haccp_process_steps').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'étape." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Étape introuvable.' });
  }

  res.status(204).end();
});

// --- Analyse des dangers -------------------------------------------------------------------

// POST /api/haccp/steps/:stepId/hazard-suggestion — suggestion IA, rien n'est persisté ici :
// le frontend affiche les suggestions dans une liste à cocher, chacune acceptée devient un
// POST /steps/:stepId/hazards distinct (avec ai_generated: true).
router.post('/steps/:stepId/hazard-suggestion', requireRole('admin', 'manager'), async (req, res) => {
  const { data: step, error: fetchError } = await supabase
    .from('haccp_process_steps')
    .select('id, name, description')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.stepId)
    .single();

  if (fetchError || !step) {
    return res.status(404).json({ error: 'Étape introuvable.' });
  }

  try {
    const suggestion = await generateHaccpHazardSuggestion({ stepName: step.name, stepDescription: step.description });
    res.json(suggestion);
  } catch (err) {
    res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
  }
});

router.post(
  '/steps/:stepId/hazards',
  requireRole('admin', 'manager'),
  [
    body('hazard_type').isIn(HAZARD_TYPES).withMessage('Type de danger invalide.'),
    body('description').trim().notEmpty().withMessage('La description est requise.'),
    body('existing_controls').optional({ values: 'falsy' }).trim(),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('severity').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('is_significant').optional().isBoolean().withMessage('Valeur invalide.'),
    body('justification').optional({ values: 'falsy' }).trim(),
    body('ai_generated').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const { data: step, error: fetchError } = await supabase
      .from('haccp_process_steps')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.stepId)
      .single();

    if (fetchError || !step) {
      return res.status(404).json({ error: 'Étape introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      hazard_type: hazardType,
      description,
      existing_controls: existingControls,
      likelihood,
      severity,
      is_significant: isSignificant,
      justification,
      ai_generated: aiGenerated,
    } = req.body;

    const { data, error } = await supabase
      .from('haccp_hazards')
      .insert({
        tenant_id: req.tenantId,
        step_id: step.id,
        hazard_type: hazardType,
        description,
        existing_controls: existingControls || null,
        likelihood,
        severity,
        is_significant: isSignificant || false,
        justification: justification || null,
        ai_generated: aiGenerated || false,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du danger.' });
    }

    res.status(201).json(data);
  }
);

router.patch(
  '/hazards/:id',
  requireRole('admin', 'manager'),
  [
    body('hazard_type').optional().isIn(HAZARD_TYPES).withMessage('Type de danger invalide.'),
    body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'),
    body('existing_controls').optional({ values: 'falsy' }).trim(),
    body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('severity').optional().isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('is_significant').optional().isBoolean().withMessage('Valeur invalide.'),
    body('justification').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['hazard_type', 'description', 'existing_controls', 'justification']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('likelihood' in req.body) update.likelihood = req.body.likelihood;
    if ('severity' in req.body) update.severity = req.body.severity;
    if ('is_significant' in req.body) update.is_significant = req.body.is_significant;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('haccp_hazards')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Danger introuvable.' });
    }

    res.json(data);
  }
);

router.delete('/hazards/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('haccp_hazards').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du danger.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Danger introuvable.' });
  }

  res.status(204).end();
});

// --- Points critiques (CCP) ----------------------------------------------------------------

// POST /api/haccp/hazards/:hazardId/ccps — un CCP n'a de sens que pour un danger déjà jugé
// significatif (coeur de la méthode HACCP) : refusé sinon plutôt que silencieusement accepté.
router.post(
  '/hazards/:hazardId/ccps',
  requireRole('admin', 'manager'),
  [
    body('ccp_number').optional({ values: 'falsy' }).trim(),
    body('critical_limits').trim().notEmpty().withMessage('Les limites critiques sont requises.'),
    body('monitoring_procedure').trim().notEmpty().withMessage('La procédure de surveillance est requise.'),
    body('monitoring_frequency').optional({ values: 'falsy' }).trim(),
    body('monitoring_responsible').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('corrective_action_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_frequency').optional({ values: 'falsy' }).trim(),
    body('record_keeping_procedure').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: hazard, error: fetchError } = await supabase
      .from('haccp_hazards')
      .select('id, is_significant')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.hazardId)
      .single();

    if (fetchError || !hazard) {
      return res.status(404).json({ error: 'Danger introuvable.' });
    }
    if (!hazard.is_significant) {
      return res.status(400).json({ error: "Ce danger n'est pas marqué comme significatif : marquez-le comme tel avant d'y rattacher un CCP." });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      ccp_number: ccpNumber,
      critical_limits: criticalLimits,
      monitoring_procedure: monitoringProcedure,
      monitoring_frequency: monitoringFrequency,
      monitoring_responsible: monitoringResponsible,
      corrective_action_procedure: correctiveActionProcedure,
      verification_procedure: verificationProcedure,
      verification_frequency: verificationFrequency,
      record_keeping_procedure: recordKeepingProcedure,
    } = req.body;

    const { data, error } = await supabase
      .from('haccp_ccps')
      .insert({
        tenant_id: req.tenantId,
        hazard_id: hazard.id,
        ccp_number: ccpNumber || null,
        critical_limits: criticalLimits,
        monitoring_procedure: monitoringProcedure,
        monitoring_frequency: monitoringFrequency || null,
        monitoring_responsible: monitoringResponsible || null,
        corrective_action_procedure: correctiveActionProcedure || null,
        verification_procedure: verificationProcedure || null,
        verification_frequency: verificationFrequency || null,
        record_keeping_procedure: recordKeepingProcedure || null,
      })
      .select('*, monitoring_responsible_user:users!haccp_ccps_monitoring_responsible_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du point critique.' });
    }

    res.status(201).json(data);
  }
);

router.patch(
  '/ccps/:id',
  requireRole('admin', 'manager'),
  [
    body('ccp_number').optional({ values: 'falsy' }).trim(),
    body('critical_limits').optional().trim().notEmpty().withMessage('Les limites critiques ne peuvent pas être vides.'),
    body('monitoring_procedure').optional().trim().notEmpty().withMessage('La procédure de surveillance ne peut pas être vide.'),
    body('monitoring_frequency').optional({ values: 'falsy' }).trim(),
    body('monitoring_responsible').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('corrective_action_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_frequency').optional({ values: 'falsy' }).trim(),
    body('record_keeping_procedure').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of [
      'ccp_number',
      'critical_limits',
      'monitoring_procedure',
      'monitoring_frequency',
      'corrective_action_procedure',
      'verification_procedure',
      'verification_frequency',
      'record_keeping_procedure',
    ]) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('monitoring_responsible' in req.body) update.monitoring_responsible = req.body.monitoring_responsible || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('haccp_ccps')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*, monitoring_responsible_user:users!haccp_ccps_monitoring_responsible_fkey(id, full_name)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Point critique introuvable.' });
    }

    res.json(data);
  }
);

router.delete('/ccps/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('haccp_ccps').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du point critique.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Point critique introuvable.' });
  }

  res.status(204).end();
});

// --- Surveillance ----------------------------------------------------------------------

// GET /api/haccp/ccps/:ccpId/monitoring-logs — les 200 relevés les plus récents. Tout rôle
// authentifié (voir POST ci-dessous) peut les consulter.
router.get('/ccps/:ccpId/monitoring-logs', async (req, res) => {
  const { data, error } = await supabase
    .from('haccp_monitoring_logs')
    .select('*, recorded_by_user:users!haccp_monitoring_logs_recorded_by_fkey(id, full_name), linked_capa:capas!haccp_monitoring_logs_linked_capa_id_fkey(id, number, title, status)')
    .eq('tenant_id', req.tenantId)
    .eq('ccp_id', req.params.ccpId)
    .order('recorded_at', { ascending: false })
    .limit(200);

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les relevés de surveillance.' });
  }

  res.json(data);
});

// POST /api/haccp/ccps/:ccpId/monitoring-logs — tout rôle authentifié peut saisir un relevé :
// ce sont les opérateurs terrain qui relèvent les mesures au quotidien, pas seulement les
// managers (contrairement à la conception du plan lui-même, réservée à admin/manager).
router.post(
  '/ccps/:ccpId/monitoring-logs',
  [
    body('recorded_value').trim().notEmpty().withMessage('La valeur relevée est requise.'),
    body('within_limits').isBoolean().withMessage('Valeur invalide.'),
    body('corrective_action_taken').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: ccp, error: fetchError } = await supabase
      .from('haccp_ccps')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.ccpId)
      .single();

    if (fetchError || !ccp) {
      return res.status(404).json({ error: 'Point critique introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('haccp_monitoring_logs')
      .insert({
        tenant_id: req.tenantId,
        ccp_id: ccp.id,
        recorded_value: req.body.recorded_value,
        within_limits: req.body.within_limits,
        corrective_action_taken: req.body.corrective_action_taken || null,
        recorded_by: req.user.id,
      })
      .select('*, recorded_by_user:users!haccp_monitoring_logs_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la saisie du relevé.' });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/haccp/monitoring-logs/:id — admin/manager uniquement (contrairement à la
// saisie, ouverte à tous : corriger/purger l'historique reste une action de pilotage).
router.delete('/monitoring-logs/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('haccp_monitoring_logs')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du relevé.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Relevé introuvable.' });
  }

  res.status(204).end();
});

// POST /api/haccp/monitoring-logs/:id/create-capa — crée une CAPA à partir d'une dérive de
// surveillance et lie les deux dans les deux sens. Même mécanique que POST /risks/:id/create-capa.
router.post(
  '/monitoring-logs/:id/create-capa',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: log, error: fetchError } = await supabase
      .from('haccp_monitoring_logs')
      .select('id, recorded_value, ccp:haccp_ccps(ccp_number)')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !log) {
      return res.status(404).json({ error: 'Relevé introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
    } = req.body;

    const ccpLabel = log.ccp?.ccp_number ? `CCP ${log.ccp.ccp_number}` : 'un point critique HACCP';
    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        origin: `Dérive de surveillance HACCP — ${ccpLabel} (${log.recorded_value})`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        haccp_monitoring_log_id: log.id,
        created_by: req.user.id,
      })
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (capaError) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    if (capa.assigned_to) {
      notifyCapaAssigned(req.tenantId, capa).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    const { error: linkError } = await supabase
      .from('haccp_monitoring_logs')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', log.id);

    if (linkError) {
      console.error('Échec de la mise à jour du relevé après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

// Une entrée par CCP : { total, outOfLimits, linkedCapas, lastRecordedAt } — une seule requête
// groupée sur tous les CCP demandés plutôt qu'une par CCP (voir le même principe pour
// latest_version_comment dans routes/documents.js).
async function computeMonitoringSummaryByCcpId(tenantId, ccpIds) {
  const summary = new Map();
  if (ccpIds.length === 0) return summary;

  const { data: logs, error } = await supabase
    .from('haccp_monitoring_logs')
    .select('ccp_id, within_limits, linked_capa_id, recorded_at')
    .eq('tenant_id', tenantId)
    .in('ccp_id', ccpIds);
  if (error) throw new Error('Impossible de récupérer la synthèse de surveillance.');

  for (const log of logs || []) {
    const entry = summary.get(log.ccp_id) || { total: 0, outOfLimits: 0, linkedCapas: 0, lastRecordedAt: null };
    entry.total += 1;
    if (!log.within_limits) entry.outOfLimits += 1;
    if (log.linked_capa_id) entry.linkedCapas += 1;
    if (!entry.lastRecordedAt || log.recorded_at > entry.lastRecordedAt) entry.lastRecordedAt = log.recorded_at;
    summary.set(log.ccp_id, entry);
  }
  return summary;
}

// Charge un ou plusieurs plans déjà assemblés (steps -> hazards -> ccp) + la synthèse de
// surveillance de tous leurs CCP, prêts pour buildHaccpAuditPdf. Ne filtre PAS par permission
// de catégorie : à l'appelant de ne passer que des plans déjà vérifiés visibles.
async function loadPlansForPdf(tenantId, plans) {
  const assembled = [];
  for (const plan of plans) {
    assembled.push({ ...plan, steps: await loadPlanSteps(tenantId, plan) });
  }

  const ccpIds = assembled.flatMap((plan) => plan.steps.flatMap((step) => step.hazards.map((h) => h.ccp?.id).filter(Boolean)));
  const monitoringSummaryByCcpId = await computeMonitoringSummaryByCcpId(tenantId, ccpIds);

  return { assembled, monitoringSummaryByCcpId };
}

// GET /api/haccp/plans/:id/pdf — export détaillé d'UN plan (dangers, CCP, synthèse de
// surveillance), même mécanique que GET /qqoqccp/:id/pdf.
router.get('/plans/:id/pdf', async (req, res) => {
  const plan = await loadPlanForTenant(req.tenantId, req.params.id);
  if (!plan) {
    return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: plan.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  }

  let assembled, monitoringSummaryByCcpId;
  try {
    ({ assembled, monitoringSummaryByCcpId } = await loadPlansForPdf(req.tenantId, [plan]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const pdfBuffer = await buildHaccpAuditPdf({ tenantName: tenant?.name, tenantLogo, plans: assembled, monitoringSummaryByCcpId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="haccp-${plan.id}.pdf"`);
  res.send(pdfBuffer);
});

// POST /api/haccp/plans/pdf — export combiné de plusieurs plans (une page par plan) : ids
// explicites dans le body (même convention que /plans/bulk-category et /plans/bulk), ou tous
// les plans visibles par l'appelant si absent/vide.
router.post('/plans/pdf', [body('ids').optional().isArray().withMessage('Liste invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  let query = supabase.from('haccp_plans').select(PLAN_SELECT).eq('tenant_id', req.tenantId).order('created_at', { ascending: false });
  if (req.body.ids?.length > 0) query = query.in('id', req.body.ids);

  const { data: plans, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les plans HACCP.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: plans });
  if (visible.length === 0) {
    return res.status(404).json({ error: 'Aucun plan HACCP à exporter.' });
  }

  let assembled, monitoringSummaryByCcpId;
  try {
    ({ assembled, monitoringSummaryByCcpId } = await loadPlansForPdf(req.tenantId, visible));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const pdfBuffer = await buildHaccpAuditPdf({ tenantName: tenant?.name, tenantLogo, plans: assembled, monitoringSummaryByCcpId });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="haccp-analyses-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdfBuffer);
});

export default router;
