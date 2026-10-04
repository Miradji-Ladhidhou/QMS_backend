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
} from '../services/groq.js';
import { validateHaccpAiSuggestions } from '../services/haccpAiValidation.js';

const router = Router();

router.use(requireAuth);

// POST /api/ai/capa-suggestion — point d'entrée IA partagé par tous les flux "créer une CAPA
// depuis X" (audits, revues de direction, réclamations, risques, évaluations fournisseur —
// voir chaque CreateCapaFromXModal côté frontend). Contrairement à QQOQCCP (POST
// /qqoqccp/:id/generate), rien n'est persisté en base ici : le contexte tient déjà entier
// dans la requête (la page appelante a déjà l'enregistrement source chargé), et la
// suggestion ne sert qu'à préremplir un formulaire de création le temps de la session —
// pas un besoin de la retrouver plus tard comme pour l'analyse QQOQCCP elle-même.
// Aucune restriction de rôle ici : le bouton qui déclenche cet appel n'est déjà visible que
// pour les rôles autorisés à créer une CAPA depuis l'outil en question (admin/manager sur
// audits/revues/risques/fournisseurs, tous rôles sur QQOQCCP/CAPA directe).
router.post(
  '/capa-suggestion',
  [body('context').trim().isLength({ min: 10 }).withMessage('Contexte trop court pour générer une suggestion.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    try {
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
// EditRiskModal côté RiskDetail.jsx). Rien n'est persisté ici non plus — voir groq.js.
router.post(
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
// Codex et propose une surveillance de routine ou un CCP prérempli. Rien n'est enregistré par
// cet appel; seules les personnes autorisées à gérer le plan peuvent générer ces propositions.
router.post(
  '/haccp-surveillance-suggestion',
  requireRole('admin', 'manager'),
  [
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
// indépendamment la significativité du risque et la décision de maîtrise, sans rien enregistrer.
router.post(
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
// corrective/vérification/enregistrement de son point critique (CCP). Rien n'est persisté ici
// non plus — voir groq.js et AiCcpDefinitionSuggestion.jsx.
router.post(
  '/haccp-ccp-suggestion',
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
      const suggestion = await generateHaccpCcpSuggestion(req.body);
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

export default router;
