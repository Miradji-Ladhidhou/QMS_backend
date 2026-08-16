import { randomUUID } from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { buildCertificatePdf } from '../services/certificatePdf.js';
import { sendImmediateNotification, getUserFullName } from '../services/notificationHelpers.js';
import { extractText } from '../services/textExtraction.js';
import { sanitizeFileName } from '../utils/storagePath.js';
import {
  requireCategoryPermission,
  filterViewableDocuments,
  resolveDocumentById,
  resolveCategoryFromBody,
} from '../middleware/documentPermissions.js';

const router = Router();
// defParamCharset: busboy decode les en-têtes multipart en latin1 par défaut, ce qui
// corrompt (mojibake) les noms de fichiers accentués envoyés en UTF-8 par le navigateur.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  defParamCharset: 'utf8',
});

const DOCUMENT_STATUSES = ['draft', 'in_review', 'approved', 'obsolete'];
const STORAGE_BUCKET = 'qms-documents';

router.use(requireAuth);

function bumpVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? '');
  if (match) {
    return `${match[1]}.${Number(match[2]) + 1}`;
  }
  return `${version}.1`;
}

async function uploadToStorage(path, file) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });

  if (error) {
    throw new Error(`Échec de l'upload du fichier : ${error.message}`);
  }
}

// GET /api/documents — liste des documents du tenant, avec leur catégorie. Les documents
// d'une catégorie restreinte (is_restricted) sont filtrés hors de la liste si l'utilisateur
// n'a pas la permission can_view dessus (directement ou via un groupe).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('*, category:document_categories(id, name, color, is_restricted)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les documents.' });
  }

  const viewable = await filterViewableDocuments({
    userId: req.user.id,
    userRole: req.userRole,
    documents: data,
  });

  res.json(viewable);
});

// GET /api/documents/search?q=terme — recherche plein texte (titre, description, contenu extrait)
router.get(
  '/search',
  [query('q').trim().notEmpty().withMessage('Le terme de recherche est requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase.rpc('search_documents', {
      p_tenant_id: req.tenantId,
      p_query: req.query.q,
      p_user_id: req.user.id,
      p_user_role: req.userRole,
    });

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la recherche.' });
    }

    res.json(data);
  }
);

// GET /api/documents/alerts — documents à réviser sous 30 jours ou en retard
router.get('/alerts', async (req, res) => {
  const in30Days = new Date();
  in30Days.setDate(in30Days.getDate() + 30);

  const { data, error } = await supabase
    .from('documents')
    .select('id, number, title, status, review_date')
    .eq('tenant_id', req.tenantId)
    .not('review_date', 'is', null)
    .lte('review_date', in30Days.toISOString().slice(0, 10))
    .order('review_date', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les alertes.' });
  }

  res.json(data);
});

// GET /api/documents/:id — détail avec historique de versions
router.get('/:id', requireCategoryPermission('view', resolveDocumentById), async (req, res) => {
  const { data: document, error } = await supabase
    .from('documents')
    .select('*, category:document_categories(id, name, color)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  const { data: versions, error: versionsError } = await supabase
    .from('document_versions')
    .select('*, changed_by_user:users(id, full_name)')
    .eq('document_id', document.id)
    .order('created_at', { ascending: false });

  if (versionsError) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des versions." });
  }

  // Dernier workflow d'approbation ouvert pour ce document (le cas échéant), avec l'état
  // de chaque approbateur — utilisé par le frontend pour les boutons Approuver/Rejeter
  // et le badge "Signé électroniquement".
  const { data: workflow } = await supabase
    .from('document_workflows')
    .select('id, status, required_approvers, current_step, created_at')
    .eq('document_id', document.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let approvals = [];
  if (workflow) {
    const { data: workflowApprovals } = await supabase
      .from('document_approvals')
      .select('id, approver_id, decision, comment, decided_at, approver:users(id, full_name)')
      .eq('workflow_id', workflow.id)
      .order('created_at', { ascending: true });
    approvals = workflowApprovals || [];
  }

  res.json({ ...document, versions, workflow: workflow ? { ...workflow, approvals } : null });
});

// GET /api/documents/:id/certificate — certificat PDF de signature électronique
router.get('/:id/certificate', requireCategoryPermission('view', resolveDocumentById), async (req, res) => {
  const { data: document, error: documentError } = await supabase
    .from('documents')
    .select('id, number, title, version')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (documentError || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  const { data: workflow, error: workflowError } = await supabase
    .from('document_workflows')
    .select('id, status, created_at')
    .eq('tenant_id', req.tenantId)
    .eq('document_id', document.id)
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (workflowError || !workflow) {
    return res.status(404).json({ error: 'Aucun workflow approuvé pour ce document.' });
  }

  const { data: approvals, error: approvalsError } = await supabase
    .from('document_approvals')
    .select('decision, decided_at, signature_hash, ip_address, approver:users(full_name)')
    .eq('workflow_id', workflow.id)
    .eq('decision', 'approved')
    .order('decided_at', { ascending: true });

  if (approvalsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les approbations.' });
  }

  const pdfBuffer = await buildCertificatePdf({ document, workflow, approvals });

  await logAudit({
    tenantId: req.tenantId,
    documentId: document.id,
    userId: req.user.id,
    action: 'certificate_generated',
    details: { workflow_id: workflow.id },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="certificat-${document.number}.pdf"`);
  res.send(pdfBuffer);
});

// POST /api/documents — création + upload optionnel du fichier initial
router.post(
  '/',
  upload.single('file'),
  requireCategoryPermission('edit', resolveCategoryFromBody, {
    deniedStatus: 403,
    deniedMessage: "Vous n'avez pas la permission de créer un document dans cette catégorie.",
  }),
  [
    body('number').trim().notEmpty().withMessage('Le numéro du document est requis.'),
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
    body('review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de révision invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { number, title, description, category_id: categoryId, review_date: reviewDate } = req.body;
    const documentId = randomUUID();

    let filePath = null;
    let fileName = null;
    let extractedText = null;

    if (req.file) {
      filePath = `${req.tenantId}/${documentId}/${sanitizeFileName(req.file.originalname)}`;
      fileName = req.file.originalname;

      try {
        await uploadToStorage(filePath, req.file);
      } catch (uploadError) {
        return res.status(500).json({ error: uploadError.message });
      }

      extractedText = await extractText(req.file);
    }

    const { data, error } = await supabase
      .from('documents')
      .insert({
        id: documentId,
        tenant_id: req.tenantId,
        category_id: categoryId || null,
        number,
        title,
        description: description || null,
        review_date: reviewDate || null,
        file_path: filePath,
        file_name: fileName,
        extracted_text: extractedText,
        created_by: req.user.id,
      })
      .select('*, category:document_categories(id, name, color)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ce numéro de document est déjà utilisé.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création du document.' });
    }

    res.status(201).json(data);
  }
);

// POST /api/documents/:id/versions — nouvelle version, archive l'ancienne
router.post(
  '/:id/versions',
  upload.single('file'),
  requireCategoryPermission('edit', resolveDocumentById),
  async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier est requis pour créer une nouvelle version.' });
  }

  const { data: document, error: fetchError } = await supabase
    .from('documents')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  // Archive la version courante avant de la remplacer
  const { error: archiveError } = await supabase.from('document_versions').insert({
    document_id: document.id,
    tenant_id: req.tenantId,
    version: document.version,
    file_path: document.file_path,
    file_name: document.file_name,
    status: document.status,
    change_note: req.body.change_note || null,
    changed_by: req.user.id,
  });

  if (archiveError) {
    return res.status(500).json({ error: "Impossible d'archiver la version précédente." });
  }

  const newVersion = bumpVersion(document.version);
  const filePath = `${req.tenantId}/${document.id}/${newVersion}-${sanitizeFileName(req.file.originalname)}`;

  try {
    await uploadToStorage(filePath, req.file);
  } catch (uploadError) {
    return res.status(500).json({ error: uploadError.message });
  }

  const extractedText = await extractText(req.file);

  const { data, error } = await supabase
    .from('documents')
    .update({
      version: newVersion,
      file_path: filePath,
      file_name: req.file.originalname,
      extracted_text: extractedText,
      status: 'draft',
      approved_by: null,
    })
    .eq('id', document.id)
    .select('*, category:document_categories(id, name, color)')
    .single();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la mise à jour du document.' });
  }

  res.status(201).json(data);
});

// POST /api/documents/:id/submit-for-approval — ouvre un workflow d'approbation tracé
router.post(
  '/:id/submit-for-approval',
  requireCategoryPermission('approve', resolveDocumentById),
  [body('approver_ids').optional({ values: 'falsy' }).isArray({ min: 1 }).withMessage("Liste d'approbateurs invalide.")],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: document, error: documentError } = await supabase
      .from('documents')
      .select('id, category_id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (documentError || !document) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    let approverIds = req.body.approver_ids;

    // Pas de liste explicite : on la déduit du rôle approbateur requis par la catégorie
    if (!approverIds || approverIds.length === 0) {
      if (!document.category_id) {
        return res.status(400).json({
          error: "Aucun approbateur fourni, et ce document n'a pas de catégorie pour en déduire un rôle.",
        });
      }

      const { data: category, error: categoryError } = await supabase
        .from('document_categories')
        .select('required_approver_role')
        .eq('id', document.category_id)
        .single();

      if (categoryError || !category?.required_approver_role) {
        return res.status(400).json({
          error: "Aucun approbateur fourni, et la catégorie de ce document n'a pas de rôle approbateur défini.",
        });
      }

      const { data: roleUsers, error: roleUsersError } = await supabase
        .from('users')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('role', category.required_approver_role);

      if (roleUsersError || !roleUsers || roleUsers.length === 0) {
        return res
          .status(400)
          .json({ error: `Aucun utilisateur avec le rôle "${category.required_approver_role}" pour approuver ce document.` });
      }

      approverIds = roleUsers.map((user) => user.id);
    }

    const { data: workflow, error: workflowError } = await supabase
      .from('document_workflows')
      .insert({
        tenant_id: req.tenantId,
        document_id: document.id,
        required_approvers: approverIds,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (workflowError) {
      return res.status(500).json({ error: 'Erreur lors de la création du workflow.' });
    }

    const approvalRows = approverIds.map((approverId) => ({
      tenant_id: req.tenantId,
      workflow_id: workflow.id,
      approver_id: approverId,
    }));

    const { error: approvalsError } = await supabase.from('document_approvals').insert(approvalRows);

    if (approvalsError) {
      return res.status(500).json({ error: 'Erreur lors de la création des approbations.' });
    }

    const { data: updatedDocument, error: updateError } = await supabase
      .from('documents')
      .update({ status: 'in_review' })
      .eq('id', document.id)
      .select('*, category:document_categories(id, name, color)')
      .single();

    if (updateError) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour du document.' });
    }

    await logAudit({
      tenantId: req.tenantId,
      documentId: document.id,
      userId: req.user.id,
      action: 'submitted_for_approval',
      details: { workflow_id: workflow.id, approver_ids: approverIds },
    });

    // Envoi immédiat à chaque approbateur — ne doit pas attendre le batch quotidien.
    getUserFullName(req.user.id).then((requesterName) => {
      for (const approverId of approverIds) {
        sendImmediateNotification({
          tenantId: req.tenantId,
          userId: approverId,
          prefField: 'email_approval_requests',
          notificationType: 'approval_request',
          referenceId: workflow.id,
          templateName: 'approvalRequest',
          subject: `Approbation requise : ${updatedDocument.number}`,
          variables: {
            requesterName,
            documentNumber: updatedDocument.number,
            documentTitle: updatedDocument.title,
            documentUrl: `${process.env.FRONTEND_URL}/documents/${document.id}`,
          },
          notificationTitle: 'Approbation requise',
          notificationMessage: `${updatedDocument.number} — ${updatedDocument.title}`,
          notificationLink: `/documents/${document.id}`,
        }).catch((err) => console.error("Échec de la notification de demande d'approbation :", err.message));
      }
    });

    res.status(201).json({ document: updatedDocument, workflow });
  }
);

// GET /api/documents/:id/download — URL de téléchargement, journalisée dans l'audit
router.get('/:id/download', requireCategoryPermission('view', resolveDocumentById), async (req, res) => {
  const { data: document, error } = await supabase
    .from('documents')
    .select('id, file_path, file_name')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  if (!document.file_path) {
    return res.status(404).json({ error: 'Aucun fichier associé à ce document.' });
  }

  const { data: publicUrlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(document.file_path);

  await logAudit({
    tenantId: req.tenantId,
    documentId: document.id,
    userId: req.user.id,
    action: 'downloaded',
    details: { file_name: document.file_name },
  });

  res.json({ url: publicUrlData.publicUrl });
});

// GET /api/documents/:id/audit-log — historique complet et immuable des actions
router.get('/:id/audit-log', requireCategoryPermission('view', resolveDocumentById), async (req, res) => {
  const { data: document, error: documentError } = await supabase
    .from('documents')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (documentError || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  const { data, error } = await supabase
    .from('document_audit_log')
    .select('*, user:users(id, full_name)')
    .eq('document_id', document.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer le journal d'audit." });
  }

  res.json(data);
});

// PATCH /api/documents/:id/status — changement de statut manuel
router.patch(
  '/:id/status',
  requireCategoryPermission('edit', resolveDocumentById),
  [body('status').isIn(DOCUMENT_STATUSES).withMessage(`Statut invalide (${DOCUMENT_STATUSES.join(', ')}).`)],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { status } = req.body;
    const update = { status };
    if (status === 'approved') {
      update.approved_by = req.user.id;
    }

    const { data, error } = await supabase
      .from('documents')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*, category:document_categories(id, name, color)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Document introuvable.' });
    }

    await logAudit({
      tenantId: req.tenantId,
      documentId: req.params.id,
      userId: req.user.id,
      action: 'status_changed_manually',
      details: { status },
    });

    res.json(data);
  }
);

// DELETE /api/documents/:id — réservé aux admins/managers, et soumis à can_delete si la
// catégorie est restreinte (un manager n'a pas le bypass admin — il lui faut une permission
// explicite can_delete pour supprimer un document d'une catégorie restreinte).
router.delete(
  '/:id',
  requireRole('owner', 'admin', 'manager'),
  requireCategoryPermission('delete', resolveDocumentById),
  async (req, res) => {
  const { error, count } = await supabase
    .from('documents')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du document.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  res.status(204).send();
});

export default router;
