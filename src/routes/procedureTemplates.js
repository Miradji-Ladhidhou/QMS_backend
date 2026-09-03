import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';

const router = Router();

// Une procédure sans AUCUNE section de gabarit n'a que 3 champs génériques (Objet/Domaine
// d'application/Responsabilités) — jamais le déroulé réel du processus, l'élément qui fait
// qu'une procédure est utilisable (voir la définition qualité donnée par l'utilisateur : "les
// étapes, le déroulement séquentiel des actions à mener"). Point de départ minimal proposé
// par défaut tant qu'un tenant n'a rien configuré — jamais persisté en base tant que personne
// n'appuie sur Enregistrer (voir PUT ci-dessous), donc toujours librement renommable/
// supprimable, pas une contrainte imposée.
const DEFAULT_SECTION_STRUCTURE = [{ key: 'etapes', label: 'Étapes du processus' }];

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

// GET /api/procedure-templates — le gabarit du tenant courant. Contrairement à GET /api/tenant,
// pas de ligne par défaut créée automatiquement EN BASE : un tenant qui n'a encore rien
// configuré reçoit un point de départ minimal (DEFAULT_SECTION_STRUCTURE) mais aucune ligne
// fantôme n'est jamais écrite tant que personne n'a explicitement enregistré (PUT).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('procedure_templates')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le gabarit.' });
  }

  res.json(data || { tenant_id: req.tenantId, section_structure: DEFAULT_SECTION_STRUCTURE });
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
