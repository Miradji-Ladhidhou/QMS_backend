import { Router } from 'express';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sanitizeFileName } from '../utils/storagePath.js';

const router = Router();
// Un logo n'a besoin d'être qu'une image matricielle — exclut notamment image/svg+xml : un
// SVG peut embarquer du <script>, et le type stocké ici est ensuite servi tel quel comme
// content-type public (voir POST /logo), donc directement exécutable si on l'acceptait.
const ALLOWED_LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// defParamCharset: busboy decode les en-têtes multipart en latin1 par défaut, ce qui
// corrompt (mojibake) les noms de fichiers accentués envoyés en UTF-8 par le navigateur.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_LOGO_TYPES.has(file.mimetype));
  },
});
const LOGO_BUCKET = 'tenant-logos';
// Mêmes fuseaux IANA que le sélecteur frontend (Intl.supportedValuesOf) — validé ici aussi
// pour ne jamais enregistrer une valeur qu'Intl.DateTimeFormat ne saurait pas interpréter.
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

function addMonthsIso(dateStr, months) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

// Paramétrer la fréquence par défaut ne devait toucher que les NOUVEAUX documents/versions —
// mais un tenant qui l'active (ou la change) s'attend à voir ses documents déjà existants en
// profiter tout de suite. Un document avec sa propre fréquence (review_frequency_months) est
// respecté tel quel — c'est justement le mécanisme prévu pour l'exempter du défaut. Tous les
// autres sont recalculés depuis leur date de création, y compris s'ils avaient déjà une date
// de révision : sans dérogation propre, cette date n'était de toute façon pas "un choix
// délibéré protégé" mais une valeur héritée d'avant ce paramétrage (souvent incohérente,
// cf. bug signalé où elle tombait avant la date de création).
async function backfillReviewDates(tenantId, newDefaultMonths) {
  const { data: documents, error } = await supabase
    .from('documents')
    .select('id, created_at')
    .eq('tenant_id', tenantId)
    .is('review_frequency_months', null);

  if (error || !documents || documents.length === 0) return 0;

  const updates = documents.map((document) =>
    supabase
      .from('documents')
      .update({ review_date: addMonthsIso(document.created_at.slice(0, 10), newDefaultMonths) })
      .eq('id', document.id)
  );

  await Promise.all(updates);
  return documents.length;
}

router.use(requireAuth);

// GET /api/tenant — informations de l'entreprise du tenant courant
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, logo_url, timezone, document_review_frequency_months')
    .eq('id', req.tenantId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Entreprise introuvable.' });
  }

  res.json(data);
});

// PATCH /api/tenant — met à jour le nom et/ou le fuseau horaire de l'entreprise (admin uniquement)
router.patch(
  '/',
  requireRole('admin'),
  [
    body('name').optional().trim().notEmpty().withMessage("Le nom de l'entreprise ne peut pas être vide."),
    body('timezone').optional().custom((value) => VALID_TIMEZONES.has(value)).withMessage('Fuseau horaire invalide.'),
    body('document_review_frequency_months')
      .optional({ nullable: true, values: 'falsy' })
      .isInt({ min: 1 })
      .withMessage('Fréquence de révision invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    if ('name' in req.body) update.name = req.body.name;
    if ('timezone' in req.body) update.timezone = req.body.timezone;
    if ('document_review_frequency_months' in req.body) {
      update.document_review_frequency_months = req.body.document_review_frequency_months || null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update(update)
      .eq('id', req.tenantId)
      .select('id, name, slug, plan, logo_url, timezone, document_review_frequency_months')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    let backfilledCount = 0;
    if (update.document_review_frequency_months) {
      backfilledCount = await backfillReviewDates(req.tenantId, update.document_review_frequency_months);
    }

    res.json({ ...data, backfilled_review_dates_count: backfilledCount });
  }
);

// POST /api/tenant/logo — upload du logo vers Supabase Storage (admin uniquement)
router.post('/logo', requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier image est requis (PNG, JPEG, WEBP ou GIF).' });
  }

  const logoPath = `${req.tenantId}/logo-${Date.now()}-${sanitizeFileName(req.file.originalname)}`;

  const { error: uploadError } = await supabase.storage
    .from(LOGO_BUCKET)
    .upload(logoPath, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

  if (uploadError) {
    return res.status(500).json({ error: "Échec de l'upload du logo." });
  }

  const { data, error } = await supabase
    .from('tenants')
    .update({ logo_url: logoPath })
    .eq('id', req.tenantId)
    .select('id, name, slug, plan, logo_url, timezone, document_review_frequency_months')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du logo.' });
  }

  res.json(data);
});

export default router;
