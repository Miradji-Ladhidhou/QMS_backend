import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  generateCapaSuggestion,
  generateRiskTreatmentSuggestion,
  generateHaccpSignificanceSuggestion,
  generateHaccpCcpSuggestion,
  generateHaccpSurveillanceSuggestion,
  logAiFailure,
  generateProblemGuideRecommendations,
} from '../services/groq.js';
import { validateHaccpAiSuggestions } from '../services/haccpAiValidation.js';
import { prepareAiResult, aiResultRoute } from '../services/aiGenerations.js';
import { supabase } from '../services/supabase.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { attachAiQuota } from '../services/aiQuota.js';
import { getRequestContext } from '../services/requestContext.js';
import { mergeGuideSearch, prepareProblemGuideSearch, validateProblemGuideResponse } from '../services/problemGuide.js';

const router = Router();

router.use(requireAuth);

router.post('/problem-guide-search',
  body('query').isString().bail().trim().isLength({ min: 3, max: 1200 }),
  async (req, res) => {
    if (!validationResult(req).isEmpty()) {
      return res.status(400).json({ error: 'Décrivez le problème avec 3 à 1200 caractères.' });
    }
    try {
      const getMenus = () => getVisibleMenuKeys({
        tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole,
      });
      const search = prepareProblemGuideSearch(req.body.query, await getMenus());
      if (!search.needsFallback) {
        return res.json({ recommendations: mergeGuideSearch(search.local, [], search.access) });
      }
      if (!(await attachAiQuota(req, res))) return;
      getRequestContext().aiQuotaActionId = req.aiQuotaActionId;
      const result = await generateProblemGuideRecommendations(req.body.query, search.modules);
      const remote = validateProblemGuideResponse(result, search.modules);
      // Les droits peuvent avoir changé pendant l'appel au fournisseur.
      const currentAccess = { visibleMenuKeys: [...await getMenus()] };
      res.json({ recommendations: mergeGuideSearch(search.local, remote, currentAccess) });
    } catch (error) {
      console.error('[guide résolution] recherche impossible :', error.message);
      await logAiFailure('problem_guide', 'search_failure', error.message);
      res.status(503).json({ error: 'La recherche est temporairement indisponible. Veuillez réessayer.' });
    }
  },
);

router.get('/drafts', async (req, res) => {
  const modules = {
    '/ai/capa-suggestion': 'capas',
    '/risks/service-suggestion': 'risks',
    '/procedures/generate-draft': 'procedures',
  };
  const module = Object.hasOwn(modules, req.query.endpoint) ? modules[req.query.endpoint] : null;
  if (!module) return res.status(400).json({ error: 'Type de brouillon IA invalide.' });
  if (module === 'risks' && !['admin', 'manager'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }
  const menus = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  if (!menus.has(module)) return res.status(403).json({ error: 'Accès non autorisé.' });
  let query = supabase.from('ai_generations').select('id, input, result, origin, created_at')
    .eq('tenant_id', req.tenantId).eq('user_id', req.user.id)
    .eq('endpoint', `/api${req.query.endpoint}`).eq('status', 'completed');
  if (module === 'capas') query = query.is('input->source', null);
  if (req.query.service) query = query.contains('input', { service_name: req.query.service });
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.error('[IA] reprise du brouillon :', error.message);
    return res.status(503).json({ error: 'Impossible de retrouver le brouillon IA enregistré.' });
  }
  res.json({ draft: data });
});

// POST /api/ai/capa-suggestion — point d'entrée IA partagé par tous les flux "créer une CAPA
// depuis X". La proposition personnelle est persistée avant réponse ; son application
// reste soumise aux permissions de création CAPA de chaque module.
aiResultRoute(router,
  '/capa-suggestion',
  [body('context').trim().isLength({ min: 10 }).withMessage('Contexte trop court pour générer une suggestion.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      if (!(await prepareAiResult(req, res))) return;
      const suggestion = await generateCapaSuggestion(req.body.context);
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

// POST /api/ai/risk-treatment-suggestion — complète la couverture IA du registre des risques
// (identification/analyse déjà couvertes par POST /risks/service-suggestion,
// AiRiskSuggestion.jsx) : ici, à partir d'un risque déjà identifié, on suggère son plan de
// traitement et son évaluation résiduelle (AiRiskTreatmentSuggestion.jsx, monté dans
// EditRiskModal côté RiskDetail.jsx). La proposition est conservée indépendamment du risque.
aiResultRoute(router,
  '/risk-treatment-suggestion',
  [
    body('title').trim().notEmpty().withMessage('Titre requis.'),
    body('type').optional({ values: 'falsy' }).isIn(['risk', 'opportunity']).withMessage('Type invalide.'),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide.'),
    body('impact').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      if (!['admin', 'manager'].includes(req.userRole)) return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
      if (!(await prepareAiResult(req, res))) return;
      const suggestion = await generateRiskTreatmentSuggestion(req.body);
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

const HAZARD_TYPES = ['biological', 'chemical', 'physical', 'allergen'];
const HAZARD_CONTROL_TYPES = ['undetermined', 'prp', 'ccp', 'process_change'];

// POST /api/ai/haccp-surveillance-suggestion — analyse les dangers existants, applique l'arbre
// Codex et propose une surveillance de routine ou un CCP prérempli. La proposition est
// conservée sans mettre en service les CCP ; seuls les gestionnaires peuvent la générer.
aiResultRoute(router,
  '/haccp-surveillance-suggestion',
  requireRole('admin', 'manager'),
  [
    body('planId').optional().isUUID(),
    body('planTitle').trim().notEmpty().isLength({ max: 200 }).withMessage('Titre du plan invalide.'),
    body('productDescription').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    body('scope').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    body('steps')
      .isArray({ min: 1, max: 50 })
      .withMessage('Étapes du plan invalides.')
      .bail()
      .custom((steps) => {
        const hazardCount = steps.reduce((total, step) => total + (Array.isArray(step.hazards) ? step.hazards.length : 0), 0);
        return hazardCount > 0 && hazardCount <= 50;
      })
      .withMessage('Le plan doit contenir entre 1 et 50 dangers.'),
    body('steps.*.name').trim().notEmpty().isLength({ max: 200 }),
    body('steps.*.description').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    body('steps.*.hazards').isArray({ max: 50 }),
    body('steps.*.hazards.*.id').isUUID(),
    body('steps.*.hazards.*.hazard_type').isIn(HAZARD_TYPES),
    body('steps.*.hazards.*.description').trim().notEmpty().isLength({ max: 1000 }),
    body('steps.*.hazards.*.existing_controls').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    body('steps.*.hazards.*.likelihood').isInt({ min: 1, max: 5 }),
    body('steps.*.hazards.*.severity').isInt({ min: 1, max: 5 }),
    body('steps.*.hazards.*.is_significant').isBoolean(),
    body('steps.*.hazards.*.justification').optional({ values: 'falsy' }).isString().isLength({ max: 1000 }),
    body('steps.*.hazards.*.has_ccp').isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      const hazardIds = req.body.steps.flatMap((step) => step.hazards.map((hazard) => hazard.id));
      const { data: ownedHazards, error: ownershipError } = await supabase.from('haccp_hazards')
        .select('id, step_id').eq('tenant_id', req.tenantId).in('id', hazardIds);
      if (ownershipError) throw new Error('Impossible de vérifier les dangers du plan.');
      if (ownedHazards.length !== new Set(hazardIds).size) return res.status(404).json({ error: 'Danger HACCP introuvable.' });
      if (req.body.planId) {
        const stepIds = [...new Set(ownedHazards.map((hazard) => hazard.step_id))];
        const { data: planSteps, error: planError } = await supabase.from('haccp_process_steps').select('id')
          .eq('tenant_id', req.tenantId).eq('plan_id', req.body.planId).in('id', stepIds);
        if (planError) throw new Error('Impossible de vérifier les étapes du plan.');
        if (planSteps.length !== stepIds.length) return res.status(404).json({ error: 'Danger HACCP étranger au plan.' });
      }
      if (!(await prepareAiResult(req, res))) return;
      let suggestion = await generateHaccpSurveillanceSuggestion(req.body);
      let validation = validateHaccpAiSuggestions(suggestion, hazardIds);
      if (validation.issues.length) {
        console.error('[haccp IA] réponse rejetée :', validation.issues);
        await logAiFailure('haccp_surveillance', 'invalid_contract', validation.issues.join('; '));
        suggestion = await generateHaccpSurveillanceSuggestion(req.body, validation.issues);
        validation = validateHaccpAiSuggestions(suggestion, hazardIds);
      }
      if (validation.issues.length) {
        console.error('[haccp IA] nouvelle réponse rejetée :', validation.issues);
        await logAiFailure('haccp_surveillance', 'invalid_contract', validation.issues.join('; '));
        return res.status(503).json({ error: "L'analyse IA n'a pas fourni une proposition exploitable pour chaque danger. Veuillez réessayer." });
      }
      const validatedSuggestions = validation.suggestions;
      const proposals = validatedSuggestions
        .filter((item) => item.control_type === 'ccp')
        .map((item) => ({
          hazard_id: item.hazard_id,
          justification: item.decision_justification,
          ...Object.fromEntries([
            'ccp_number',
            'critical_limits',
            'monitoring_procedure',
            'monitoring_frequency',
            'monitoring_responsible',
            'corrective_action_procedure',
            'verification_procedure',
            'verification_frequency',
            'record_keeping_procedure',
            'limit_min',
            'limit_max',
            'limit_unit',
            'monitoring_interval_hours',
          ].filter((field) => field in item).map((field) => [field, item[field]])),
          ai_generated: true,
        }));
      res.json({ ...suggestion, suggestions: validatedSuggestions, proposals });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer des propositions de surveillance : ${err.message}` });
    }
  }
);

// POST /api/ai/haccp-significance-suggestion — complète la couverture IA du module HACCP aux
// côtés de POST /haccp/plans/:planId/steps/:stepId/hazard-suggestion (identification des
// dangers, AiHazardSuggestion.jsx) : ici, à partir d'un danger déjà décrit, on suggère
// indépendamment la significativité du risque et la décision de maîtrise.
aiResultRoute(router,
  '/haccp-significance-suggestion',
  [
    body('hazardType').isIn(HAZARD_TYPES).withMessage('Type de danger invalide.'),
    body('description').trim().notEmpty().withMessage('Description requise.'),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide.'),
    body('severity').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      if (!['admin', 'manager'].includes(req.userRole)) return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
      if (!(await prepareAiResult(req, res))) return;
      const suggestion = await generateHaccpSignificanceSuggestion(req.body);
      if (
        !suggestion ||
        typeof suggestion.is_significant !== 'boolean' ||
        !HAZARD_CONTROL_TYPES.includes(suggestion.control_type) ||
        typeof suggestion.justification !== 'string' ||
        suggestion.justification.trim().length < 8 ||
        typeof suggestion.decision_justification !== 'string' ||
        suggestion.decision_justification.trim().length < 8
      ) throw new Error('La réponse IA ne contient pas une analyse du risque et une décision de maîtrise valides.');
      res.json({
        is_significant: suggestion.is_significant,
        control_type: suggestion.control_type,
        justification: suggestion.justification,
        decision_justification: suggestion.decision_justification,
      });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

// POST /api/ai/haccp-ccp-suggestion — après une décision de maîtrise CCP explicite, suggère
// les limites critiques et les procédures de surveillance/action
// corrective/vérification/enregistrement de son point critique (CCP).
aiResultRoute(router,
  '/haccp-ccp-suggestion',
  [
    body('stepName').optional().isString().trim().isLength({ max: 500 }).withMessage('Étape du procédé invalide.'),
    body('hazardType').isIn(HAZARD_TYPES).withMessage('Type de danger invalide.'),
    body('description').trim().notEmpty().withMessage('Description requise.'),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide.'),
    body('severity').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
      if (!['admin', 'manager'].includes(req.userRole)) return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
      if (!(await prepareAiResult(req, res))) return;
      const suggestion = await generateHaccpCcpSuggestion(req.body);
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

export default router;
