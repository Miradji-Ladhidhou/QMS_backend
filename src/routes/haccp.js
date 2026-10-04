import { Router } from 'express';
import { prepareAiResult, aiResultRoute, insertAiApplication } from '../services/aiGenerations.js';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { generateHaccpHazardSuggestion } from '../services/groq.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { buildHaccpAuditPdf } from '../services/haccpAuditPdf.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { loadPlanSteps } from '../services/haccpPlan.js';
import {
  countRecentDeviations,
  evaluateReading,
  fetchCcpStatuses,
  hasRepeatedDeviation,
  numericLimitsOf,
  describeLimits,
} from '../services/haccpMonitoring.js';
import { createRevision, describeRevisions } from '../services/haccpRevisions.js';
import {
  HACCP_LINK_KINDS,
  HACCP_LINK_KIND_KEYS,
  fetchHaccpLinks,
  fetchTrainingCoverage,
  findHaccpLinkTarget,
  listHaccpLinkCandidates,
} from '../services/haccpLinks.js';
import { sendImmediateNotification } from '../services/notificationHelpers.js';
import { buildHaccpAuditWord } from '../services/haccpAuditWord.js';
import { buildHaccpCcpPdf } from '../services/haccpCcpPdf.js';
import { buildHaccpRecordSheetPdf } from '../services/haccpRecordSheetPdf.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const PLAN_STATUSES = ['draft', 'active', 'under_review', 'archived'];
const HAZARD_TYPES = ['biological', 'chemical', 'physical', 'allergen'];
const HAZARD_CONTROL_TYPES = ['undetermined', 'prp', 'ccp', 'process_change'];
const PLAN_DOSSIER_FIELDS = [
  'prerequisites',
  'intended_use',
  'consumer_groups',
  'product_characteristics',
  'flow_diagram_reference',
  'flow_diagram_verification',
  'no_ccp_justification',
  'validation_review_notes',
  'verification_review_notes',
];
const CCP_OPERATIONAL_STATUSES = ['approved', 'legacy'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans risks.js/audits.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

function substantiveText(value, minLength = 8) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  return text.length >= minLength && !/^(?:n\/?a|none|tbd|todo|à compléter|a completer|non renseigné|non renseigne|à confirmer|a confirmer|aucun)$/i.test(text);
}

// Date yyyy-mm-dd dans `months` mois (le jour est ramené au dernier jour du mois cible si besoin).
function addMonthsIso(months) {
  const date = new Date();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

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

async function canManageHaccpCategory(req, categoryId) {
  return hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId,
    permission: 'manage',
  });
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

  // État de surveillance de chaque CCP (relevé en retard, dérives répétées, dernier relevé) : calculé ici, une
  // seule fois pour tout le plan, plutôt que par un aller-retour par CCP.
  let statusByCcpId;
  try {
    statusByCcpId = new Map((await fetchCcpStatuses(req.tenantId, { planIds: [plan.id] })).map((ccp) => [ccp.id, ccp]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const withStatus = stepsWithHazards.map((step) => ({
    ...step,
    hazards: step.hazards.map((hazard) => {
      const status = hazard.ccp ? statusByCcpId.get(hazard.ccp.id) : null;
      const limits = hazard.ccp ? numericLimitsOf(hazard.ccp) : null;
      return {
        ...hazard,
        ccp: hazard.ccp && CCP_OPERATIONAL_STATUSES.includes(hazard.ccp.status)
          ? {
              ...hazard.ccp,
              limits,
              limits_text: status?.limits_text || '',
              last_reading: status?.last_reading || null,
              monitoring_state: status?.monitoring_state || 'no_schedule',
              due_at: status?.due_at || null,
              overdue_hours: status?.overdue_hours || 0,
              recent_deviations: status?.recent_deviations || 0,
              repeated_deviation: Boolean(status?.repeated_deviation),
            }
          : hazard.ccp ? { ...hazard.ccp, limits, limits_text: describeLimits(limits) } : null,
      };
    }),
  }));

  res.json({ ...plan, steps: withStatus, is_private_to_me: plan.category?.owner_user_id === req.user.id });
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
    ...PLAN_DOSSIER_FIELDS.map((field) => body(field).optional({ nullable: true }).isString().trim().isLength({ max: 5000 }).withMessage(`${field} ne peut pas dépasser 5 000 caractères.`)),
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
    if (req.body.status === 'active') {
      return res.status(400).json({ error: 'Créez le plan en brouillon puis activez-le après validation du dossier HACCP.' });
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
        ...Object.fromEntries(PLAN_DOSSIER_FIELDS.map((field) => [field, req.body[field]?.trim() || null])),
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
    ...PLAN_DOSSIER_FIELDS.map((field) => body(field).optional({ nullable: true }).isString().trim().isLength({ max: 5000 }).withMessage(`${field} ne peut pas dépasser 5 000 caractères.`)),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('status').optional().isIn(PLAN_STATUSES).withMessage('Statut invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('review_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
  ],
  requireValidCategoryId('haccp_plan'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'product_description', 'scope', 'team', 'status', 'review_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    for (const field of PLAN_DOSSIER_FIELDS) {
      if (field in req.body) update[field] = req.body[field]?.trim() || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Activation exige un dossier préalable, une décision documentée pour chaque danger et des
    // CCP validés lorsque l'analyse les a retenus. La significativité du risque n'impose pas un CCP.
    if (update.status === 'active') {
      const activationPlan = await loadPlanForTenant(req.tenantId, req.params.id);
      if (!activationPlan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
      const candidatePlan = { ...activationPlan, ...update };
      const { data: steps, error: stepsError } = await supabase
        .from('haccp_process_steps')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('plan_id', req.params.id);

      if (stepsError) {
        return res.status(500).json({ error: 'Impossible de vérifier les étapes du plan.' });
      }

      const stepIds = steps.map((step) => step.id);
      if (stepIds.length === 0) {
        return res.status(400).json({ error: 'Ajoutez les étapes du procédé et leur analyse des dangers avant d’activer ce plan.' });
      }
      const missingDossier = PLAN_DOSSIER_FIELDS.filter((field) =>
        field !== 'no_ccp_justification' && !substantiveText(candidatePlan[field])
      );
      if (missingDossier.length > 0) {
        return res.status(400).json({ error: 'Complétez le dossier préliminaire, les preuves du diagramme de fabrication et les notes distinctes de revue de validation et de vérification avant activation.', missing_fields: missingDossier });
      }

      let hazards = [];
      if (stepIds.length > 0) {
        const { data, error: hazardsError } = await supabase
          .from('haccp_hazards')
          .select('id, step_id, control_type, decision_justification')
          .eq('tenant_id', req.tenantId)
          .in('step_id', stepIds);

        if (hazardsError) {
          return res.status(500).json({ error: "Impossible de vérifier l'analyse des dangers." });
        }
        hazards = data;
      }

      if (hazards.length === 0) {
        return res.status(400).json({
          error: "Ce plan ne comporte aucun danger analysé : complétez l'analyse avant de l'activer.",
        });
      }
      const analyzedStepIds = new Set(hazards.map((hazard) => hazard.step_id));
      if (stepIds.some((stepId) => !analyzedStepIds.has(stepId))) {
        return res.status(400).json({ error: 'Chaque étape du procédé doit comporter au moins un danger analysé avant activation.' });
      }

      const undecidedHazards = hazards.filter((hazard) => hazard.control_type === 'undetermined' || !substantiveText(hazard.decision_justification));
      if (undecidedHazards.length > 0) {
        return res.status(400).json({
          error: 'Chaque danger doit avoir une décision de maîtrise documentée avant activation.',
          hazard_ids: undecidedHazards.map((hazard) => hazard.id),
        });
      }

      const ccpHazards = hazards.filter((hazard) => hazard.control_type === 'ccp');
      if (ccpHazards.length === 0 && !substantiveText(candidatePlan.no_ccp_justification)) {
        return res.status(400).json({ error: 'Justifiez pourquoi aucun CCP n’est retenu avant d’activer ce plan.' });
      }
      if (ccpHazards.length > 0) {
        const { data: ccps, error: ccpsError } = await supabase
          .from('haccp_ccps')
          .select('hazard_id, status')
          .eq('tenant_id', req.tenantId)
          .in('hazard_id', ccpHazards.map((hazard) => hazard.id))
          .in('status', CCP_OPERATIONAL_STATUSES);

        if (ccpsError) return res.status(500).json({ error: 'Impossible de vérifier les points critiques.' });
        const hazardIdsWithValidatedCcp = new Set(ccps.map((ccp) => ccp.hazard_id));
        const uncovered = ccpHazards.filter((hazard) => !hazardIdsWithValidatedCcp.has(hazard.id));
        if (uncovered.length > 0) {
          return res.status(400).json({
            error: 'Chaque danger classé CCP doit avoir un CCP approuvé ou un CCP historique préservé avant activation.',
            hazard_ids: uncovered.map((hazard) => hazard.id),
          });
        }
      }
    }

    // Un plan qui devient actif est validé : sa revue annuelle démarre (sauf date déjà fixée) et une version est conservée.
    const { data: before } = await supabase.from('haccp_plans').select('status, review_date').eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle();
    const activating = update.status === 'active' && before && before.status !== 'active';
    if (activating && !('review_date' in update) && !before.review_date) update.review_date = addMonthsIso(12);

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

    if (activating) {
      await createRevision({ tenantId: req.tenantId, plan: data, kind: 'activation', reason: 'Plan activé', userId: req.user.id }).catch((err) =>
        console.error("[haccp] Échec de l'enregistrement de la version d'activation :", err.message)
      );
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

// POST /api/haccp/steps/:stepId/hazard-suggestion — proposition IA persistée :
// le frontend affiche les suggestions dans une liste à cocher, chacune acceptée devient un
// POST /steps/:stepId/hazards distinct (avec ai_generated: true).
aiResultRoute(router, '/steps/:stepId/hazard-suggestion', requireRole('admin', 'manager'), async (req, res) => {
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
    if (!(await prepareAiResult(req, res))) return;
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
    body('control_type').optional().isIn(HAZARD_CONTROL_TYPES).withMessage('Décision de maîtrise invalide.'),
    body('decision_justification').optional({ values: 'falsy' }).trim(),
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
      control_type: controlType,
      decision_justification: decisionJustification,
    } = req.body;

    if (controlType && controlType !== 'undetermined' && !substantiveText(decisionJustification)) {
      return res.status(400).json({ error: 'Justifiez la décision de maîtrise du danger.' });
    }

    const application = await insertAiApplication(req, res, {
      table: 'haccp_hazards', endpoint: `/api/haccp/steps/${step.id}/hazard-suggestion`,
      row: {
        tenant_id: req.tenantId,
        step_id: step.id,
        hazard_type: hazardType,
        description,
        existing_controls: existingControls || null,
        likelihood,
        severity,
        is_significant: isSignificant || false,
        justification: justification || null,
        control_type: controlType || 'undetermined',
        decision_justification: decisionJustification || null,
        ai_generated: aiGenerated || false,
        created_by: req.user.id,
      },
    });
    if (!application) return;
    const { data, error } = application;

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
    body('control_type').optional().isIn(HAZARD_CONTROL_TYPES).withMessage('Décision de maîtrise invalide.'),
    body('decision_justification').optional({ values: 'falsy' }).trim(),
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
    if ('control_type' in req.body) update.control_type = req.body.control_type;
    if ('decision_justification' in req.body) update.decision_justification = req.body.decision_justification || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }
    const controlType = update.control_type;
    const justification = update.decision_justification;
    if (controlType && controlType !== 'undetermined' && !substantiveText(justification)) {
      const { data: current, error: currentError } = await supabase
        .from('haccp_hazards')
        .select('decision_justification')
        .eq('tenant_id', req.tenantId)
        .eq('id', req.params.id)
        .maybeSingle();
      if (currentError) return res.status(500).json({ error: 'Impossible de vérifier la justification du danger.' });
      if (!substantiveText(justification || current?.decision_justification)) {
        return res.status(400).json({ error: 'Justifiez la décision de maîtrise du danger.' });
      }
    }
    if ('control_type' in update) {
      const { data: hazardScope, error: scopeError } = await supabase
        .from('haccp_hazards')
        .select('step:haccp_process_steps(plan:haccp_plans(category_id))')
        .eq('tenant_id', req.tenantId)
        .eq('id', req.params.id)
        .maybeSingle();
      if (scopeError) return res.status(500).json({ error: 'Impossible de vérifier les droits sur cette décision.' });
      if (!hazardScope) return res.status(404).json({ error: 'Danger introuvable.' });
      const canManage = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: hazardScope.step?.plan?.category_id,
        permission: 'manage',
      });
      if (!canManage) return res.status(404).json({ error: 'Danger introuvable.' });
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

// Champs chiffrés d'un CCP : bornes critiques (0 est une borne valide : jamais de « falsy »), unité et intervalle
// de surveillance en heures. '' / null = « non défini ».
const isBlank = (value) => value === '' || value === null || value === undefined;
const CCP_NUMERIC_VALIDATORS = [
  body('limit_min').optional().custom((value) => isBlank(value) || Number.isFinite(Number(value))).withMessage('Limite minimale invalide.'),
  body('limit_max').optional().custom((value) => isBlank(value) || Number.isFinite(Number(value))).withMessage('Limite maximale invalide.'),
  body('limit_unit').optional({ values: 'falsy' }).trim().isLength({ max: 20 }).withMessage('Unité trop longue (20 caractères maximum).'),
  body('monitoring_interval_hours')
    .optional()
    .custom((value) => isBlank(value) || (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 8760))
    .withMessage("L'intervalle de surveillance doit être un nombre d'heures entre 0 et 8760."),
];

const toNumberOrNull = (value) => (isBlank(value) ? null : Number(value));

// Colonnes chiffrées à écrire pour les champs présents dans le corps de la requête.
function ccpNumericUpdate(body) {
  const update = {};
  if ('limit_min' in body) update.limit_min = toNumberOrNull(body.limit_min);
  if ('limit_max' in body) update.limit_max = toNumberOrNull(body.limit_max);
  if ('limit_unit' in body) update.limit_unit = body.limit_unit || null;
  if ('monitoring_interval_hours' in body) update.monitoring_interval_hours = toNumberOrNull(body.monitoring_interval_hours);
  return update;
}

const LIMITS_ORDER_ERROR = 'La limite minimale ne peut pas dépasser la limite maximale.';
const CCP_TEXT_FIELDS = [
  'ccp_number',
  'critical_limits',
  'monitoring_procedure',
  'monitoring_frequency',
  'monitoring_responsible',
  'corrective_action_procedure',
  'verification_procedure',
  'verification_frequency',
  'record_keeping_procedure',
];

function ccpPayloadFromBody(body) {
  const payload = Object.fromEntries(CCP_TEXT_FIELDS.map((field) => [field, typeof body[field] === 'string' ? body[field].trim() || null : body[field] || null]));
  return {
    ...payload,
    ...ccpNumericUpdate(body),
    ai_generated: body.ai_generated === undefined ? false : body.ai_generated,
  };
}

function mapCcpRpcError(error) {
  const message = error?.message || '';
  if (message.includes('CCP_EXISTS')) return { status: 409, message: 'Un CCP existe déjà pour ce danger et ne peut pas être remplacé.' };
  if (message.includes('HAZARD_NOT_FOUND')) return { status: 404, message: 'Danger introuvable.' };
  console.error('[haccp] Échec transactionnel de création du CCP :', message);
  return { status: 500, message: 'Erreur lors de la création du brouillon CCP.' };
}

async function createCcpDraftAtomically({ tenantId, hazardId, decisionJustification, payload }) {
  return supabase.rpc('haccp_create_ccp_draft', {
    p_tenant_id: tenantId,
    p_hazard_id: hazardId,
    p_decision_justification: decisionJustification,
    p_ccp: payload,
  });
}

function ccpApprovalErrors(ccp) {
  const errors = [];
  const required = {
    critical_limits: 'Les limites critiques doivent être précises et vérifiables.',
    validation_source: 'La source de validation est requise.',
    validation_evidence: 'Les preuves de validation sont requises.',
    monitoring_procedure: 'La procédure de surveillance est requise.',
    monitoring_frequency: 'La fréquence de surveillance est requise.',
    monitoring_responsible: 'Un responsable de surveillance est requis.',
    corrective_action_procedure: 'La procédure d’action corrective est requise.',
    verification_procedure: 'La procédure de vérification est requise.',
    verification_frequency: 'La fréquence de vérification est requise.',
    record_keeping_procedure: 'La procédure de tenue des enregistrements est requise.',
  };
  for (const [field, message] of Object.entries(required)) {
    const isFrequency = field === 'monitoring_frequency' || field === 'verification_frequency';
    const minLength = field === 'validation_evidence' ? 20 : field === 'validation_source' ? 5 : isFrequency ? 1 : 8;
    if (field === 'monitoring_responsible' ? !ccp[field] : !substantiveText(ccp[field], minLength)) errors.push(message);
  }

  const numericLimits = numericLimitsOf(ccp);
  if (numericLimits) {
    const text = String(ccp.critical_limits || '');
    const statedNumbers = new Set((text.match(/-?\d+(?:[.,]\d+)?/g) || []).map((value) => Number(value.replace(',', '.'))));
    for (const bound of [numericLimits.min, numericLimits.max]) {
      if (bound !== null && !statedNumbers.has(bound)) {
        errors.push('Les bornes numériques doivent être cohérentes avec les limites critiques textuelles.');
        break;
      }
    }
    if (numericLimits.unit && !text.toLowerCase().replace(/[°\s]/g, '').includes(numericLimits.unit.toLowerCase().replace(/[°\s]/g, ''))) {
      errors.push('L’unité numérique doit correspondre aux limites critiques textuelles.');
    }
  }
  return errors;
}

// Un lot de propositions donne une décision explicite pour chaque danger retenu, mais chaque
// insertion + mise à jour de décision reste atomique et indépendante des autres propositions.
router.post(
  '/plans/:id/ccp-drafts',
  requireRole('admin', 'manager'),
  [body('proposals').isArray({ min: 1, max: 50 }).withMessage('Fournissez entre 1 et 50 propositions CCP.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Données invalides.', details: errors.array() });

    const plan = await findVisiblePlan(req);
    if (!plan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
    const created = [];
    const failed = [];

    for (const proposal of req.body.proposals) {
      const hazardId = proposal?.hazard_id;
      const errorMessage = validateDraftProposal(proposal);
      if (errorMessage) {
        failed.push({ hazard_id: hazardId || null, error: errorMessage });
        continue;
      }

      const { data: hazard, error: hazardError } = await supabase
        .from('haccp_hazards')
        .select('id, decision_justification, control_type, step:haccp_process_steps(plan:haccp_plans(id, category_id))')
        .eq('tenant_id', req.tenantId)
        .eq('id', hazardId)
        .maybeSingle();
      if (hazardError) {
        failed.push({ hazard_id: hazardId, error: 'Impossible de vérifier le danger.' });
        console.error('[haccp] Échec de vérification de danger pour le brouillon CCP :', hazardError.message);
        continue;
      }
      if (!hazard || hazard.step?.plan?.id !== plan.id) {
        failed.push({ hazard_id: hazardId, error: 'Danger introuvable dans ce plan.' });
        continue;
      }
      const canManage = await canManageHaccpCategory(req, plan.category_id);
      if (!canManage) {
        failed.push({ hazard_id: hazardId, error: 'Vous ne pouvez pas gérer les contrôles de cette catégorie.' });
        continue;
      }

      const decisionJustification = String(proposal.justification).trim();
      const { data, error } = await createCcpDraftAtomically({
        tenantId: req.tenantId,
        hazardId,
        decisionJustification,
        payload: { ...ccpPayloadFromBody(proposal), ai_generated: proposal.ai_generated !== false },
      });
      if (error) {
        const mapped = mapCcpRpcError(error);
        failed.push({ hazard_id: hazardId, error: mapped.message });
      } else {
        created.push(data);
      }
    }

    res.status(200).json({ created, errors: failed });
  }
);

function validateDraftProposal(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return 'Proposition invalide.';
  if (typeof proposal.hazard_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposal.hazard_id)) return 'Identifiant de danger invalide.';
  if (!substantiveText(proposal.justification)) return 'La décision CCP doit être justifiée.';
  for (const field of CCP_TEXT_FIELDS) {
    if (proposal[field] !== undefined && proposal[field] !== null && typeof proposal[field] !== 'string') return `Le champ ${field} doit être du texte.`;
  }
  for (const field of ['limit_min', 'limit_max', 'monitoring_interval_hours']) {
    if (!isBlank(proposal[field]) && !Number.isFinite(Number(proposal[field]))) return `Le champ ${field} doit être numérique.`;
  }
  if (!isBlank(proposal.monitoring_interval_hours) && (Number(proposal.monitoring_interval_hours) <= 0 || Number(proposal.monitoring_interval_hours) > 8760)) {
    return 'L’intervalle de surveillance doit être entre 0 et 8760 heures.';
  }
  if (proposal.limit_min !== undefined && proposal.limit_max !== undefined && !isBlank(proposal.limit_min) && !isBlank(proposal.limit_max) && Number(proposal.limit_min) > Number(proposal.limit_max)) {
    return LIMITS_ORDER_ERROR;
  }
  if (proposal.monitoring_responsible && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposal.monitoring_responsible)) return 'Responsable invalide.';
  if (proposal.ai_generated !== undefined && typeof proposal.ai_generated !== 'boolean') return 'Valeur ai_generated invalide.';
  return null;
}

// POST /api/haccp/hazards/:hazardId/ccps — creates a draft only after an explicit CCP control decision.
router.post(
  '/hazards/:hazardId/ccps',
  requireRole('admin', 'manager'),
  [
    body('ccp_number').optional({ values: 'falsy' }).trim(),
    body('critical_limits').optional({ nullable: true }).isString().trim(),
    body('monitoring_procedure').optional({ nullable: true }).isString().trim(),
    body('monitoring_frequency').optional({ values: 'falsy' }).trim(),
    body('monitoring_responsible').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('corrective_action_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_procedure').optional({ values: 'falsy' }).trim(),
    body('verification_frequency').optional({ values: 'falsy' }).trim(),
    body('record_keeping_procedure').optional({ values: 'falsy' }).trim(),
    body('ai_generated').optional().isBoolean().withMessage('Valeur ai_generated invalide.'),
    ...CCP_NUMERIC_VALIDATORS,
  ],
  async (req, res) => {
    const { data: hazard, error: fetchError } = await supabase
      .from('haccp_hazards')
      .select('id, control_type, decision_justification, step:haccp_process_steps(plan:haccp_plans(category_id))')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.hazardId)
      .single();

    if (fetchError || !hazard) {
      return res.status(404).json({ error: 'Danger introuvable.' });
    }
    if (hazard.control_type !== 'ccp' || !substantiveText(hazard.decision_justification)) {
      return res.status(400).json({ error: 'Enregistrez d’abord une décision de maîtrise CCP explicitement justifiée pour ce danger.' });
    }
    const canManage = await canManageHaccpCategory(req, hazard.step?.plan?.category_id);
    if (!canManage) return res.status(404).json({ error: 'Danger introuvable.' });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const numeric = ccpNumericUpdate(req.body);
    if (numeric.limit_min !== null && numeric.limit_min !== undefined && numeric.limit_max !== null && numeric.limit_max !== undefined && numeric.limit_min > numeric.limit_max) {
      return res.status(400).json({ error: LIMITS_ORDER_ERROR });
    }

    const payload = { ...ccpPayloadFromBody(req.body), ...numeric };
    const { data, error } = await createCcpDraftAtomically({
      tenantId: req.tenantId,
      hazardId: hazard.id,
      decisionJustification: hazard.decision_justification,
      payload,
    });

    if (error) {
      const mapped = mapCcpRpcError(error);
      return res.status(mapped.status).json({ error: mapped.message });
    }

    res.status(201).json(data);
  }
);

router.post(
  '/ccps/:id/approve',
  requireRole('admin', 'manager'),
  [
    body('validation_source').optional().isString().trim().isLength({ min: 5, max: 1000 }).withMessage('La source de validation doit être précisée.'),
    body('validation_evidence').optional().isString().trim().isLength({ min: 20, max: 5000 }).withMessage('Les preuves de validation doivent être substantielles.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Données invalides.', details: errors.array() });

    const { data: ccp, error: fetchError } = await supabase
      .from('haccp_ccps')
      .select('*, hazard:haccp_hazards(step:haccp_process_steps(plan:haccp_plans(category_id)))')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (fetchError) return res.status(500).json({ error: 'Impossible de vérifier le CCP.' });
    if (!ccp) return res.status(404).json({ error: 'Point critique introuvable.' });
    if (!(await canManageHaccpCategory(req, ccp.hazard?.step?.plan?.category_id))) {
      return res.status(404).json({ error: 'Point critique introuvable.' });
    }
    if (ccp.status !== 'draft') return res.status(409).json({ error: ccp.status === 'legacy' ? 'Un CCP historique conserve son statut legacy ; aucune approbation rétroactive n’est inventée.' : 'Ce CCP est déjà approuvé.' });

    const validationSource = req.body.validation_source ?? ccp.validation_source;
    const validationEvidence = req.body.validation_evidence ?? ccp.validation_evidence;
    const issues = ccpApprovalErrors({ ...ccp, validation_source: validationSource, validation_evidence: validationEvidence });
    if (issues.length > 0) return res.status(400).json({ error: 'Le CCP ne peut pas être approuvé.', details: issues });

    const { data: responsible, error: responsibleError } = await supabase
      .from('users')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', ccp.monitoring_responsible)
      .maybeSingle();
    if (responsibleError) return res.status(500).json({ error: 'Impossible de vérifier le responsable de surveillance.' });
    if (!responsible) return res.status(400).json({ error: 'Le responsable de surveillance doit appartenir à cette entreprise.' });

    const { data, error } = await supabase
      .from('haccp_ccps')
      .update({
        status: 'approved',
        validation_source: validationSource.trim(),
        validation_evidence: validationEvidence.trim(),
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('tenant_id', req.tenantId)
      .eq('id', ccp.id)
      .eq('status', 'draft')
      .select('*, monitoring_responsible_user:users!haccp_ccps_monitoring_responsible_fkey(id, full_name)')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'Erreur lors de l’approbation du CCP.' });
    if (!data) return res.status(409).json({ error: 'Le statut du CCP a changé ; rechargez-le avant de réessayer.' });
    res.json(data);
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
    body('validation_source').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('validation_evidence').optional({ nullable: true }).isString().trim().isLength({ max: 5000 }),
    ...CCP_NUMERIC_VALIDATORS,
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: current, error: currentError } = await supabase
      .from('haccp_ccps')
      .select('id, status, limit_min, limit_max, hazard:haccp_hazards(step:haccp_process_steps(plan:haccp_plans(category_id)))')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (currentError) return res.status(500).json({ error: 'Impossible de vérifier le point critique.' });
    if (!current) return res.status(404).json({ error: 'Point critique introuvable.' });
    if (!(await canManageHaccpCategory(req, current.hazard?.step?.plan?.category_id))) {
      return res.status(404).json({ error: 'Point critique introuvable.' });
    }

    const update = { ...ccpNumericUpdate(req.body) };
    for (const field of [
      'ccp_number',
      'critical_limits',
      'monitoring_procedure',
      'monitoring_frequency',
      'corrective_action_procedure',
      'verification_procedure',
      'verification_frequency',
      'record_keeping_procedure',
      'validation_source',
      'validation_evidence',
    ]) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('monitoring_responsible' in req.body) update.monitoring_responsible = req.body.monitoring_responsible || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // L'ordre des bornes se vérifie sur le résultat final (une seule borne peut changer dans cette requête).
    if ('limit_min' in update || 'limit_max' in update) {
      const min = 'limit_min' in update ? update.limit_min : current?.limit_min;
      const max = 'limit_max' in update ? update.limit_max : current?.limit_max;
      if (min !== null && min !== undefined && max !== null && max !== undefined && Number(min) > Number(max)) {
        return res.status(400).json({ error: LIMITS_ORDER_ERROR });
      }
    }
    const reapprovalRequired = CCP_OPERATIONAL_STATUSES.includes(current.status);
    if (reapprovalRequired) {
      Object.assign(update, {
        status: 'draft',
        validation_source: update.validation_source ?? null,
        validation_evidence: update.validation_evidence ?? null,
        approved_by: null,
        approved_at: null,
      });
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

    res.json({ ...data, reapproval_required: reapprovalRequired });
  }
);

router.delete('/ccps/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { data: current, error: currentError } = await supabase
    .from('haccp_ccps')
    .select('id, hazard:haccp_hazards(step:haccp_process_steps(plan:haccp_plans(category_id)))')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (currentError) return res.status(500).json({ error: 'Impossible de vérifier le point critique.' });
  if (!current || !(await canManageHaccpCategory(req, current.hazard?.step?.plan?.category_id))) {
    return res.status(404).json({ error: 'Point critique introuvable.' });
  }
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
    body('recorded_value').optional().isString().trim(),
    body('numeric_value').optional().custom((value) => isBlank(value) || Number.isFinite(Number(value))).withMessage('Valeur numérique invalide.'),
    body('within_limits').optional().isBoolean().withMessage('Valeur invalide.').toBoolean(),
    body('corrective_action_taken').optional({ values: 'falsy' }).trim(),
    body('lot_reference').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }),
    body('product_disposition').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
    body('disposition_decision').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
    body('return_to_control').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
    body('effectiveness_verification').optional({ values: 'falsy' }).isString().trim().isLength({ max: 2000 }),
  ],
  async (req, res) => {
    const { data: ccp, error: fetchError } = await supabase
      .from('haccp_ccps')
      .select('id, status, ccp_number, limit_min, limit_max, limit_unit, monitoring_responsible, hazard:haccp_hazards(step:haccp_process_steps(plan:haccp_plans(id, title, created_by)))')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.ccpId)
      .single();

    if (fetchError || !ccp) {
      return res.status(404).json({ error: 'Point critique introuvable.' });
    }
    if (!CCP_OPERATIONAL_STATUSES.includes(ccp.status)) {
      return res.status(409).json({ error: 'Ce CCP est un brouillon et ne peut pas recevoir de relevés de surveillance.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }

    // Verdict : avec des limites chiffrées, c'est la valeur numérique qui décide (jamais le client) ; sinon le
    // verdict saisi fait foi. Voir evaluateReading.
    const reading = evaluateReading(ccp, { ...req.body, within_limits: 'within_limits' in req.body ? req.body.within_limits : undefined });
    if (reading.error) {
      return res.status(400).json({ error: reading.error });
    }

    // Principe 5 de la méthode HACCP : une dérive constatée (within_limits = false) doit être
    // accompagnée d'une action corrective — sinon le relevé n'a aucune valeur de preuve.
    if (reading.withinLimits === false && !req.body.corrective_action_taken) {
      return res.status(400).json({
        error: 'Une dérive hors limites doit être accompagnée de l’action corrective immédiate prise.',
      });
    }
    if (reading.withinLimits === false && ccp.status === 'approved') {
      const driftFields = {
        lot_reference: 'la référence du lot',
        product_disposition: 'la décision sur le produit concerné',
        disposition_decision: 'la décision de traitement du lot',
        return_to_control: 'le retour à la maîtrise',
        effectiveness_verification: 'la vérification de l’efficacité des mesures',
      };
      const missing = Object.entries(driftFields)
        .filter(([field]) => !substantiveText(req.body[field]))
        .map(([, label]) => label);
      if (missing.length > 0) {
        return res.status(400).json({ error: `Pour une dérive sur un CCP approuvé, renseignez ${missing.join(', ')}.` });
      }
    }

    const { data, error } = await supabase
      .from('haccp_monitoring_logs')
      .insert({
        tenant_id: req.tenantId,
        ccp_id: ccp.id,
        recorded_value: reading.recordedValue,
        numeric_value: reading.numericValue,
        within_limits: reading.withinLimits,
        corrective_action_taken: req.body.corrective_action_taken || null,
        lot_reference: req.body.lot_reference || null,
        product_disposition: req.body.product_disposition || null,
        disposition_decision: req.body.disposition_decision || null,
        return_to_control: req.body.return_to_control || null,
        effectiveness_verification: req.body.effectiveness_verification || null,
        recorded_by: req.user.id,
      })
      .select('*, recorded_by_user:users!haccp_monitoring_logs_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la saisie du relevé.' });
    }

    // Dérives répétées : ce relevé est hors limites et le CCP en compte désormais trop sur la semaine.
    let repeated = null;
    if (!data.within_limits) {
      const { data: recent } = await supabase
        .from('haccp_monitoring_logs')
        .select('within_limits, recorded_at')
        .eq('tenant_id', req.tenantId)
        .eq('ccp_id', ccp.id)
        .order('recorded_at', { ascending: false })
        .limit(50);
      if (hasRepeatedDeviation(recent || [])) {
        repeated = { count: countRecentDeviations(recent || []) };
        notifyRepeatedDeviation(req.tenantId, ccp, repeated.count).catch((err) => console.error('[haccp] Échec de la notification de dérives répétées :', err.message));
      }
    }

    res.status(201).json({ ...data, repeated_deviation: repeated });
  }
);

// Prévient le responsable du CCP et l'auteur du plan (une notification par personne et par jour) : plusieurs
// relevés hors limites en peu de temps, une action corrective immédiate ne suffit plus — une CAPA ou un risque s'impose.
async function notifyRepeatedDeviation(tenantId, ccp, count) {
  const plan = ccp.hazard?.step?.plan;
  const recipients = [...new Set([ccp.monitoring_responsible, plan?.created_by].filter(Boolean))];
  const label = ccp.ccp_number ? `CCP ${ccp.ccp_number}` : 'un point critique';
  for (const userId of recipients) {
    await sendImmediateNotification({
      tenantId,
      userId,
      prefField: 'email_haccp_alerts',
      notificationType: 'haccp_repeated_deviation',
      referenceId: ccp.id,
      templateName: 'haccpAlert',
      subject: `HACCP : ${count} dérives en 7 jours — ${label}`,
      variables: {
        heading: 'Dérives répétées sur un point critique',
        message: `${label} (plan « ${plan?.title || ''} ») a enregistré ${count} relevés hors limites ces 7 derniers jours. Une CAPA ou un risque est à ouvrir pour traiter la cause.`,
        buttonLabel: 'Voir le plan HACCP',
        url: `${process.env.FRONTEND_URL}/haccp/${plan?.id || ''}`,
      },
      notificationTitle: 'Dérives HACCP répétées',
      notificationMessage: `${label} : ${count} relevés hors limites en 7 jours`,
      notificationLink: `/haccp/${plan?.id || ''}`,
    });
  }
}

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
  const operationalCcpIds = assembled.flatMap((plan) =>
    plan.steps.flatMap((step) => step.hazards.map((hazard) => hazard.ccp).filter((ccp) => ccp && CCP_OPERATIONAL_STATUSES.includes(ccp.status)).map((ccp) => ccp.id))
  );
  const monitoringSummaryByCcpId = await computeMonitoringSummaryByCcpId(tenantId, operationalCcpIds);

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

// --- Relevés du jour, synthèse et fiches d'un CCP -------------------------------------------

const viewerOf = (req) => ({ userId: req.user.id, userRole: req.userRole });

// Plan du tenant que l'utilisateur peut voir (catégorie restreinte incluse) — `null` sinon.
async function findVisiblePlan(req, planId = req.params.id) {
  const plan = await loadPlanForTenant(req.tenantId, planId);
  if (!plan) return null;
  const allowed = await hasGenericCategoryPermission({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, categoryId: plan.category_id, permission: 'view' });
  return allowed ? plan : null;
}

// CCP (avec son état de surveillance) dont le plan est visible par l'utilisateur — `null` sinon.
async function findVisibleCcp(req, ccpId = req.params.ccpId) {
  const [ccp] = await fetchCcpStatuses(req.tenantId, { ccpIds: [ccpId] });
  if (!ccp) return null;
  const [visible] = await filterViewableByCategory({ ...viewerOf(req), items: [{ ...ccp, category_id: ccp.plan.category_id, category: ccp.plan.category }] });
  return visible ? ccp : null;
}

const STATE_RANK = { overdue: 0, due_soon: 1, ok: 2, no_schedule: 3 };

// GET /api/haccp/monitoring-due — les CCP des plans ACTIFS, du plus en retard au moins urgent : la liste de travail
// « Relevés du jour ». Ouverte à tout rôle (ce sont les opérateurs terrain qui relèvent), limitée aux plans visibles.
router.get('/monitoring-due', async (req, res) => {
  let ccps;
  try {
    ccps = await fetchCcpStatuses(req.tenantId, { activeOnly: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const visible = await filterViewableByCategory({ ...viewerOf(req), items: ccps.map((ccp) => ({ ...ccp, category_id: ccp.plan.category_id, category: ccp.plan.category })) });

  const items = visible
    .map((ccp) => ({
      id: ccp.id,
      ccp_number: ccp.ccp_number,
      status: ccp.status,
      plan: { id: ccp.plan.id, title: ccp.plan.title },
      step_name: ccp.step_name,
      hazard_description: ccp.hazard_description,
      critical_limits: ccp.critical_limits,
      limits: ccp.limits,
      limits_text: ccp.limits_text,
      monitoring_procedure: ccp.monitoring_procedure,
      monitoring_frequency: ccp.monitoring_frequency,
      monitoring_interval_hours: ccp.monitoring_interval_hours === null ? null : Number(ccp.monitoring_interval_hours),
      responsible: ccp.monitoring_responsible_user || null,
      is_mine: ccp.monitoring_responsible === req.user.id,
      monitoring_state: ccp.monitoring_state,
      due_at: ccp.due_at,
      overdue_hours: ccp.overdue_hours,
      last_reading: ccp.last_reading,
      recent_deviations: ccp.recent_deviations,
      repeated_deviation: ccp.repeated_deviation,
    }))
    .sort((a, b) => STATE_RANK[a.monitoring_state] - STATE_RANK[b.monitoring_state] || Number(b.is_mine) - Number(a.is_mine) || b.overdue_hours - a.overdue_hours);

  res.json({
    items,
    counts: {
      total: items.length,
      overdue: items.filter((item) => item.monitoring_state === 'overdue').length,
      due_soon: items.filter((item) => item.monitoring_state === 'due_soon').length,
      repeated_deviation: items.filter((item) => item.repeated_deviation).length,
    },
  });
});

function summarizeLogs(logs) {
  const total = logs.length;
  const out = logs.filter((log) => !log.within_limits).length;
  const numbers = logs.map((log) => (log.numeric_value === null || log.numeric_value === undefined ? null : Number(log.numeric_value))).filter((value) => value !== null);
  const round = (value) => Math.round(value * 100) / 100;
  return {
    total,
    within: total - out,
    out,
    conformity_percent: total === 0 ? null : Math.round(((total - out) / total) * 100),
    average: numbers.length ? round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length) : null,
    min: numbers.length ? Math.min(...numbers) : null,
    max: numbers.length ? Math.max(...numbers) : null,
  };
}

function clampDays(raw, fallback = 30) {
  const days = Number(raw);
  return Number.isInteger(days) && days > 0 ? Math.min(days, 365) : fallback;
}

// GET /api/haccp/ccps/:ccpId/monitoring-summary?days=30 — courbe et indicateurs d'un CCP sur la période :
// points (valeur numérique + verdict), limites, taux de conformité, dérives, état du prochain relevé.
router.get('/ccps/:ccpId/monitoring-summary', async (req, res) => {
  const ccp = await findVisibleCcp(req);
  if (!ccp) return res.status(404).json({ error: 'Point critique introuvable.' });

  const days = clampDays(req.query.days);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: logs, error } = await supabase
    .from('haccp_monitoring_logs')
    .select('id, recorded_at, recorded_value, numeric_value, within_limits, corrective_action_taken, linked_capa_id, lot_reference, product_disposition, disposition_decision, return_to_control, effectiveness_verification')
    .eq('tenant_id', req.tenantId)
    .eq('ccp_id', ccp.id)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true })
    .limit(2000);
  if (error) return res.status(500).json({ error: 'Impossible de récupérer les relevés.' });

  res.json({
    ccp_id: ccp.id,
    days,
    limits: ccp.limits,
    limits_text: ccp.limits_text,
    monitoring_state: ccp.monitoring_state,
    due_at: ccp.due_at,
    overdue_hours: ccp.overdue_hours,
    repeated_deviation: ccp.repeated_deviation,
    recent_deviations: ccp.recent_deviations,
    stats: summarizeLogs(logs),
    points: logs.map((log) => ({
      id: log.id,
      recorded_at: log.recorded_at,
      recorded_value: log.recorded_value,
      value: log.numeric_value === null || log.numeric_value === undefined ? null : Number(log.numeric_value),
      within_limits: log.within_limits,
      has_capa: Boolean(log.linked_capa_id),
      lot_reference: log.lot_reference,
      product_disposition: log.product_disposition,
      disposition_decision: log.disposition_decision,
      return_to_control: log.return_to_control,
      effectiveness_verification: log.effectiveness_verification,
    })),
  });
});

async function tenantIdentity(tenantId) {
  const { data: tenant } = await supabase.from('tenants').select('name, logo_url, timezone').eq('id', tenantId).single();
  return { tenantName: tenant?.name, tenantTimezone: tenant?.timezone, tenantLogo: await fetchTenantLogoBuffer(tenant?.logo_url) };
}

const safeFileName = (text) => text.replace(/[^A-Za-z0-9À-ÿ_-]+/g, '_').slice(0, 60);

// GET /api/haccp/ccps/:ccpId/pdf?days=90 — fiche du point critique (définition, synthèse, derniers relevés).
router.get('/ccps/:ccpId/pdf', async (req, res) => {
  const ccp = await findVisibleCcp(req);
  if (!ccp) return res.status(404).json({ error: 'Point critique introuvable.' });

  const days = clampDays(req.query.days, 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data: logs } = await supabase
    .from('haccp_monitoring_logs')
    .select('recorded_at, recorded_value, numeric_value, within_limits, corrective_action_taken, lot_reference, product_disposition, disposition_decision, return_to_control, effectiveness_verification, recorded_by_user:users!haccp_monitoring_logs_recorded_by_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('ccp_id', ccp.id)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: false })
    .limit(500);

  const buffer = await buildHaccpCcpPdf({ ccp, stats: summarizeLogs(logs || []), logs: (logs || []).slice(0, 40), days, ...(await tenantIdentity(req.tenantId)) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`fiche-ccp-${safeFileName(ccp.ccp_number || ccp.hazard_description)}.pdf`)}"`);
  res.send(buffer);
});

// GET /api/haccp/ccps/:ccpId/record-sheet — fiche de relevés vierge à imprimer pour le terrain.
router.get('/ccps/:ccpId/record-sheet', async (req, res) => {
  const ccp = await findVisibleCcp(req);
  if (!ccp) return res.status(404).json({ error: 'Point critique introuvable.' });

  const buffer = await buildHaccpRecordSheetPdf({ ccp, ...(await tenantIdentity(req.tenantId)) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`fiche-releves-${safeFileName(ccp.ccp_number || ccp.hazard_description)}.pdf`)}"`);
  res.send(buffer);
});

// GET /api/haccp/plans/:id/word — l'analyse d'un plan au format Word (mêmes rubriques que le PDF).
router.get('/plans/:id/word', async (req, res) => {
  const plan = await findVisiblePlan(req);
  if (!plan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });

  let assembled, monitoringSummaryByCcpId;
  try {
    ({ assembled, monitoringSummaryByCcpId } = await loadPlansForPdf(req.tenantId, [plan]));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const { tenantName, tenantLogo } = await tenantIdentity(req.tenantId);
  const buffer = await buildHaccpAuditWord({ tenantName, tenantLogo, plans: assembled, monitoringSummaryByCcpId });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(`haccp-${safeFileName(plan.title)}.docx`)}"`);
  res.send(buffer);
});

// --- Revue et versions d'un plan ------------------------------------------------------------

// POST /api/haccp/plans/:id/review — « marquer revu » (revue annuelle / vérification) : enregistre une version du
// plan, trace qui l'a revu et quand, et fixe la prochaine revue.
router.post(
  '/plans/:id/review',
  requireRole('admin', 'manager'),
  [
    body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Le motif ne peut pas dépasser 500 caractères.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    const plan = await findVisiblePlan(req);
    if (!plan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
    if (plan.status === 'archived') return res.status(400).json({ error: 'Un plan archivé ne se revoit pas.' });

    const { data, error } = await supabase
      .from('haccp_plans')
      .update({ last_reviewed_at: new Date().toISOString(), last_reviewed_by: req.user.id, review_date: req.body.next_review_date || addMonthsIso(12) })
      .eq('tenant_id', req.tenantId)
      .eq('id', plan.id)
      .select(PLAN_SELECT)
      .single();
    if (error || !data) return res.status(500).json({ error: 'Erreur lors de la revue du plan.' });

    let revision;
    try {
      revision = await createRevision({ tenantId: req.tenantId, plan: data, kind: 'review', reason: req.body.reason || 'Revue du plan', userId: req.user.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({ plan: data, revision });
  }
);

// POST /api/haccp/plans/:id/revisions — enregistre une version du plan à un moment choisi (avant une modification
// importante, après une évolution du procédé...).
router.post(
  '/plans/:id/revisions',
  requireRole('admin', 'manager'),
  [body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 500 }).withMessage('Le motif ne peut pas dépasser 500 caractères.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    const plan = await findVisiblePlan(req);
    if (!plan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
    try {
      res.status(201).json(await createRevision({ tenantId: req.tenantId, plan, kind: 'manual', reason: req.body.reason, userId: req.user.id }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/haccp/plans/:id/revisions — versions (récentes d'abord) avec leurs changements, et les modifications
// faites depuis la dernière version.
router.get('/plans/:id/revisions', async (req, res) => {
  const plan = await findVisiblePlan(req);
  if (!plan) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  try {
    res.json(await describeRevisions(req.tenantId, plan));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Liens d'un plan (fournisseurs, formations, procédures) ---------------------------------

// GET /api/haccp/link-candidates?kind= — éléments rattachables (id + titre, ceux que l'utilisateur peut voir).
router.get('/link-candidates', requireRole('admin', 'manager'), async (req, res) => {
  if (!HACCP_LINK_KIND_KEYS.includes(req.query.kind)) return res.status(400).json({ error: 'Type de lien invalide.' });
  res.json(await listHaccpLinkCandidates(req.tenantId, req.query.kind, viewerOf(req)));
});

router.get('/plans/:id/links', async (req, res) => {
  if (!(await findVisiblePlan(req))) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  try {
    res.json(await fetchHaccpLinks(req.tenantId, req.params.id, viewerOf(req)));
  } catch {
    res.status(500).json({ error: 'Impossible de récupérer les liens du plan.' });
  }
});

router.post(
  '/plans/:id/links',
  requireRole('admin', 'manager'),
  [body('kind').isIn(HACCP_LINK_KIND_KEYS).withMessage('Type de lien invalide.'), body('ref_id').isUUID().withMessage('Élément invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    if (!(await findVisiblePlan(req))) return res.status(404).json({ error: 'Plan HACCP introuvable.' });

    const { kind, ref_id: refId } = req.body;
    if (!(await findHaccpLinkTarget(req.tenantId, kind, refId, viewerOf(req)))) {
      return res.status(404).json({ error: `${HACCP_LINK_KINDS[kind].label} introuvable.` });
    }
    const { error } = await supabase
      .from('haccp_plan_links')
      .insert({ tenant_id: req.tenantId, plan_id: req.params.id, [HACCP_LINK_KINDS[kind].column]: refId, created_by: req.user.id });
    if (error?.code === '23505') return res.status(409).json({ error: 'Ce lien existe déjà.' });
    if (error) return res.status(500).json({ error: 'Impossible de créer le lien.' });
    res.status(201).json(await fetchHaccpLinks(req.tenantId, req.params.id, viewerOf(req)));
  }
);

router.delete('/plans/:id/links/:linkId', requireRole('admin', 'manager'), async (req, res) => {
  if (!(await findVisiblePlan(req))) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  const { error, count } = await supabase.from('haccp_plan_links').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('plan_id', req.params.id).eq('id', req.params.linkId);
  if (error) return res.status(500).json({ error: 'Impossible de supprimer le lien.' });
  if (!count) return res.status(404).json({ error: 'Lien introuvable.' });
  res.status(204).end();
});

// GET /api/haccp/plans/:id/training-coverage — les responsables de surveillance ont-ils les formations liées au
// plan à jour ? (valide / échue / échec / jamais suivie / dispensé)
router.get('/plans/:id/training-coverage', async (req, res) => {
  if (!(await findVisiblePlan(req))) return res.status(404).json({ error: 'Plan HACCP introuvable.' });
  try {
    res.json(await fetchTrainingCoverage(req.tenantId, req.params.id, viewerOf(req)));
  } catch {
    res.status(500).json({ error: 'Impossible de vérifier les formations.' });
  }
});

export default router;
