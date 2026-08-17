import { Router } from 'express';
import multer from 'multer';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sanitizeFileName } from '../utils/storagePath.js';

const router = Router();
// defParamCharset: busboy decode les en-têtes multipart en latin1 par défaut, ce qui
// corrompt (mojibake) les noms de fichiers accentués envoyés en UTF-8 par le navigateur.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  defParamCharset: 'utf8',
});
const LOGO_BUCKET = 'tenant-logos';
const DOCUMENTS_BUCKET = 'qms-documents';

// Toutes les tables portant directement une colonne tenant_id — à l'exception de
// capa_counters (compteur technique, pas une donnée de l'utilisateur) et group_members
// (rattaché au tenant via groups, pas de colonne propre).
const EXPORT_TABLES = [
  'document_categories',
  'documents',
  'document_versions',
  'capas',
  'capa_priority_delays',
  'capa_comments',
  'qqoqccp_analyses',
  'trainings',
  'training_records',
  'kpi_folders',
  'kpis',
  'kpi_raw_imports',
  'kpi_calculation_configs',
  'kpi_records',
  'kpi_raw_rows',
  'document_workflows',
  'document_approvals',
  'document_audit_log',
  'user_notification_preferences',
  'notification_log',
  'notifications',
  'groups',
  'category_permissions',
];

// Liste récursivement tous les fichiers sous un préfixe donné — le stockage Supabase
// simule des dossiers (entry.id === null) qu'il faut redescendre à la main.
async function listAllFiles(bucket, prefix) {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) {
    return [];
  }

  let files = [];
  for (const entry of data) {
    const fullPath = `${prefix}/${entry.name}`;
    if (entry.id === null) {
      files = files.concat(await listAllFiles(bucket, fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function purgeTenantStorage(tenantId) {
  for (const bucket of [DOCUMENTS_BUCKET, LOGO_BUCKET]) {
    const files = await listAllFiles(bucket, tenantId);
    if (files.length > 0) {
      await supabase.storage.from(bucket).remove(files);
    }
  }
}

router.use(requireAuth);

// GET /api/tenant — informations de l'entreprise du tenant courant
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, logo_url')
    .eq('id', req.tenantId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Entreprise introuvable.' });
  }

  res.json(data);
});

// PATCH /api/tenant — met à jour le nom de l'entreprise (admin uniquement)
router.patch(
  '/',
  requireRole('owner', 'admin'),
  [body('name').trim().notEmpty().withMessage("Le nom de l'entreprise est requis.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({ name: req.body.name })
      .eq('id', req.tenantId)
      .select('id, name, slug, plan, logo_url')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    res.json(data);
  }
);

// POST /api/tenant/logo — upload du logo vers Supabase Storage (admin uniquement)
router.post('/logo', requireRole('owner', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier est requis.' });
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
    .select('id, name, slug, plan, logo_url')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du logo.' });
  }

  res.json(data);
});

// GET /api/tenant/export — export JSON complet des données de l'entreprise (droit à la
// portabilité des données ; owner uniquement).
router.get('/export', requireRole('owner'), async (req, res) => {
  const { data: tenantRow, error: tenantError } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, created_at')
    .eq('id', req.tenantId)
    .single();

  if (tenantError || !tenantRow) {
    return res.status(404).json({ error: 'Entreprise introuvable.' });
  }

  const { data: members } = await supabase
    .from('users')
    .select('id, full_name, role, is_active, created_at')
    .eq('tenant_id', req.tenantId);

  const usersWithEmail = await Promise.all(
    (members || []).map(async (member) => {
      const { data: authData } = await supabase.auth.admin.getUserById(member.id);
      return { ...member, email: authData?.user?.email || null };
    })
  );

  const tables = {};
  for (const table of EXPORT_TABLES) {
    const { data } = await supabase.from(table).select('*').eq('tenant_id', req.tenantId);
    tables[table] = data || [];
  }

  const exportPayload = {
    exported_at: new Date().toISOString(),
    tenant: tenantRow,
    users: usersWithEmail,
    ...tables,
  };

  res.setHeader('Content-Disposition', `attachment; filename="export-${tenantRow.slug}-${Date.now()}.json"`);
  res.json(exportPayload);
});

// DELETE /api/tenant — suppression définitive et irréversible de l'entreprise et de toutes
// ses données (droit à l'effacement ; owner uniquement). Confirmation par saisie du nom exact.
router.delete(
  '/',
  requireRole('owner'),
  [body('confirm_name').trim().notEmpty().withMessage("Le nom de l'entreprise est requis pour confirmer.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: tenantRow, error: tenantError } = await supabase
      .from('tenants')
      .select('id, name')
      .eq('id', req.tenantId)
      .single();

    if (tenantError || !tenantRow) {
      return res.status(404).json({ error: 'Entreprise introuvable.' });
    }

    if (req.body.confirm_name.trim() !== tenantRow.name) {
      return res.status(400).json({ error: "Le nom saisi ne correspond pas au nom de l'entreprise." });
    }

    const { data: memberRows } = await supabase.from('users').select('id').eq('tenant_id', req.tenantId);
    const memberIds = (memberRows || []).map((member) => member.id);

    await purgeTenantStorage(req.tenantId);

    // Le cascade ON DELETE de tenant_id efface toutes les tables métier en une fois.
    const { error: deleteError } = await supabase.from('tenants').delete().eq('id', req.tenantId);

    if (deleteError) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    // public.users → auth.users n'est pas cascadé dans ce sens : suppression au mieux,
    // les données métier (déjà effacées ci-dessus) restent le point critique du RGPD.
    await Promise.all(memberIds.map((id) => supabase.auth.admin.deleteUser(id).catch(() => {})));

    res.json({ ok: true });
  }
);

export default router;
