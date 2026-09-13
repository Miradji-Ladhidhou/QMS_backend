import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { requireAuth } from '../middleware/auth.js';
import {
  generateCapaSuggestion,
  generateRiskTreatmentSuggestion,
  generateHaccpSignificanceSuggestion,
  generateHaccpCcpSuggestion,
} from '../services/groq.js';

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

// POST /api/ai/haccp-significance-suggestion — complète la couverture IA du module HACCP aux
// côtés de POST /haccp/plans/:planId/steps/:stepId/hazard-suggestion (identification des
// dangers, AiHazardSuggestion.jsx) : ici, à partir d'un danger déjà décrit dans le formulaire,
// on suggère s'il est significatif (nécessite un CCP) et pourquoi — l'arbre de décision Codex
// Alimentarius appliqué en une fois, voir groq.js. laterSteps (optionnel, [{ name,
// description }], les étapes réellement postérieures dans le plan) n'est pas validé ici : champ
// facultatif, simplement transmis tel quel à generateHaccpSignificanceSuggestion pour que la
// question 4 de l'arbre de décision soit fondée sur des données réelles plutôt que supposée.
// Rien n'est persisté ici non plus.
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
      res.json(suggestion);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
    }
  }
);

// POST /api/ai/haccp-ccp-suggestion — suite logique de la route précédente : une fois un danger
// jugé significatif, suggère les limites critiques et les procédures de surveillance/action
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
