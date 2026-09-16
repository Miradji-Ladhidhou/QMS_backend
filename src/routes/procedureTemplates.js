import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { DEFAULT_PROCEDURE_SECTIONS } from '../data/defaultProcedureSections.js';
import { buildProcedureWordDocument } from '../services/procedureWord.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const VISUAL_OPTION_BULLET_STYLES = ['dash', 'round'];
const VISUAL_OPTION_CALLOUT_STYLES = ['left-border', 'full-tint'];

// Personnalisation directe par tenant (voir le plan de refonte de la mise en page des
// procédures) — remplace les 4 presets figés (mtl-logistique/iso-generique/moderne-tertiaire/
// industriel-securite). N'accepte QUE ces 3 clés : un objet visual_options avec une clé
// inconnue est rejeté plutôt que silencieusement ignoré, pour éviter qu'un bug frontend écrive
// une clé jamais relue par aucun renderer sans que personne ne s'en aperçoive.
function validateVisualOptions(value) {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Options visuelles invalides.');
  }
  const knownKeys = ['band', 'bulletStyle', 'calloutStyle'];
  const unknownKey = Object.keys(value).find((key) => !knownKeys.includes(key));
  if (unknownKey) throw new Error(`Option visuelle inconnue : ${unknownKey}.`);
  if (value.band !== undefined && typeof value.band !== 'boolean') throw new Error('"band" doit être un booléen.');
  if (value.bulletStyle !== undefined && !VISUAL_OPTION_BULLET_STYLES.includes(value.bulletStyle)) {
    throw new Error('"bulletStyle" invalide.');
  }
  if (value.calloutStyle !== undefined && !VISUAL_OPTION_CALLOUT_STYLES.includes(value.calloutStyle)) {
    throw new Error('"calloutStyle" invalide.');
  }
  return true;
}

const router = Router();

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

// GET /api/procedure-templates — le gabarit du tenant courant. Contrairement à GET /api/tenant,
// pas de ligne par défaut créée automatiquement EN BASE : un tenant qui n'a encore rien
// configuré reçoit un point de départ minimal (DEFAULT_PROCEDURE_SECTIONS, voir
// data/defaultProcedureSections.js — partagé avec routes/procedures.js) mais aucune ligne
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

  res.json(data || { tenant_id: req.tenantId, section_structure: DEFAULT_PROCEDURE_SECTIONS });
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
    body('accent_color').optional({ values: 'falsy' }).matches(HEX_COLOR_REGEX).withMessage('Couleur invalide (format hexadécimal #RRGGBB attendu).'),
    body('visual_options').custom(validateVisualOptions),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const payload = {
      tenant_id: req.tenantId,
      section_structure: req.body.section_structure,
      fixed_instructions: req.body.fixed_instructions || null,
    };
    // Fusion partielle plutôt qu'un remplacement complet : un appel qui n'envoie pas
    // accent_color/visual_options (ancien client, ou un enregistrement qui ne touche que les
    // sections) ne doit jamais réinitialiser la couleur/les options déjà choisies par le tenant.
    // Normalisée en minuscules : un même hex saisi #ABC123 ou #abc123 doit produire la même
    // valeur enregistrée, quelle que soit la casse tapée par l'appelant (<input type="color">
    // du navigateur renvoie toujours du minuscule, mais un appel API direct pourrait ne pas).
    if (req.body.accent_color !== undefined) payload.accent_color = req.body.accent_color.toLowerCase();
    if (req.body.visual_options !== undefined) payload.visual_options = req.body.visual_options;

    const { data, error } = await supabase
      .from('procedure_templates')
      .upsert(payload, { onConflict: 'tenant_id' })
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement du gabarit." });
    }

    res.json(data);
  }
);

// POST /api/procedure-templates/preview-word — aperçu Word du style EN COURS D'ÉDITION, avant
// tout enregistrement (voir ProcedureTemplateSettings.jsx > bouton "Aperçu") : ne lit aucune
// version persistée, construit un contenu générique fixe (un peu de chaque type de bloc, pour
// qu'un seul aperçu exerce tout le système visuel) et applique les réglages REÇUS DANS LE BODY —
// jamais ceux déjà enregistrés en base, conformément au principe "rien n'est appliqué avant
// Enregistrer". Le logo, lui, reste toujours celui actuellement configuré pour le tenant (déjà
// tenant-wide, hors du gabarit de procédure — voir CompanySettings.jsx).
router.post(
  '/preview-word',
  requireRole('admin'),
  [
    body('accent_color').optional({ values: 'falsy' }).matches(HEX_COLOR_REGEX).withMessage('Couleur invalide.'),
    body('visual_options').custom(validateVisualOptions),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
    const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);

    const previewProcedure = { number: 'PROC-000', title: 'Traitement des réclamations clients', process: 'Support client', status: 'draft', next_review_date: null };
    const previewVersion = {
      version: '1.0',
      status: 'draft',
      created_at: new Date().toISOString(),
      author: { full_name: 'Aperçu' },
      validator: null,
      content: {
        sections: [
          {
            key: 'objet',
            label: 'Objectifs de la procédure',
            blocks: [{ type: 'paragraphe', id: 'p1', text: 'Décrire le traitement des réclamations clients, de leur réception à leur clôture.' }],
          },
          {
            key: 'processus',
            label: 'Processus',
            blocks: [
              { type: 'sous_titre', id: 'p2', text: 'Réception de la réclamation' },
              { type: 'paragraphe', id: 'p3', text: '1. Enregistrer la réclamation dans le registre.\n2. Accuser réception auprès du client sous 48h.' },
              { type: 'liste_puces', id: 'p4', items: ['Vérifier la référence commande', "Vérifier l'identité du client"] },
              {
                type: 'tableau',
                id: 'p5',
                headers: ['Étape', 'Délai', 'Responsable'],
                rows: [
                  ['Accusé de réception', '48h', 'Service client'],
                  ['Analyse', '5 jours', 'Qualité'],
                ],
              },
              { type: 'encadre', id: 'p6', text: 'Toute réclamation liée à la sécurité du produit doit être escaladée immédiatement.' },
            ],
          },
        ],
        documents_associes: ['Registre des réclamations'],
      },
    };

    let docxBuffer;
    try {
      docxBuffer = await buildProcedureWordDocument({
        accentColor: req.body.accent_color,
        visualOptions: req.body.visual_options,
        tenantLogo,
        tenantName: tenant?.name,
        procedure: previewProcedure,
        version: previewVersion,
        versions: [previewVersion],
      });
    } catch (err) {
      console.error("Échec de la génération de l'aperçu Word :", err);
      return res.status(500).json({ error: "Impossible de générer l'aperçu." });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="apercu-gabarit-procedures.docx"');
    res.send(docxBuffer);
  }
);

// L'ancien système de 4 presets figés (GET /presets, POST /apply-preset,
// data/procedureTemplatePresets.js) a été retiré avec ce chantier — remplacé par la
// personnalisation directe ci-dessus (accent_color/visual_options). Les tenants qui avaient
// encore un preset actif ont été basculés par
// backend/scripts/migrate-procedure-template-presets-to-custom.mjs, à exécuter une fois en
// production dans le même déploiement que cette route (voir le plan de refonte de la mise en
// page des procédures).

export default router;
