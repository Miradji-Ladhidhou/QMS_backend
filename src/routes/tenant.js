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

// Sections de menu configurables (visibilité par rôle/utilisateur) — dupliqué depuis
// Layout.jsx#NAV_ITEMS plutôt que partagé (deux repos séparés, pas de package commun). Les
// entrées adminOnly (services, employees, settings) sont volontairement absentes : réservées à
// l'admin de façon fixe, jamais configurables ici, pour qu'aucune combinaison de règles ne
// puisse jamais faire disparaître Paramètres du menu d'un admin.
const MENU_ITEM_KEYS = [
  'dashboard',
  'planning',
  'documents',
  'capas',
  'complaints',
  'trainings',
  'kpis',
  'qqoqccp',
  'audits',
  'risks',
  'suppliers',
  'management-reviews',
  'my-approvals',
];
const MENU_ITEM_KEY_SET = new Set(MENU_ITEM_KEYS);
const CONFIGURABLE_ROLES = ['manager', 'member'];
// Mêmes fuseaux IANA que le sélecteur frontend (Intl.supportedValuesOf) — validé ici aussi
// pour ne jamais enregistrer une valeur qu'Intl.DateTimeFormat ne saurait pas interpréter.
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

// Number(months) en filet de sécurité : date.getMonth() + "1" concatène ("71") au lieu
// d'additionner, ce que Date.setMonth interprète ensuite comme un nombre de mois valide et
// projette des années dans le futur sans jamais planter (voir le bug "2031" corrigé ici).
function addMonthsIso(dateStr, months) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + Number(months));
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

  // storage_provider exposé à TOUS les rôles ici (contrairement à GET /api/drive/status,
  // réservé admin, qui donne en plus l'email du compte connecté et l'état de santé) : savoir
  // que "les documents sont stockés sur Google Drive" n'est pas sensible en soi, et sert
  // uniquement à afficher un texte informatif sur la page Documents pour les non-admins.
  const { data: storageSettings } = await supabase
    .from('tenant_storage_settings')
    .select('storage_provider')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  res.json({ ...data, storage_provider: storageSettings?.storage_provider || 'supabase' });
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
      .withMessage('Fréquence de révision invalide.')
      // .toInt() : express-validator laisse req.body tel quel par défaut (chaîne venant du
      // formulaire) — sans ça, backfillReviewDates() reçoit une chaîne et
      // date.getMonth() + "1" fait de la concaténation ("71") plutôt qu'une addition,
      // ce qui a fait planter setMonth() sur une année totalement fausse (bug rencontré :
      // "1 mois" affichait une date de révision en 2031).
      .toInt(),
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

function isValidRoleHiddenItems(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([role, items]) =>
      CONFIGURABLE_ROLES.includes(role) && Array.isArray(items) && items.every((key) => MENU_ITEM_KEY_SET.has(key))
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUserOverrides(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([userId, overrides]) => {
    if (!UUID_RE.test(userId)) return false;
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return false;
    return Object.entries(overrides).every(([key, visible]) => MENU_ITEM_KEY_SET.has(key) && typeof visible === 'boolean');
  });
}

// GET /api/tenant/menu — sections visibles pour L'UTILISATEUR COURANT, calculées côté serveur
// (jamais la config brute, réservée à /menu-settings). Un admin voit toujours tout : ce
// réglage ne s'applique jamais au rôle admin, pour qu'aucune combinaison de règles ne puisse
// jamais cacher Paramètres > Visibilité à celui/celle qui doit pouvoir la corriger.
router.get('/menu', async (req, res) => {
  if (req.userRole === 'admin') {
    return res.json({ visible: MENU_ITEM_KEYS });
  }

  const { data: settings } = await supabase
    .from('tenant_menu_settings')
    .select('role_hidden_items, user_overrides')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  const hiddenForRole = new Set(settings?.role_hidden_items?.[req.userRole] || []);
  const overridesForUser = settings?.user_overrides?.[req.user.id] || {};

  const visible = MENU_ITEM_KEYS.filter((key) => {
    if (Object.prototype.hasOwnProperty.call(overridesForUser, key)) return overridesForUser[key];
    return !hiddenForRole.has(key);
  });

  res.json({ visible });
});

// GET /api/tenant/menu-settings — configuration brute, réservée admin (Paramètres > Visibilité
// en a besoin telle quelle pour pré-remplir les cases à cocher).
router.get('/menu-settings', requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase
    .from('tenant_menu_settings')
    .select('role_hidden_items, user_overrides')
    .eq('tenant_id', req.tenantId)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les réglages de visibilité.' });
  }

  res.json({
    items: MENU_ITEM_KEYS,
    role_hidden_items: data?.role_hidden_items || {},
    user_overrides: data?.user_overrides || {},
  });
});

// PATCH /api/tenant/menu-settings — remplace la configuration entière : l'écran envoie toujours
// l'objet complet qu'il vient d'éditer, plus simple et sans risque d'incohérence entre deux
// PATCH concurrents sur des sous-clés différentes qu'un merge partiel aurait introduit.
router.patch('/menu-settings', requireRole('admin'), async (req, res) => {
  const { role_hidden_items: roleHiddenItems, user_overrides: userOverrides } = req.body;

  if (!isValidRoleHiddenItems(roleHiddenItems) || !isValidUserOverrides(userOverrides)) {
    return res.status(400).json({ error: 'Réglages de visibilité invalides.' });
  }

  const { data, error } = await supabase
    .from('tenant_menu_settings')
    .upsert(
      { tenant_id: req.tenantId, role_hidden_items: roleHiddenItems, user_overrides: userOverrides },
      { onConflict: 'tenant_id' }
    )
    .select('role_hidden_items, user_overrides')
    .single();

  if (error) {
    return res.status(500).json({ error: "Impossible d'enregistrer les réglages de visibilité." });
  }

  res.json(data);
});

export default router;
