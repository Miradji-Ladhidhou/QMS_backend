import { Router } from 'express';
import multer from 'multer';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { canAccessOwnedRecord } from '../services/ownershipVisibility.js';
import { deleteDriveFile, getDriveFileStream } from '../services/googleDrive.js';
import { getEvidenceDriveConnection, listEvidence, uploadEvidence } from '../services/qmsEvidence.js';

const router = Router();
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => callback(null, IMAGE_TYPES.has(file.mimetype)),
});
const MODULES = {
  accidents: { table: 'accidents', menu: 'accidents' },
  'nonconforming-outputs': { table: 'nonconforming_outputs', menu: 'nonconforming-outputs' },
  audits: { table: 'audits', menu: 'audits' },
  complaints: { table: 'complaints', menu: 'complaints', ownedType: 'complaint' },
  capas: { table: 'capas', menu: 'capas', ownedType: 'capa' },
  haccp: { table: 'haccp_plans', menu: 'haccp', resourceType: 'haccp_plan' },
  suppliers: { table: 'suppliers', menu: 'suppliers' },
  'supplier-evaluations': { table: 'supplier_evaluations', menu: 'suppliers', parentTable: 'suppliers', parentIdColumn: 'supplier_id' },
  risks: { table: 'risks', menu: 'risks' },
  pdca: { table: 'pdca_projects', menu: 'pdca' },
  qqoqccp: { table: 'qqoqccp_analyses', menu: 'qqoqccp' },
};

router.use(requireAuth);

async function loadAccessibleRecord(req, moduleKey) {
  const config = MODULES[moduleKey];
  if (!config) return { error: 'Module de preuve invalide.', status: 404 };

  let visibleModules;
  try {
    visibleModules = await getVisibleMenuKeys({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      appModules: req.appModules,
    });
  } catch (error) {
    console.error('Impossible de vérifier le module des preuves QMS :', error.message);
    return { error: 'Impossible de vérifier les droits sur ce module.', status: 503 };
  }
  if (!visibleModules.has(config.menu)) return { error: "Le module n'est pas accessible.", status: 403 };

  const { data: record, error } = await supabase
    .from(config.table)
    .select(config.parentTable ? '*' : '*, category:categories(id, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.recordId)
    .maybeSingle();
  if (error || !record) return { error: 'Fiche introuvable.', status: 404 };

  let categoryRecord = record;
  if (config.parentTable) {
    const { data: parent, error: parentError } = await supabase
      .from(config.parentTable)
      .select('category_id')
      .eq('tenant_id', req.tenantId)
      .eq('id', record[config.parentIdColumn])
      .maybeSingle();
    if (parentError || !parent) return { error: 'Fiche introuvable.', status: 404 };
    categoryRecord = { ...record, category_id: parent.category_id };
  }

  let allowed;
  if (config.ownedType) {
    allowed = await canAccessOwnedRecord({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      resourceType: config.ownedType,
      item: record,
    });
  } else {
    allowed = await hasGenericCategoryPermission({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      categoryId: categoryRecord.category_id,
      permission: 'view',
    });
  }
  return allowed ? { record } : { error: 'Fiche introuvable.', status: 404 };
}

router.get('/:moduleKey/:recordId', async (req, res) => {
  const access = await loadAccessibleRecord(req, req.params.moduleKey);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const evidence = await listEvidence({ tenantId: req.tenantId, moduleKey: req.params.moduleKey, recordId: req.params.recordId });
  res.json(evidence);
});

router.post('/:moduleKey/:recordId', upload.single('file'), async (req, res) => {
  const access = await loadAccessibleRecord(req, req.params.moduleKey);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!req.file) return res.status(400).json({ error: 'Choisissez une photo JPEG ou PNG (10 Mo maximum).' });
  const caption = String(req.body.caption || '').trim();
  if (caption.length > 300) return res.status(400).json({ error: 'La légende ne peut pas dépasser 300 caractères.' });

  try {
    const data = await uploadEvidence({
      tenantId: req.tenantId,
      moduleKey: req.params.moduleKey,
      recordId: req.params.recordId,
      userId: req.user.id,
      file: req.file,
      caption,
    });
    res.status(201).json(data);
  } catch (error) {
    res.status(error.driveConnectionError ? 409 : error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/:moduleKey/:recordId/:evidenceId/content', async (req, res) => {
  const access = await loadAccessibleRecord(req, req.params.moduleKey);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { data: evidence, error } = await supabase
    .from('qms_evidence_attachments')
    .select('drive_file_id, file_name, mime_type')
    .eq('id', req.params.evidenceId)
    .eq('tenant_id', req.tenantId)
    .eq('module_key', req.params.moduleKey)
    .eq('record_id', req.params.recordId)
    .maybeSingle();
  if (error || !evidence) return res.status(404).json({ error: 'Photo introuvable.' });

  try {
    const { accessToken } = await getEvidenceDriveConnection(req.tenantId);
    const stream = await getDriveFileStream(accessToken, evidence.drive_file_id);
    res.setHeader('Content-Type', evidence.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(evidence.file_name)}"`);
    stream.on('error', (streamError) => {
      console.error('Lecture d’une photo de preuve depuis Google Drive impossible :', streamError.message);
      if (!res.headersSent) res.status(502).json({ error: 'Impossible de lire cette photo sur Google Drive.' });
      else res.destroy(streamError);
    });
    stream.pipe(res);
  } catch (error) {
    res.status(error.driveConnectionError ? 409 : 502).json({ error: error.message || 'Impossible de lire cette photo sur Google Drive.' });
  }
});

router.delete('/:moduleKey/:recordId/:evidenceId', async (req, res) => {
  const access = await loadAccessibleRecord(req, req.params.moduleKey);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { data: evidence, error } = await supabase
    .from('qms_evidence_attachments')
    .select('id, drive_file_id, uploaded_by')
    .eq('id', req.params.evidenceId)
    .eq('tenant_id', req.tenantId)
    .eq('module_key', req.params.moduleKey)
    .eq('record_id', req.params.recordId)
    .maybeSingle();
  if (error || !evidence) return res.status(404).json({ error: 'Photo introuvable.' });
  if (req.userRole !== 'admin' && evidence.uploaded_by !== req.user.id) {
    return res.status(403).json({ error: 'Seul l’auteur ou un administrateur peut supprimer cette photo.' });
  }

  try {
    const { accessToken } = await getEvidenceDriveConnection(req.tenantId);
    await deleteDriveFile(accessToken, evidence.drive_file_id);
  } catch (error) {
    return res.status(error.driveConnectionError ? 409 : 502).json({ error: error.message || 'Impossible de supprimer la photo sur Google Drive.' });
  }
  const { error: deleteError } = await supabase
    .from('qms_evidence_attachments')
    .delete()
    .eq('id', evidence.id)
    .eq('tenant_id', req.tenantId);
  if (deleteError) return res.status(500).json({ error: 'La photo Drive a été supprimée, mais ses métadonnées n’ont pas pu être supprimées.' });
  res.status(204).end();
});

router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'La photo dépasse la limite de 10 Mo.' });
  }
  if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Le fichier envoyé est invalide.' });
  if (error) {
    console.error('Erreur de traitement des preuves QMS :', error);
    return res.status(500).json({ error: 'Erreur lors du traitement de la photo.' });
  }
  return next();
});

export default router;
