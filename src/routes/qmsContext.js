import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

const VERSION_SELECT = '*, author:users!qms_context_versions_created_by_fkey(id, full_name)';

// GET /api/qms-context — le contexte du SMQ en vigueur (ISO 9001 §4.1-4.3) et son historique.
// Ouvert à tout rôle authentifié — même raisonnement que GET /api/quality-policy : ce n'est
// pas un réglage technique, c'est une information documentée censée rester consultable par
// tout le tenant. Seule sa republication est réservée admin (voir POST /).
router.get('/', async (req, res) => {
  const { data: versions, error } = await supabase
    .from('qms_context_versions')
    .select(VERSION_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le contexte du SMQ.' });
  }

  res.json({ current: versions[0] || null, versions });
});

// POST /api/qms-context — publie une nouvelle version, qui devient immédiatement "en vigueur"
// (la plus récente par created_at) — même principe que POST /api/quality-policy : pas de
// workflow de validation séparé, c'est un exercice de direction porté directement par elle.
// Réservé admin. interested_parties : tableau de { name, requirements }, chaque entrée doit
// avoir un nom non vide (les exigences elles-mêmes restent libres, peuvent être encore à
// préciser au moment de la saisie).
router.post(
  '/',
  requireRole('admin'),
  [
    body('external_issues').optional({ values: 'falsy' }).trim(),
    body('internal_issues').optional({ values: 'falsy' }).trim(),
    body('products_services').optional({ values: 'falsy' }).trim(),
    body('scope_description').optional({ values: 'falsy' }).trim(),
    body('excluded_requirements').optional({ values: 'falsy' }).trim(),
    body('interested_parties')
      .optional()
      .isArray()
      .withMessage('Liste de parties intéressées invalide.')
      .custom((parties) => parties.every((party) => party && typeof party.name === 'string' && party.name.trim() !== ''))
      .withMessage('Chaque partie intéressée doit avoir un nom.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      external_issues: externalIssues,
      internal_issues: internalIssues,
      products_services: productsServices,
      scope_description: scopeDescription,
      excluded_requirements: excludedRequirements,
      interested_parties: interestedParties,
    } = req.body;

    const { data, error } = await supabase
      .from('qms_context_versions')
      .insert({
        tenant_id: req.tenantId,
        external_issues: externalIssues || null,
        internal_issues: internalIssues || null,
        products_services: productsServices || null,
        scope_description: scopeDescription || null,
        excluded_requirements: excludedRequirements || null,
        interested_parties: interestedParties || [],
        created_by: req.user.id,
      })
      .select(VERSION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la publication du contexte du SMQ.' });
    }

    res.status(201).json(data);
  }
);

export default router;
