import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { PROCEDURE_TEMPLATE_PRESETS, findProcedureTemplatePreset } from '../data/procedureTemplatePresets.js';

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
  [
    body('section_structure').isArray().withMessage('Structure de sections invalide.'),
    body('fixed_instructions').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('procedure_templates')
      .upsert(
        {
          tenant_id: req.tenantId,
          section_structure: req.body.section_structure,
          fixed_instructions: req.body.fixed_instructions || null,
        },
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

// GET /api/procedure-templates/presets — catalogue des 4 points de départ prêts à l'emploi
// (voir data/procedureTemplatePresets.js). Donnée de référence statique, pas de table dédiée :
// même logique que les autres catalogues fixes de l'app.
router.get('/presets', (req, res) => {
  res.json(PROCEDURE_TEMPLATE_PRESETS);
});

// POST /api/procedure-templates/apply-preset — copie un preset dans le gabarit du tenant
// courant : à partir de là c'est une copie normale, librement modifiable/écrasable ensuite par
// PUT ci-dessus, jamais une référence figée vers le preset d'origine. N'affecte que les
// PROCHAINES générations (voir services/groq.js) — les procédures déjà créées gardent leur
// contenu déjà rédigé, jamais réécrit rétroactivement. Réservé admin, même garde que PUT.
router.post(
  '/apply-preset',
  requireRole('admin'),
  [body('preset_id').trim().notEmpty().withMessage('Preset requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const preset = findProcedureTemplatePreset(req.body.preset_id);
    if (!preset) {
      return res.status(404).json({ error: 'Preset introuvable.' });
    }

    const { data, error } = await supabase
      .from('procedure_templates')
      .upsert(
        {
          tenant_id: req.tenantId,
          section_structure: preset.sections,
          fixed_instructions: preset.fixedInstructions,
          render_style: preset.renderStyle,
          active_preset_id: preset.id,
        },
        { onConflict: 'tenant_id' }
      )
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors de l'application du preset." });
    }

    res.json(data);
  }
);

export default router;
