import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { sendImmediateNotification, getUserFullName } from '../services/notificationHelpers.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildProcedurePdf } from '../services/procedurePdf.js';
import { buildProcedureWordDocument } from '../services/procedureWord.js';
import { resolveTenantStorageProvider, safeStorageContentType } from '../services/tenantStorage.js';
import { signDownloadTicket } from '../services/driveDownloadTicket.js';
import {
  getDriveFileStream,
  refreshAccessTokenIfNeeded,
  uploadFile as uploadFileToDrive,
} from '../services/googleDrive.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';
import { draftToBlockContent, blocksToPlainText, textToParagraphBlocks } from '../lib/procedureBlocks.js';
import { extractProcedureSectionsFromDocx } from '../services/procedureContentExtraction.js';
import { filterViewableDocuments } from '../middleware/documentPermissions.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';
import {
  generateProcedureDraft,
  generateProcedureDraftFromQqoqccp,
  checkProcedureTemplateCompliance,
  generateProcedureComplianceFix,
  compareProcedureVersions,
  generateProcedureDistributionSheet,
  suggestProcedureRevisionFromCapa,
} from '../services/groq.js';
import { createProcedureFullDraftJob, runProcedureFullDraftJob } from '../services/procedureFullDraftJob.js';
import { DEFAULT_PROCEDURE_SECTIONS } from '../data/defaultProcedureSections.js';
import { prepareAiResult, aiResultRoute, linkAiGenerationJob } from '../services/aiGenerations.js';
import { validAiResult } from '../services/aiResultValidation.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  defParamCharset: 'utf8',
});

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];
const PROCEDURE_STATUSES = ['draft', 'in_review', 'approved', 'obsolete'];
const STORAGE_BUCKET = 'qms-documents';
const MAX_SOURCE_DOCX_BYTES = 20 * 1024 * 1024;

async function sourceDocumentBuffer(document, tenantId) {
  if (document.storage_provider === 'google_drive') {
    const { data: connection, error } = await supabase
      .from('google_drive_connections')
      .select('*')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (error || !connection) {
      throw new Error(error?.message || 'Connexion Google Drive introuvable.');
    }

    const accessToken = await refreshAccessTokenIfNeeded(connection);
    const stream = await getDriveFileStream(accessToken, document.file_path);
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bufferChunk.length;
      if (size > MAX_SOURCE_DOCX_BYTES) {
        stream.destroy();
        throw new Error('Le document Word source dépasse la taille maximale autorisée.');
      }
      chunks.push(bufferChunk);
    }
    return Buffer.concat(chunks);
  }

  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(document.file_path);
  if (error || !data) {
    throw new Error(error?.message || 'Fichier source introuvable dans le stockage.');
  }
  if (data.size > MAX_SOURCE_DOCX_BYTES) {
    throw new Error('Le document Word source dépasse la taille maximale autorisée.');
  }
  return Buffer.from(await data.arrayBuffer());
}

async function buildImportedProcedureContent(sourceDocument, tenantId) {
  const sourceText = [sourceDocument.description, sourceDocument.extracted_text].filter(Boolean).join('\n\n');
  let importedSections;
  if (sourceDocument.file_path && /\.docx$/i.test(sourceDocument.file_name || '')) {
    const sourceBuffer = await sourceDocumentBuffer(sourceDocument, tenantId);
    importedSections = await extractProcedureSectionsFromDocx(sourceBuffer, {
      description: sourceDocument.description || '',
      documentTitle: sourceDocument.title || '',
    });
  }

  return {
    sections: importedSections?.length
      ? importedSections
      : [
          {
            key: 'contenu_importe',
            label: 'Contenu repris du document source',
            blocks: textToParagraphBlocks(sourceText),
          },
        ],
    documents_associes: [],
  };
}

// Pas de système de quota générique dans l'app (voir middleware/rateLimit.js, un limiteur
// anti-abus par IP, sans lien avec un coût IA par tenant) : garde-fou minimal et pragmatique
// contre un usage intensif de cette fonctionnalité plus coûteuse en appels (~1 plan + 1 par
// sous-section par génération), plutôt qu'un vrai sous-système de quota.
const MAX_FULL_DRAFT_JOBS_PER_DAY = 15;

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

async function isSourceDocumentViewable(req, sourceDocumentId) {
  if (!sourceDocumentId) return true;

  const { data: sourceDocument, error } = await supabase
    .from('documents')
    .select('id, category_id, category:document_categories(id, is_restricted)')
    .eq('tenant_id', req.tenantId)
    .eq('id', sourceDocumentId)
    .maybeSingle();
  if (error) {
    console.error('Erreur lors de la vérification des droits du document source :', error);
    throw new Error('Impossible de vérifier les droits du document source.');
  }
  if (!sourceDocument) return true;

  const [viewable] = await filterViewableDocuments({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    documents: [sourceDocument],
  });
  return Boolean(viewable);
}

async function isProcedureViewable(req, procedureId) {
  try {
    const { data: procedure, error } = await supabase
      .from('procedures')
      .select('id, category_id, source_document_id, category:categories(id, is_restricted)')
      .eq('tenant_id', req.tenantId)
      .eq('id', procedureId)
      .maybeSingle();
    if (error) {
      console.error('Erreur lors de la vérification des droits de la procédure :', error);
      throw new Error('Impossible de vérifier les droits de la procédure.');
    }
    if (!procedure) return false;
    if (req.userRole !== 'admin') {
      const shared = await isSharedWithUser({
        tenantId: req.tenantId,
        resourceType: 'procedure',
        resourceId: procedure.id,
        userId: req.user.id,
        userRole: req.userRole,
      });
      if (!shared && procedure.category?.is_restricted) {
        const categoryAllowed = await hasGenericCategoryPermission({
          tenantId: req.tenantId,
          userId: req.user.id,
          userRole: req.userRole,
          categoryId: procedure.category_id,
          permission: 'view',
        });
        if (!categoryAllowed) return false;
      }
    }
    return isSourceDocumentViewable(req, procedure.source_document_id);
  } catch (error) {
    console.error('Erreur lors de la vérification des droits de la procédure :', error);
    throw error;
  }
}

async function requireProcedureView(req, res, procedureId) {
  try {
    const visible = await isProcedureViewable(req, procedureId);
    if (!visible) {
      res.status(404).json({ error: 'Procédure introuvable.' });
      return false;
    }
    return true;
  } catch {
    res.status(500).json({ error: 'Impossible de vérifier les droits de la procédure.' });
    return false;
  }
}

// Même logique que bumpVersion (documents.js) : "1.0" -> "1.1", 1.0 par défaut pour la
// toute première version d'une procédure.
function bumpVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? '');
  if (match) return `${match[1]}.${Number(match[2]) + 1}`;
  return `${version}.1`;
}

// Auteur de la version ou admin/manager — même principe que canManageTask (tasks.js) : celui
// qui a écrit garde la main sur sa propre soumission, sans qu'un autre member ne puisse la
// pousser à sa place.
function canActOnVersion(req, version) {
  return MANAGER_ROLES.includes(req.userRole) || version.author_id === req.user.id;
}

// Même point de départ minimal que GET /api/procedure-templates (voir
// data/defaultProcedureSections.js, désormais partagé entre les deux routes) tant qu'aucun
// gabarit n'est réellement enregistré — sans quoi generate-draft/check-compliance/generate-
// draft-from-qqoqccp verraient un gabarit "vide" différent de celui affiché à l'écran par
// ProcedureSectionsEditor, et rédigeraient une procédure sans aucune section de contenu réel.
async function fetchTenantTemplate(tenantId) {
  const { data } = await supabase.from('procedure_templates').select('*').eq('tenant_id', tenantId).maybeSingle();
  return data || { tenant_id: tenantId, section_structure: DEFAULT_PROCEDURE_SECTIONS };
}

// POST /api/procedures/generate-draft — appelé depuis le formulaire de création, AVANT que la
// procédure existe : le brouillon personnel est persisté, sans créer ni publier de procédure.
aiResultRoute(router,
  '/generate-draft',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('process').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const template = await fetchTenantTemplate(req.tenantId);

    try {
      if (!(await prepareAiResult(req, res))) return;
      const draft = await generateProcedureDraft({ title: req.body.title, process: req.body.process }, template);
      // draftToBlockContent : convertit sections[].content (texte à plat, voir
      // PROCEDURE_DRAFT_RESPONSE_CONTRACT dans groq.js) en sections[].blocks — la forme
      // canonique attendue par l'éditeur manuel (voir lib/procedureBlocks.js).
      res.json(draftToBlockContent(draft));
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer un brouillon IA : ${err.message}` });
    }
  }
);

// POST /api/procedures/generate-full-draft — lance un job persistant multi-appels asynchrone au
// lieu d'un unique appel Groq synchrone : la réponse renvoie immédiatement un job à suivre via
// GET /generation-jobs/:jobId ci-dessous plutôt que d'attendre les ~10-15 appels IA en ligne.
aiResultRoute(router,
  '/generate-full-draft',
  [
    // max généreux (un sujet collé peut légitimement faire plusieurs dizaines de lignes,
    // reformulé en un titre court par l'IA — voir generateProcedureFullPlan dans groq.js) :
    // borne seulement le payload/coût d'appel, pas l'usage réel visé.
    body('subject').trim().isLength({ min: 3, max: 20000 }).withMessage('Le sujet doit faire entre 3 et 20 000 caractères.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (!(await prepareAiResult(req, res))) return;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('procedure_generation_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', req.tenantId)
      .gte('created_at', since);

    if ((count || 0) >= MAX_FULL_DRAFT_JOBS_PER_DAY) {
      return res
        .status(429)
        .json({ error: "Trop de générations complètes IA aujourd'hui pour votre entreprise. Réessayez demain." });
    }

    const template = await fetchTenantTemplate(req.tenantId);
    let job;
    try {
      job = await createProcedureFullDraftJob({
        tenantId: req.tenantId,
        userId: req.user.id,
        subject: req.body.subject,
        template,
        aiQuotaActionId: req.aiQuotaActionId,
      });
      await linkAiGenerationJob(req, job);
    } catch (err) {
      if (job) {
        const { error } = await supabase.from('procedure_generation_jobs')
          .update({ status: 'failed', error: 'Impossible de préparer le suivi persistant de la génération.' })
          .eq('tenant_id', req.tenantId).eq('id', job.id);
        if (error) console.error('[IA] état du job :', error.message);
      }
      return res.status(500).json({ error: err.message });
    }

    req.aiQuotaDeferred = true;
    runProcedureFullDraftJob(job.id).catch((err) => console.error('Échec du job de génération complète :', err));

    res.status(202).json(job);
  }
);

// GET /api/procedures/generation-jobs/:jobId — état d'avancement d'un job lancé par
// /generate-full-draft ci-dessus, interrogé par le frontend via polling (pas de WebSocket/SSE
// dans cette app — voir le plan). Ouvert à tout rôle authentifié du tenant, comme le reste du
// module.
router.get('/generation-jobs/latest', async (req, res) => {
  let query = supabase.from('procedure_generation_jobs').select('*')
    .eq('tenant_id', req.tenantId).eq('created_by', req.user.id);
  if (req.query.subject) query = query.eq('subject', req.query.subject);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return res.status(503).json({ error: 'Impossible de retrouver la génération complète.' });
  let previousJob = null;
  if (data?.status === 'failed') {
    const { data: previous, error: previousError } = await supabase.from('procedure_generation_jobs').select('*')
      .eq('tenant_id', req.tenantId).eq('created_by', req.user.id).eq('subject', data.subject)
      .eq('status', 'completed').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (previousError) return res.status(503).json({ error: 'Impossible de retrouver le dernier document complet enregistré.' });
    previousJob = previous;
  }
  res.json({ job: data, previous_job: previousJob });
});

router.get('/generation-jobs/:jobId', async (req, res) => {
  const { data, error } = await supabase
    .from('procedure_generation_jobs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.jobId)
    .maybeSingle();

  if (error || !data) {
    return res.status(404).json({ error: 'Job de génération introuvable.' });
  }

  res.json(data);
});

// POST /api/procedures/generate-draft-from-qqoqccp — même principe que /generate-draft ci-
// dessus (brouillon persisté avant création), mais informé par
// une analyse QQOQCCP existante plutôt qu'un titre/processus tapés à la main : la procédure
// est créée PARCE QUE ce diagnostic a révélé un manque à formaliser (voir
// QqoqccpDetail.jsx#handleCreateProcedure). Même vérification de permission que
// GET /api/qqoqccp/:id (catégorie restreinte ou partage individuel), dupliquée ici plutôt que
// mutualisée : ce n'est qu'une lecture, pas une action sur l'analyse elle-même.
aiResultRoute(router,
  '/generate-draft-from-qqoqccp',
  [body('qqoqccp_id').isUUID().withMessage('Analyse QQOQCCP invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: analysis, error } = await supabase
      .from('qqoqccp_analyses')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.body.qqoqccp_id)
      .maybeSingle();

    if (error || !analysis) {
      return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
    }

    if (req.userRole !== 'admin') {
      const shared = await isSharedWithUser({
        tenantId: req.tenantId,
        resourceType: 'qqoqccp',
        resourceId: analysis.id,
        userId: req.user.id,
        userRole: req.userRole,
      });
      if (!shared) {
        const categoryAllowed = await hasGenericCategoryPermission({
          tenantId: req.tenantId,
          userId: req.user.id,
          userRole: req.userRole,
          categoryId: analysis.category_id,
          permission: 'view',
        });
        if (!categoryAllowed) {
          return res.status(404).json({ error: 'Analyse QQOQCCP introuvable.' });
        }
      }
    }

    const template = await fetchTenantTemplate(req.tenantId);

    try {
      if (!(await prepareAiResult(req, res))) return;
      const draft = await generateProcedureDraftFromQqoqccp(analysis, template);
      res.json({ ...draftToBlockContent(draft), title: analysis.title });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer un brouillon IA : ${err.message}` });
    }
  }
);

// GET /api/procedures — liste, filtrable par statut/processus/recherche texte. Catégorie
// (dossier) optionnelle comme les autres modules génériques (voir module_categories) : ouvert à
// tout rôle authentifié tant qu'aucune catégorie n'est marquée restreinte, opt-in.
router.get(
  '/',
  [
    query('status').optional({ values: 'falsy' }).isIn(PROCEDURE_STATUSES).withMessage('Statut invalide.'),
    query('process').optional({ values: 'falsy' }).trim(),
    query('search').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Paramètres invalides.', details: errors.array() });
    }

    // Auteur/validateur/date de validation de la version courante embarqués directement ici
    // (plutôt que de laisser le frontend les redemander par procédure) : c'est ce que
    // consomme l'export CSV/Excel de la liste (voir Procedures.jsx), qui doit refléter
    // exactement ce qui est affiché à l'écran, filtres compris.
    let queryBuilder = supabase
      .from('procedures')
      .select(
        `*, current_version:procedure_versions!procedures_current_version_id_fkey(
          id, version, status, validated_at,
          author:users!procedure_versions_author_id_fkey(id, full_name),
          validator:users!procedure_versions_validator_id_fkey(id, full_name)
        ), category:categories(id, name, color, is_restricted, owner_user_id),
        source_document:documents!procedures_source_document_id_fkey(
          id, category_id, number, title, version, status, category:document_categories(id, is_restricted)
        )`
      )
      .eq('tenant_id', req.tenantId)
      .order('number', { ascending: true });

    // Sans filtre de statut explicite, les procédures obsolètes restent hors de la liste
    // principale — jamais supprimées (piste d'audit), seulement écartées par défaut. Le
    // filtre status=obsolete (déjà supporté ci-dessous) reste le seul moyen de les retrouver.
    if (req.query.status) {
      queryBuilder = queryBuilder.eq('status', req.query.status);
    } else {
      queryBuilder = queryBuilder.neq('status', 'obsolete');
    }
    if (req.query.process) queryBuilder = queryBuilder.ilike('process', `%${req.query.process}%`);

    // search porte sur le numéro/titre (ilike, comme avant) OU le contenu de la version
    // COURANTE (recherche plein texte, voir search_procedure_ids dans schema.sql — même
    // principe que search_documents pour Documents) : le query builder Supabase ne sait pas
    // filtrer sur une colonne d'une table jointe embarquée, donc la fonction renvoie juste les
    // id concernés, réinjectés ici via .in(), le reste du filtrage (statut/processus/tri) reste
    // géré normalement au-dessus.
    if (req.query.search) {
      const { data: matches, error: searchError } = await supabase.rpc('search_procedure_ids', {
        p_tenant_id: req.tenantId,
        p_query: req.query.search,
      });
      if (searchError) {
        return res.status(500).json({ error: 'Impossible de rechercher les procédures.' });
      }
      queryBuilder = queryBuilder.in('id', matches.map((m) => m.id));
    }

    const { data, error } = await queryBuilder;
    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer les procédures.' });
    }

    let visible = data;
    if (req.userRole !== 'admin') {
      // Un partage ouvre une procédure, mais ne doit pas élargir les droits du document d'origine.
      const sharedIds = await getSharedResourceIds({
        tenantId: req.tenantId,
        resourceType: 'procedure',
        userId: req.user.id,
        userRole: req.userRole,
      });
      const categoryViewableIds = new Set(
        (await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data })).map((p) => p.id)
      );
      visible = data.filter((procedure) => sharedIds.has(procedure.id) || categoryViewableIds.has(procedure.id));
    }

    const sourceDocuments = visible
      .filter((procedure) => procedure.source_document)
      .map((procedure) => procedure.source_document);
    const viewableSourceDocuments = await filterViewableDocuments({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      documents: sourceDocuments,
    });
    const viewableSourceIds = new Set(viewableSourceDocuments.map((document) => document.id));
    res.json(visible.filter((procedure) => !procedure.source_document || viewableSourceIds.has(procedure.source_document.id)));
  }
);

// GET /api/procedures/pending-validations — versions en attente de validation, dans TOUT le
// tenant : contrairement aux documents (approbateurs nommés à l'avance, voir
// document_approvals), n'importe quel admin/manager peut valider une procédure (voir
// /validate ci-dessous), donc pas de filtre "assigné à moi" ici — alimente la section
// Procédures de "Mes approbations" côté frontend.
router.get('/pending-validations', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { data, error } = await supabase
    .from('procedure_versions')
    .select('id, version, submitted_at, procedure:procedures!procedure_versions_procedure_id_fkey(id, number, title)')
    .eq('tenant_id', req.tenantId)
    .eq('status', 'pending')
    .order('submitted_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les validations en attente.' });
  }

  res.json(data);
});

// GET /api/procedures/:id — détail + historique complet des versions (plus récentes d'abord).
router.get('/:id', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select(
      '*, current_version:procedure_versions!procedures_current_version_id_fkey(id, version, status), obsoleted_by_user:users!procedures_obsoleted_by_fkey(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id), source_document:documents!procedures_source_document_id_fkey(id, number, title, version, status)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  // PGRST116 = "no rows" (.single() sur 0 résultat) : c'est le SEUL cas où 404 est correct.
  // Toute autre erreur (colonne/contrainte manquante après une migration pas encore appliquée
  // en production, par ex.) était jusqu'ici avalée dans le même 404 générique, indiscernable
  // d'une procédure qui n'existe vraiment pas — bug réel rapporté (404 sur un id valide, rien
  // dans les logs pour comprendre pourquoi).
  if (error && error.code !== 'PGRST116') {
    console.error('Erreur lors de la récupération de la procédure :', error);
    return res.status(500).json({ error: 'Erreur lors de la récupération de la procédure.' });
  }
  if (!procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }

  if (!(await requireProcedureView(req, res, procedure.id))) return;

  if (req.userRole !== 'admin' && procedure.category?.is_restricted) {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'procedure',
      resourceId: procedure.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: procedure.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'Procédure introuvable.' });
      }
    }
  }

  const { data: versions, error: versionsError } = await supabase
    .from('procedure_versions')
    .select('*, author:users!procedure_versions_author_id_fkey(id, full_name), validator:users!procedure_versions_validator_id_fkey(id, full_name)')
    .eq('procedure_id', procedure.id)
    .order('created_at', { ascending: false });

  if (versionsError) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des versions." });
  }

  // Accusé de lecture de l'utilisateur courant POUR LA VERSION COURANTE uniquement — même
  // principe que my_acknowledgment sur GET /api/documents/:id : une nouvelle validation change
  // current_version_id, ce qui rend naturellement cette valeur null pour tout le monde.
  let myAcknowledgment = null;
  const currentVersion = versions.find((version) => version.id === procedure.current_version_id);
  if (currentVersion?.status === 'approved') {
    const { data } = await supabase
      .from('procedure_acknowledgments')
      .select('acknowledged_at')
      .eq('procedure_version_id', procedure.current_version_id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    myAcknowledgment = data || null;
  }

  // Traçabilité inverse (voir procedure_capa_links/procedure_audit_links dans schema.sql) —
  // même esprit que linked_capas sur GET /api/documents/:id, mais many-to-many attachable/
  // détachable après coup plutôt qu'un unique ref_document fixé à la création.
  const [{ data: capaLinks, error: capaLinksError }, { data: auditLinks, error: auditLinksError }] = await Promise.all([
    supabase
      .from('procedure_capa_links')
      .select('capa:capas(id, number, title, status)')
      .eq('tenant_id', req.tenantId)
      .eq('procedure_id', procedure.id),
    supabase
      .from('procedure_audit_links')
      .select('audit:audits(id, title, planned_date, status)')
      .eq('tenant_id', req.tenantId)
      .eq('procedure_id', procedure.id),
  ]);

  if (capaLinksError || auditLinksError) {
    return res.status(500).json({ error: 'Impossible de récupérer les éléments liés.' });
  }

  res.json({
    ...procedure,
    versions,
    my_acknowledgment: myAcknowledgment,
    linked_capas: capaLinks.map((link) => link.capa),
    linked_audits: auditLinks.map((link) => link.audit),
  });
});

// GET /api/procedures/:id/pdf — rapport imprimable d'une procédure (numérotation des
// sections, encadré "Important" pour l'obsolescence/le retard de révision déjà signalés à
// l'écran, historique des versions en bas). Chemin à deux segments : ne rentre jamais en
// conflit avec GET /:id ci-dessus, même principe que /:id/pdf dans qqoqccp.js. Imprime la
// version COURANTE si elle existe, sinon la plus récente quel que soit son statut — jamais de
// blocage tant qu'au moins une version a été rédigée.
router.get('/:id/pdf', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('*, obsoleted_by_user:users!procedures_obsoleted_by_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }

  if (!(await requireProcedureView(req, res, procedure.id))) return;

  const { data: versions, error: versionsError } = await supabase
    .from('procedure_versions')
    .select('*, author:users!procedure_versions_author_id_fkey(id, full_name), validator:users!procedure_versions_validator_id_fkey(id, full_name)')
    .eq('procedure_id', procedure.id)
    .order('created_at', { ascending: false });

  if (versionsError) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des versions." });
  }
  if (!versions || versions.length === 0) {
    return res.status(400).json({ error: "Cette procédure n'a encore aucune version à imprimer." });
  }

  const version = versions.find((v) => v.id === procedure.current_version_id) || versions[0];

  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, logo_url, company_address, company_phone, company_legal_mentions')
    .eq('id', req.tenantId)
    .single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const template = await fetchTenantTemplate(req.tenantId);
  const pdfBuffer = await buildProcedurePdf({
    tenantName: tenant?.name,
    tenantAddress: tenant?.company_address,
    tenantPhone: tenant?.company_phone,
    tenantLegalMentions: tenant?.company_legal_mentions,
    tenantLogo,
    procedure,
    version,
    versions,
    // template.accent_color est désormais la seule source de personnalisation par tenant (voir
    // procedure_templates.accent_color) — l'ancien objet render_style (thème de preset complet)
    // devenait périmé dès qu'un tenant changeait sa couleur sans réappliquer un preset ; boxBackground/
    // boxBorder ne sont plus des réglages distincts (voir services/procedurePdf.js#buildProcedurePdf),
    // le défaut neutre HEADER_FILL/RULE s'applique donc à tous les tenants personnalisés.
    renderStyle: { accentColor: template.accent_color, visualOptions: template.visual_options },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${procedure.number}.pdf"`);
  res.send(pdfBuffer);
});

// PATCH /api/procedures/bulk-category — déplace plusieurs procédures d'un coup vers un dossier
// (ou aucun). Placée avant PATCH /:id/category pour ne pas être capturée comme un id, même
// convention que /bulk-category dans les autres modules.
router.patch(
  '/bulk-category',
  requireRole(...MANAGER_ROLES),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une procédure.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('procedure'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('procedures')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids)
      .select('id');

    if (error) {
      return res.status(500).json({ error: 'Erreur lors du déplacement.' });
    }

    res.json({ updated: data.length });
  }
);

// DELETE /api/procedures/bulk — suppression en masse, mêmes garde-fous que DELETE /:id
// ci-dessous (auteur ou admin, jamais une procédure qui a quitté le brouillon) : les ids qui ne
// les respectent pas sont silencieusement ignorés plutôt que de faire échouer toute la
// sélection, même principe que DELETE /tasks/bulk (tasks.js).
router.delete(
  '/bulk',
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une procédure.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: candidates, error: fetchError } = await supabase
      .from('procedures')
      .select('id, created_by')
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (fetchError) {
      return res.status(500).json({ error: 'Impossible de récupérer ces procédures.' });
    }

    const deletableIds = req.userRole === 'admin' ? candidates.map((p) => p.id) : candidates.filter((p) => p.created_by === req.user.id).map((p) => p.id);
    if (deletableIds.length === 0) {
      return res.json({ deleted: 0 });
    }

    const { data: nonDraftVersions, error: versionsError } = await supabase
      .from('procedure_versions')
      .select('procedure_id')
      .in('procedure_id', deletableIds)
      .neq('status', 'draft');

    if (versionsError) {
      return res.status(500).json({ error: 'Impossible de vérifier les versions de ces procédures.' });
    }

    const nonDraftIds = new Set(nonDraftVersions.map((v) => v.procedure_id));
    const finalIds = deletableIds.filter((id) => !nonDraftIds.has(id));
    if (finalIds.length === 0) {
      return res.json({ deleted: 0 });
    }

    const { error: deleteError, count } = await supabase
      .from('procedures')
      .delete({ count: 'exact' })
      .in('id', finalIds);

    if (deleteError) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/procedures/:id — suppression réelle, réservée aux procédures qui n'ont JAMAIS
// quitté le brouillon : dès qu'une version a été soumise ne serait-ce qu'une fois (même
// rejetée depuis), elle fait partie de la piste d'audit et ne doit plus jamais disparaître —
// c'est exactement pour ce cas que le statut "obsolete" existe (voir /:id/obsolete). Réservé à
// l'auteur de la procédure ou à un admin (pas manager : contrairement à valider/rejeter, ce
// n'est pas une décision qualité sur le contenu, mais une correction d'erreur de saisie).
router.delete('/:id', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('id, created_by')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }
  if (req.userRole !== 'admin' && procedure.created_by !== req.user.id) {
    return res.status(403).json({ error: "Seul l'auteur de la procédure ou un admin peut la supprimer." });
  }

  const { data: nonDraftVersions, error: versionsError } = await supabase
    .from('procedure_versions')
    .select('id')
    .eq('procedure_id', procedure.id)
    .neq('status', 'draft')
    .limit(1);

  if (versionsError) {
    return res.status(500).json({ error: 'Impossible de vérifier les versions de cette procédure.' });
  }
  if (nonDraftVersions.length > 0) {
    return res.status(400).json({
      error:
        'Cette procédure a déjà été soumise au moins une fois et fait partie de la piste d\'audit : elle ne peut plus être supprimée, seulement marquée obsolète.',
    });
  }

  const { error: deleteError } = await supabase.from('procedures').delete().eq('id', procedure.id);
  if (deleteError) {
    return res.status(500).json({ error: 'Erreur lors de la suppression.' });
  }

  res.status(204).end();
});

// POST /api/procedures — création (statut brouillon), ouvert à tout rôle authentifié, même
// esprit que POST /api/capas (n'importe qui peut ouvrir un enregistrement qualité). Aucune
// version n'est créée ici : POST /:id/versions s'en charge séparément, une procédure peut donc
// exister brièvement sans contenu tant que sa première version n'est pas rédigée.
router.post(
  '/from-document',
  requireRole(...MANAGER_ROLES),
  [
    body('document_id').isUUID().withMessage('Document source invalide.'),
    body('number').trim().notEmpty().withMessage('Le numéro est requis.'),
    body('title').trim().notEmpty().isLength({ max: 300 }).withMessage('Le titre est requis (300 caractères maximum).'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: sourceDocument, error: sourceError } = await supabase
      .from('documents')
      .select(
        'id, category_id, number, title, description, extracted_text, version, review_date, file_path, file_name, storage_provider, category:document_categories(id, is_restricted)'
      )
      .eq('tenant_id', req.tenantId)
      .eq('id', req.body.document_id)
      .maybeSingle();

    if (sourceError) {
      console.error('Erreur lors de la lecture du document source de la procédure :', sourceError);
      return res.status(500).json({ error: 'Impossible de récupérer le document source.' });
    }
    if (!sourceDocument) {
      return res.status(404).json({ error: 'Document source introuvable.' });
    }

    const [viewableSource] = await filterViewableDocuments({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      documents: [sourceDocument],
    });
    if (!viewableSource) {
      return res.status(404).json({ error: 'Document source introuvable.' });
    }

    const { data: existingProcedure, error: existingError } = await supabase
      .from('procedures')
      .select('id, number, title, status')
      .eq('tenant_id', req.tenantId)
      .eq('source_document_id', sourceDocument.id)
      .maybeSingle();
    if (existingError) {
      console.error('Erreur lors de la recherche de la procédure déjà liée :', existingError);
      return res.status(500).json({ error: 'Impossible de vérifier si ce document a déjà été converti.' });
    }
    if (existingProcedure) {
      return res.json({ procedure: existingProcedure, already_exists: true });
    }

    let versionContent;
    try {
      versionContent = await buildImportedProcedureContent(sourceDocument, req.tenantId);
    } catch (error) {
      console.error('Erreur lors de la lecture du document source de la procédure :', error);
      return res.status(500).json({
        error: 'Impossible de préserver la structure du document source. Vérifiez que le fichier est accessible et réessayez.',
      });
    }

    const { data: procedure, error: createError } = await supabase
      .from('procedures')
      .insert({
        tenant_id: req.tenantId,
        source_document_id: sourceDocument.id,
        number: req.body.number,
        title: req.body.title,
        next_review_date: sourceDocument.review_date,
        created_by: req.user.id,
      })
      .select('id, number, title, status, source_document_id')
      .single();

    if (createError) {
      if (createError.code === '23505') {
        const { data: racedProcedure } = await supabase
          .from('procedures')
          .select('id, number, title, status')
          .eq('tenant_id', req.tenantId)
          .eq('source_document_id', sourceDocument.id)
          .maybeSingle();
        if (racedProcedure) return res.json({ procedure: racedProcedure, already_exists: true });
        return res.status(409).json({ error: 'Ce numéro de procédure est déjà utilisé. Choisissez un autre numéro.' });
      }
      console.error('Erreur lors de la création de la procédure depuis un document :', createError);
      return res.status(500).json({ error: 'Impossible de créer la procédure.' });
    }

    const { data: version, error: versionError } = await supabase
      .from('procedure_versions')
      .insert({
        tenant_id: req.tenantId,
        procedure_id: procedure.id,
        version: sourceDocument.version || '1.0',
        content: versionContent,
        author_id: req.user.id,
        attachment_file_path: sourceDocument.file_path,
        attachment_file_name: sourceDocument.file_name,
        attachment_storage_provider: sourceDocument.storage_provider,
      })
      .select('id')
      .single();

    if (versionError) {
      console.error('Erreur lors de la création de la version importée :', versionError);
      const { error: cleanupError } = await supabase
        .from('procedures')
        .delete()
        .eq('tenant_id', req.tenantId)
        .eq('id', procedure.id);
      if (cleanupError) console.error('Échec du nettoyage après la création incomplète de la procédure :', cleanupError);
      return res.status(500).json({ error: 'Impossible de préparer la première version importée.' });
    }

    res.status(201).json({ procedure: { ...procedure, current_version_id: null }, already_exists: false });
  }
);

// POST /api/procedures/:id/reimport-source — crée un nouveau brouillon structuré depuis le
// document lié, sans modifier les versions déjà enregistrées.
router.post('/:id/reimport-source', requireRole(...MANAGER_ROLES), async (req, res) => {
  const { data: procedure, error: procedureError } = await supabase
    .from('procedures')
    .select('id, source_document_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();

  if (procedureError) {
    console.error('Erreur lors de la lecture de la procédure à réimporter :', procedureError);
    return res.status(500).json({ error: 'Impossible de récupérer la procédure.' });
  }
  if (!procedure) return res.status(404).json({ error: 'Procédure introuvable.' });
  if (!(await requireProcedureView(req, res, procedure.id))) return;
  if (!procedure.source_document_id) {
    return res.status(409).json({ error: 'Aucun document source n’est lié à cette procédure.' });
  }

  const { data: sourceDocument, error: sourceError } = await supabase
    .from('documents')
    .select(
      'id, category_id, title, description, extracted_text, version, file_path, file_name, storage_provider, category:document_categories(id, is_restricted)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', procedure.source_document_id)
    .maybeSingle();

  if (sourceError) {
    console.error('Erreur lors de la lecture du document source à réimporter :', sourceError);
    return res.status(500).json({ error: 'Impossible de récupérer le document source.' });
  }
  if (!sourceDocument) return res.status(404).json({ error: 'Document source introuvable.' });

  const [viewableSource] = await filterViewableDocuments({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    documents: [sourceDocument],
  });
  if (!viewableSource) return res.status(404).json({ error: 'Document source introuvable.' });

  let content;
  try {
    content = await buildImportedProcedureContent(sourceDocument, req.tenantId);
  } catch (error) {
    console.error('Erreur lors de la lecture structurée du document source :', error);
    return res.status(500).json({
      error: 'Impossible de préserver la structure du document source. Vérifiez que le fichier est accessible et réessayez.',
    });
  }

  const { data: latestVersion, error: latestVersionError } = await supabase
    .from('procedure_versions')
    .select('version')
    .eq('tenant_id', req.tenantId)
    .eq('procedure_id', procedure.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestVersionError) {
    console.error('Erreur lors de la lecture de la dernière version de la procédure :', latestVersionError);
    return res.status(500).json({ error: 'Impossible de déterminer le numéro de la nouvelle version.' });
  }

  const { data: version, error: versionError } = await supabase
    .from('procedure_versions')
    .insert({
      tenant_id: req.tenantId,
      procedure_id: procedure.id,
      version: latestVersion ? bumpVersion(latestVersion.version) : sourceDocument.version || '1.0',
      content,
      author_id: req.user.id,
      attachment_file_path: sourceDocument.file_path,
      attachment_file_name: sourceDocument.file_name,
      attachment_storage_provider: sourceDocument.storage_provider,
    })
    .select('*, author:users!procedure_versions_author_id_fkey(id, full_name)')
    .single();

  if (versionError) {
    console.error('Erreur lors de la création du brouillon depuis le document source :', versionError);
    return res.status(500).json({ error: 'Impossible de créer le nouveau brouillon.' });
  }

  return res.status(201).json(version);
});

router.post(
  '/',
  [
    body('number').trim().notEmpty().withMessage('Le numéro est requis.'),
    // max 300 : un titre reste un intitulé, jamais le texte complet d'un sujet collé sans
    // reformulation (voir NewProcedureFullDraftModal.jsx et generateProcedureFullPlan dans
    // groq.js, qui condense désormais tout sujet en un titre court côté génération IA) — filet
    // de sécurité pour la création manuelle, qui ne passe pas par cette reformulation.
    body('title').trim().notEmpty().isLength({ max: 300 }).withMessage('Le titre est requis (300 caractères maximum).'),
    body('process').optional({ values: 'falsy' }).trim(),
    body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de révision invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('procedure'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { number, title, process, next_review_date: nextReviewDate, category_id: categoryId } = req.body;

    const { data, error } = await supabase
      .from('procedures')
      .insert({
        tenant_id: req.tenantId,
        number,
        title,
        process: process || null,
        next_review_date: nextReviewDate || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Ce numéro de procédure est déjà utilisé.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création de la procédure.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/procedures/:id/category — reclasse une procédure existante dans un autre dossier
// (ou aucun). Même garde qu'ailleurs pour ce module (voir POST /:id/versions ci-dessous) :
// admin/manager, pas l'auteur seul — reclasser change la visibilité de tout le monde, pas
// seulement le contenu de sa propre version.
router.patch(
  '/:id/category',
  requireRole(...MANAGER_ROLES),
  [body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.')],
  requireValidCategoryId('procedure'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('procedures')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*, category:categories(id, name, color, is_restricted, owner_user_id)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Procédure introuvable.' });
    }

    res.json(data);
  }
);

// POST /api/procedures/:id/versions — nouvelle version brouillon. author_id toujours
// req.user.id (jamais fourni par le client) : contrairement à assigned_to sur les CAPA, il n'y
// a pas de notion de "rédiger au nom de quelqu'un d'autre".
router.post(
  '/:id/versions',
  [
    body('content').optional().isObject().withMessage('Contenu invalide.'),
    body('ai_generated').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: procedure, error: procedureError } = await supabase
      .from('procedures')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (procedureError || !procedure) {
      return res.status(404).json({ error: 'Procédure introuvable.' });
    }

    const { data: latestVersion } = await supabase
      .from('procedure_versions')
      .select('version')
      .eq('procedure_id', procedure.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextVersion = latestVersion ? bumpVersion(latestVersion.version) : '1.0';

    const { data, error } = await supabase
      .from('procedure_versions')
      .insert({
        tenant_id: req.tenantId,
        procedure_id: procedure.id,
        version: nextVersion,
        content: req.body.content || {},
        ai_generated: req.body.ai_generated || false,
        author_id: req.user.id,
      })
      .select('*, author:users!procedure_versions_author_id_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la version.' });
    }

    res.status(201).json(data);
  }
);

async function fetchVersionForAction(req, res) {
  const { data: version, error } = await supabase
    .from('procedure_versions')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.versionId)
    .eq('procedure_id', req.params.id)
    .single();

  if (error || !version) {
    res.status(404).json({ error: 'Version introuvable.' });
    return null;
  }
  const { data: procedure, error: procedureError } = await supabase
    .from('procedures')
    .select('source_document_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();
  if (procedureError) {
    console.error('Erreur lors de la vérification de la visibilité de la procédure :', procedureError);
    res.status(500).json({ error: 'Impossible de vérifier les droits de la procédure.' });
    return null;
  }
  if (!(await requireProcedureView(req, res, procedure?.id || req.params.id))) return null;
  return version;
}

// PUT /api/procedures/:id/versions/:versionId — modifie le contenu d'une version tant qu'elle
// est encore "draft" uniquement : une fois soumise, submit/validate/reject prennent le relais
// et le contenu ne bouge plus (voir NewVersionModal côté frontend pour le seul autre moyen de
// changer du contenu, qui crée lui une toute nouvelle version). Même garde d'auteur que
// submit (canActOnVersion) : celui qui a écrit garde la main sur son propre brouillon.
router.put(
  '/:id/versions/:versionId',
  [body('content').isObject().withMessage('Contenu invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const version = await fetchVersionForAction(req, res);
    if (!version) return;

    if (!canActOnVersion(req, version)) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }
    if (version.status !== 'draft') {
      return res.status(409).json({ error: 'Seul un brouillon peut être modifié.' });
    }

    const { data, error } = await supabase
      .from('procedure_versions')
      .update({ content: req.body.content })
      .eq('id', version.id)
      .select('*, author:users!procedure_versions_author_id_fkey(id, full_name)')
      .single();

    if (error || !data) {
      return res.status(500).json({ error: 'Erreur lors de la modification.' });
    }

    res.json(data);
  }
);

// POST /api/procedures/:id/versions/:versionId/attachment — pièce jointe EN COMPLÉMENT du
// contenu structuré. Les nouveaux fichiers suivent le stockage configuré pour le tenant, tandis
// que les versions importées gardent le provider propre au document source.
router.post('/:id/versions/:versionId/attachment', upload.single('file'), async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (!canActOnVersion(req, version)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }
  if (version.status !== 'draft') {
    return res.status(409).json({ error: 'Seul un brouillon peut recevoir une pièce jointe.' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier reçu.' });
  }

  let storage;
  try {
    storage = await resolveTenantStorageProvider(req.tenantId);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  let attachmentFilePath;
  let attachmentStorageProvider = null;
  try {
    if (storage.provider === 'google_drive') {
      attachmentFilePath = await uploadFileToDrive(storage.accessToken, {
        name: req.file.originalname,
        mimeType: safeStorageContentType(req.file.mimetype),
        buffer: req.file.buffer,
        parentFolderId: storage.connection.root_folder_id,
      });
      attachmentStorageProvider = 'google_drive';
    } else {
      const safeFileName = req.file.originalname.replace(/[\\/]/g, '_');
      attachmentFilePath = `${req.tenantId}/procedures/${req.params.id}/${version.id}/${randomUUID()}-${safeFileName}`;
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(attachmentFilePath, req.file.buffer, {
          contentType: safeStorageContentType(req.file.mimetype),
          upsert: false,
        });
      if (uploadError) {
        console.error("Échec de l'upload d'une pièce jointe de procédure vers Supabase Storage :", uploadError);
        return res.status(500).json({ error: "Échec de l'upload du fichier dans le stockage documentaire." });
      }
    }
  } catch (uploadError) {
    console.error("Échec de l'upload d'une pièce jointe de procédure vers Google Drive :", uploadError);
    return res.status(500).json({ error: `Échec de l'upload vers ${storage.provider === 'google_drive' ? 'Google Drive' : 'le stockage documentaire'}.` });
  }

  const { data, error } = await supabase
    .from('procedure_versions')
    .update({
      attachment_file_path: attachmentFilePath,
      attachment_file_name: req.file.originalname,
      attachment_storage_provider: attachmentStorageProvider,
    })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de la pièce jointe." });
  }

  res.status(201).json(data);
});

// DELETE /api/procedures/:id/versions/:versionId/attachment — détache le fichier (ne le
// supprime jamais du Drive du tenant, qui reste seul propriétaire de ce qu'il y stocke) — même
// garde que l'ajout.
router.delete('/:id/versions/:versionId/attachment', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (!canActOnVersion(req, version)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }
  if (version.status !== 'draft') {
    return res.status(409).json({ error: 'Seul un brouillon peut être modifié.' });
  }

  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ attachment_file_path: null, attachment_file_name: null, attachment_storage_provider: null })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Erreur lors du retrait de la pièce jointe.' });
  }

  res.json(data);
});

// GET /api/procedures/:id/versions/:versionId/attachment — lien de téléchargement à durée de
// vie courte, même proxy signé que documents.js (GET /api/documents/drive-file) : le ticket ne
// porte que tenantId/fileId/fileName, il n'a jamais eu besoin de savoir qu'un document ou une
// procédure l'a émis.
router.get('/:id/versions/:versionId/attachment', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (!version.attachment_file_path) {
    return res.status(404).json({ error: 'Aucune pièce jointe pour cette version.' });
  }

  const url =
    version.attachment_storage_provider === 'google_drive'
      ? `${req.protocol}://${req.get('host')}/api/documents/drive-file?ticket=${encodeURIComponent(signDownloadTicket(req.tenantId, version.attachment_file_path, version.attachment_file_name))}`
      : supabase.storage.from(STORAGE_BUCKET).getPublicUrl(version.attachment_file_path).data.publicUrl;
  res.json({ url });
});

// POST /api/procedures/:id/versions/:versionId/check-compliance — vérifie le contenu de cette
// version contre le gabarit du tenant. Le résultat est persisté, sans décision de validation.
aiResultRoute(router, '/:id/versions/:versionId/check-compliance', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const template = await fetchTenantTemplate(req.tenantId);

  try {
    if (!(await prepareAiResult(req, res))) return;
    const result = await checkProcedureTemplateCompliance(version.content, template);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: `Impossible de vérifier la conformité : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/compliance-fix — suite de check-compliance :
// à partir d'une anomalie déjà détectée (section_key/issue/severity, tels que renvoyés par
// check-compliance), propose un contenu corrigé pour cette seule section. Même garde que
// check-compliance : la proposition est persistée ; l'auteur l'applique dans l'éditeur avant
// d'enregistrer via PUT /:id/versions/:versionId, qui reste seul à vérifier canActOnVersion/
// le statut "draft".
aiResultRoute(router,
  '/:id/versions/:versionId/compliance-fix',
  [
    body('section_key').trim().notEmpty().withMessage('Section requise.'),
    body('issue').trim().notEmpty().withMessage('Anomalie requise.'),
    body('severity').optional({ values: 'falsy' }).isIn(['minor', 'major', 'blocking']).withMessage('Sévérité invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const version = await fetchVersionForAction(req, res);
    if (!version) return;

    const { data: procedure } = await supabase
      .from('procedures')
      .select('title, process')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();

    const template = await fetchTenantTemplate(req.tenantId);
    const section = (version.content?.sections || []).find((s) => s.key === req.body.section_key);

    try {
      if (!(await prepareAiResult(req, res))) return;
      const result = await generateProcedureComplianceFix({
        procedureTitle: procedure?.title,
        procedureProcess: procedure?.process,
        template,
        procedureContent: version.content,
        sectionKey: req.body.section_key,
        sectionLabel: section?.label,
        currentSectionContent: section ? blocksToPlainText(section.blocks) : null,
        issue: req.body.issue,
        severity: req.body.severity,
      });
      res.json({ section_key: req.body.section_key, ...result });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer une correction : ${err.message}` });
    }
  }
);

// POST /api/procedures/:id/versions/:versionId/compare — compare cette version à celle qui la
// précède immédiatement pour la même procédure (previous = null pour une toute première
// version, voir compareProcedureVersions dans groq.js qui gère ce cas explicitement).
aiResultRoute(router, '/:id/versions/:versionId/compare', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const { data: previousVersion } = await supabase
    .from('procedure_versions')
    .select('content')
    .eq('procedure_id', req.params.id)
    .neq('id', version.id)
    .lt('created_at', version.created_at)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  try {
    if (!(await prepareAiResult(req, res))) return;
    const result = await compareProcedureVersions(previousVersion?.content ?? null, version.content);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: `Impossible de comparer les versions : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/distribution-sheet — résumé condensé pour un
// public cible qui doit connaître la procédure sans nécessairement la lire en entier. Réservé
// à une version APPROVED (contrairement à check-compliance/compare, valables sur un
// brouillon) : diffuser un résumé d'un texte pas encore validé n'aurait pas de sens.
// Contrairement à check-compliance/compare, PERSISTÉ sur la version (voir schema.sql) pour
// être réaffiché en priorité dans la bannière d'accusé de lecture de ProcedureDetail.jsx à
// chaque chargement, pas seulement au moment de sa génération.
aiResultRoute(router,
  '/:id/versions/:versionId/distribution-sheet',
  [body('target_audience').optional({ values: 'falsy' }).trim()],
  async (req, res) => {
    const version = await fetchVersionForAction(req, res);
    if (!version) return;

    if (version.status !== 'approved') {
      return res.status(409).json({ error: 'Seule une version approuvée peut avoir une fiche de diffusion.' });
    }

    let sheet;
    try {
      if (!(await prepareAiResult(req, res, {
        existingResult: version.distribution_sheet ? version : null,
        onDelete: async () => {
          const { error } = await supabase.from('procedure_versions').update({ distribution_sheet: null })
            .eq('tenant_id', req.tenantId).eq('id', version.id);
          if (error) throw new Error('Impossible de supprimer la fiche de diffusion.');
        },
      }))) return;
      sheet = await generateProcedureDistributionSheet(version.content, req.body.target_audience);
      if (!validAiResult('/api/procedures/distribution-sheet', { distribution_sheet: sheet })) throw new Error('Fiche IA incomplète ou invalide.');
    } catch (err) {
      return res.status(503).json({ error: `Impossible de générer la fiche de diffusion : ${err.message}` });
    }

    const distributionSheet = { ...sheet, target_audience: req.body.target_audience || null, generated_at: new Date().toISOString() };

    const { data, error } = await supabase
      .from('procedure_versions')
      .update({ distribution_sheet: distributionSheet })
      .eq('id', version.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la fiche de diffusion." });
    }

    res.json(data);
  }
);

// POST /api/procedures/:id/versions/:versionId/export-word — transforme le contenu structuré
// de la version en document Word (.docx) téléchargeable, mis en forme selon le dernier preset
// appliqué au gabarit du tenant (voir procedure_templates.active_preset_id,
// services/procedureWord.js — repli sur un style neutre si aucun preset n'a jamais été
// appliqué). Rendu déterministe, aucun appel IA ici : contrairement à generate-draft/
// generate-full-draft qui PRODUISENT le contenu, cette route ne fait que le METTRE EN FORME —
// disponible sur n'importe quelle version quel que soit son statut, même permissivité que
// GET /:id/pdf (le but explicite est d'obtenir un brouillon "prêt à relire", pas seulement un
// document déjà approuvé).
router.post('/:id/versions/:versionId/export-word', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();
  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }

  const { data: versions } = await supabase
    .from('procedure_versions')
    .select('*, author:users!procedure_versions_author_id_fkey(id, full_name), validator:users!procedure_versions_validator_id_fkey(id, full_name)')
    .eq('procedure_id', procedure.id)
    .order('created_at', { ascending: false });

  // fetchVersionForAction ne résout pas author/validator : on réutilise la ligne équivalente
  // de `versions` (déjà résolue ci-dessus) plutôt que refaire une requête pour la même version.
  const versionWithNames = versions?.find((v) => v.id === version.id) || version;

  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, logo_url, company_address, company_phone, company_legal_mentions')
    .eq('id', req.tenantId)
    .single();
  const template = await fetchTenantTemplate(req.tenantId);
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);

  let docxBuffer;
  try {
    docxBuffer = await buildProcedureWordDocument({
      accentColor: template.accent_color,
      visualOptions: template.visual_options,
      tenantLogo,
      tenantName: tenant?.name,
      tenantAddress: tenant?.company_address,
      tenantPhone: tenant?.company_phone,
      tenantLegalMentions: tenant?.company_legal_mentions,
      procedure,
      version: versionWithNames,
      versions,
    });
  } catch (err) {
    console.error('Échec de la génération du document Word :', err);
    return res.status(500).json({ error: 'Impossible de générer le document Word.' });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${procedure.number}.docx"`);
  res.send(docxBuffer);
});

// POST /api/procedures/:id/suggest-revision-from-capa — à partir d'un CAPA déjà lié à cette
// procédure (voir procedure_capa_links / POST .../link-capa), propose les sections à réviser.
// Persiste la proposition sans modifier la procédure : à l'auteur
// de choisir de préremplir une nouvelle version avec ou de l'ignorer.
aiResultRoute(router, '/:id/suggest-revision-from-capa', [body('capa_id').isUUID().withMessage('CAPA invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const { data: link } = await supabase
    .from('procedure_capa_links')
    .select('capa:capas(id, title, root_cause, corrective_action, preventive_action)')
    .eq('tenant_id', req.tenantId)
    .eq('procedure_id', req.params.id)
    .eq('capa_id', req.body.capa_id)
    .maybeSingle();

  if (!link) {
    return res.status(404).json({ error: "Ce CAPA n'est pas lié à cette procédure." });
  }

  const { data: procedure } = await supabase
    .from('procedures')
    .select('id, current_version_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();

  if (!procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }

  if (!(await requireProcedureView(req, res, procedure.id))) return;

  let currentContent = null;
  if (procedure.current_version_id) {
    const { data: currentVersion } = await supabase
      .from('procedure_versions')
      .select('content, status')
      .eq('id', procedure.current_version_id)
      .maybeSingle();
    if (currentVersion?.status === 'approved') {
      currentContent = currentVersion.content ?? null;
    }
  }

  try {
    if (!(await prepareAiResult(req, res))) return;
    const suggestion = await suggestProcedureRevisionFromCapa(link.capa, currentContent);
    res.json(suggestion);
  } catch (err) {
    res.status(503).json({ error: `Impossible de générer une suggestion de révision : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/submit — passage en attente de validation
// ("en_validation"). Réservé à l'auteur de CETTE version, ou admin/manager.
router.post('/:id/versions/:versionId/submit', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (!canActOnVersion(req, version)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }
  if (version.status !== 'draft') {
    return res.status(409).json({ error: 'Cette version a déjà été soumise.' });
  }

  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ status: 'pending', submitted_at: new Date().toISOString(), comment: null })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Erreur lors de la soumission.' });
  }

  const { data: procedure } = await supabase
    .from('procedures')
    .update({ status: 'in_review' })
    .eq('id', req.params.id)
    .select('id, number, title')
    .single();

  // Envoi immédiat à tout admin/manager du tenant (pas d'approbateur nommé à l'avance pour ce
  // module, voir /validate) — ne doit pas attendre le batch quotidien, même principe que
  // documents.js#submit-for-approval. Le soumetteur lui-même est exclu s'il est admin/manager :
  // se notifier de sa propre soumission n'apporte rien.
  if (procedure) {
    (async () => {
      try {
        const [requesterName, { data: managers }] = await Promise.all([
          getUserFullName(req.user.id),
          supabase.from('users').select('id').eq('tenant_id', req.tenantId).in('role', MANAGER_ROLES),
        ]);

        for (const manager of managers || []) {
          if (manager.id === req.user.id) continue;
          await sendImmediateNotification({
            tenantId: req.tenantId,
            userId: manager.id,
            prefField: 'email_approval_requests',
            notificationType: 'procedure_validation_request',
            referenceId: version.id,
            templateName: 'procedureValidationRequest',
            subject: `Validation requise : ${procedure.number}`,
            variables: {
              requesterName,
              procedureNumber: procedure.number,
              procedureTitle: procedure.title,
              procedureUrl: `${process.env.FRONTEND_URL}/procedures/${procedure.id}`,
            },
            notificationTitle: 'Validation de procédure requise',
            notificationMessage: `${procedure.number} — ${procedure.title}`,
            notificationLink: `/procedures/${procedure.id}`,
          });
        }
      } catch (err) {
        console.error('Échec de la notification de demande de validation de procédure :', err.message);
      }
    })();
  }

  res.json(data);
});

// POST /api/procedures/:id/versions/:versionId/validate — réservé aux admins/managers.
// La validation indépendante reste préférable, mais un administrateur ou manager peut aussi
// approuver sa propre version lorsqu'il travaille seul.
router.post('/:id/versions/:versionId/validate', requireRole(...MANAGER_ROLES), async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  if (version.status !== 'pending') {
    return res.status(409).json({ error: "Cette version n'est pas en attente de validation." });
  }
  const validatedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ status: 'approved', validator_id: req.user.id, validated_at: validatedAt })
    .eq('id', version.id)
    .select()
    .single();

  if (error || !data) {
    return res.status(500).json({ error: 'Erreur lors de la validation.' });
  }

  await supabase.from('procedures').update({ status: 'approved', current_version_id: version.id }).eq('id', req.params.id);

  res.json(data);
});

// POST /api/procedures/:id/versions/:versionId/reject — retour au rédacteur, commentaire
// obligatoire. La procédure repasse en "draft" : la version rejetée reste consultable
// (traçabilité), mais n'est plus la version courante (elle ne l'était de toute façon jamais
// devenue, seule /validate touche current_version_id).
router.post(
  '/:id/versions/:versionId/reject',
  requireRole(...MANAGER_ROLES),
  [body('comment').trim().notEmpty().withMessage('Un commentaire est requis en cas de rejet.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const version = await fetchVersionForAction(req, res);
    if (!version) return;

    if (version.status !== 'pending') {
      return res.status(409).json({ error: "Cette version n'est pas en attente de validation." });
    }

    const { data, error } = await supabase
      .from('procedure_versions')
      .update({
        status: 'rejected',
        validator_id: req.user.id,
        validated_at: new Date().toISOString(),
        comment: req.body.comment,
      })
      .eq('id', version.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: 'Erreur lors du rejet.' });
    }

    await supabase.from('procedures').update({ status: 'draft' }).eq('id', req.params.id);

    res.json(data);
  }
);

// POST /api/procedures/:id/acknowledge — accusé de lecture de la version COURANTE (celle
// pointée par procedures.current_version_id), même principe que POST /documents/:id/acknowledge.
router.post('/:id/acknowledge', async (req, res) => {
  const { data: procedure, error } = await supabase
    .from('procedures')
    .select('id, current_version_id, current_version:procedure_versions!procedures_current_version_id_fkey(status)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }
  if (!procedure.current_version_id || procedure.current_version?.status !== 'approved') {
    return res.status(400).json({ error: 'Aucune version approuvée à accuser réception.' });
  }

  const { data: acknowledgment, error: ackError } = await supabase
    .from('procedure_acknowledgments')
    .upsert(
      { tenant_id: req.tenantId, procedure_version_id: procedure.current_version_id, user_id: req.user.id },
      { onConflict: 'procedure_version_id,user_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (ackError || !acknowledgment) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de l'accusé de lecture." });
  }

  res.status(201).json(acknowledgment);
});

// POST /api/procedures/:id/obsolete — retire une procédure de la circulation SANS jamais la
// supprimer (piste d'audit) : le statut "obsolete" existe dans la contrainte SQL depuis la
// création du module mais n'était jusqu'ici atteignable par aucune route. Même niveau de
// permission que la validation d'une version (admin/manager) : une décision qualité, pas une
// action de rédaction — voir /validate ci-dessus.
router.post(
  '/:id/obsolete',
  requireRole(...MANAGER_ROLES),
  [body('reason').trim().notEmpty().withMessage('Un motif est requis pour mettre une procédure à l’obsolescence.')],
  async (req, res) => {
    const { data: procedure, error: fetchError } = await supabase
      .from('procedures')
      .select('id, status')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !procedure) {
      return res.status(404).json({ error: 'Procédure introuvable.' });
    }
    if (procedure.status === 'obsolete') {
      return res.status(409).json({ error: 'Cette procédure est déjà obsolète.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('procedures')
      .update({
        status: 'obsolete',
        obsolete_reason: req.body.reason,
        obsoleted_at: new Date().toISOString(),
        obsoleted_by: req.user.id,
      })
      .eq('id', procedure.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors du passage à l'obsolescence." });
    }

    res.json(data);
  }
);

// POST /api/procedures/:id/link-capa — rattache un CAPA existant à cette procédure (traçabilité
// qualité : une procédure révisée suite à une non-conformité). Ouvert à tout rôle authentifié,
// même esprit que le reste du module — ni le CAPA ni la procédure ne changent de contenu,
// simple lien de traçabilité. Appelable aussi bien depuis ProcedureDetail.jsx que depuis
// CapaDetail.jsx (le sens le plus fréquent en pratique, voir le body { capa_id }).
router.post('/:id/link-capa', [body('capa_id').isUUID().withMessage('CAPA invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const [{ data: procedure }, { data: capa }] = await Promise.all([
    supabase.from('procedures').select('id').eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle(),
    supabase.from('capas').select('id, number, title, status').eq('tenant_id', req.tenantId).eq('id', req.body.capa_id).maybeSingle(),
  ]);

  if (!procedure) return res.status(404).json({ error: 'Procédure introuvable.' });
  if (!capa) return res.status(404).json({ error: 'CAPA introuvable.' });

  const { error } = await supabase.from('procedure_capa_links').insert({
    tenant_id: req.tenantId,
    procedure_id: procedure.id,
    capa_id: capa.id,
    created_by: req.user.id,
  });

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ce CAPA est déjà lié à cette procédure.' });
    }
    return res.status(500).json({ error: 'Erreur lors de la création du lien.' });
  }

  res.status(201).json(capa);
});

// DELETE /api/procedures/:id/link-capa/:capaId — retire le lien, jamais le CAPA ni la
// procédure eux-mêmes.
router.delete('/:id/link-capa/:capaId', async (req, res) => {
  const { error, count } = await supabase
    .from('procedure_capa_links')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('procedure_id', req.params.id)
    .eq('capa_id', req.params.capaId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du lien.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Lien introuvable.' });
  }

  res.status(204).end();
});

// POST /api/procedures/:id/link-audit et DELETE .../link-audit/:auditId — même principe que
// link-capa ci-dessus, pour le module Audits.
router.post('/:id/link-audit', [body('audit_id').isUUID().withMessage('Audit invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const [{ data: procedure }, { data: audit }] = await Promise.all([
    supabase.from('procedures').select('id').eq('tenant_id', req.tenantId).eq('id', req.params.id).maybeSingle(),
    supabase.from('audits').select('id, title, planned_date, status').eq('tenant_id', req.tenantId).eq('id', req.body.audit_id).maybeSingle(),
  ]);

  if (!procedure) return res.status(404).json({ error: 'Procédure introuvable.' });
  if (!audit) return res.status(404).json({ error: 'Audit introuvable.' });

  const { error } = await supabase.from('procedure_audit_links').insert({
    tenant_id: req.tenantId,
    procedure_id: procedure.id,
    audit_id: audit.id,
    created_by: req.user.id,
  });

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Cet audit est déjà lié à cette procédure.' });
    }
    return res.status(500).json({ error: 'Erreur lors de la création du lien.' });
  }

  res.status(201).json(audit);
});

router.delete('/:id/link-audit/:auditId', async (req, res) => {
  const { error, count } = await supabase
    .from('procedure_audit_links')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('procedure_id', req.params.id)
    .eq('audit_id', req.params.auditId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du lien.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Lien introuvable.' });
  }

  res.status(204).end();
});

export default router;
