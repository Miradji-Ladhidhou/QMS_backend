import { randomUUID } from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { extractText } from '../services/textExtraction.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

// GET /api/documents — liste des documents du tenant, avec leur catégorie
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('documents')
    .select('*, category:document_categories(id, name, color)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les documents.' });
  }

  res.json(data);
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
router.get('/:id', async (req, res) => {
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

  res.json({ ...document, versions });
});

// POST /api/documents — création + upload optionnel du fichier initial
router.post(
  '/',
  upload.single('file'),
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
      filePath = `${req.tenantId}/${documentId}/${req.file.originalname}`;
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
router.post('/:id/versions', upload.single('file'), async (req, res) => {
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
  const filePath = `${req.tenantId}/${document.id}/${newVersion}-${req.file.originalname}`;

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

// PATCH /api/documents/:id/status — changement de statut
router.patch(
  '/:id/status',
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

    res.json(data);
  }
);

// DELETE /api/documents/:id — réservé aux admins/managers
router.delete('/:id', requireRole('owner', 'admin', 'manager'), async (req, res) => {
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
