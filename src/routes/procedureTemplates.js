import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';

const router = Router();

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

// GET /api/procedure-templates — le gabarit du tenant courant. Contrairement à GET /api/tenant,
// pas de ligne par défaut créée automatiquement en base : un tenant qui n'a encore rien
// configuré reçoit simplement une structure vide (le frontend affiche alors le formulaire de
// configuration, jamais une ligne fantôme en base tant que personne n'a rien enregistré).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('procedure_templates')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le gabarit.' });
  }

  res.json(data || { tenant_id: req.tenantId, section_structure: [] });
});

// PUT /api/procedure-templates — remplace le gabarit du tenant courant (upsert : première
// configuration ou mise à jour, une seule ligne par tenant grâce à la contrainte unique sur
// tenant_id). Réservé admin, comme la gestion des catégories (POST /api/categories) — une
// configuration structurelle partagée par tout le tenant, pas une action de workflow qualité
// au cas par cas comme la validation d'une procédure (admin/manager).
router.put(
  '/',
  requireRole('admin'),
  [body('section_structure').isArray().withMessage('Structure de sections invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('procedure_templates')
      .upsert(
        { tenant_id: req.tenantId, section_structure: req.body.section_structure },
        { onConflict: 'tenant_id' }
      )
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement du gabarit." });
    }

    res.json(data);
  }
);

export default router;
