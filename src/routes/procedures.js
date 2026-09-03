import { Router } from 'express';
import multer from 'multer';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { sendImmediateNotification, getUserFullName } from '../services/notificationHelpers.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildProcedurePdf } from '../services/procedurePdf.js';
import { resolveTenantStorageProvider, safeStorageContentType } from '../services/tenantStorage.js';
import { signDownloadTicket } from '../services/driveDownloadTicket.js';
import { uploadFile as uploadFileToDrive } from '../services/googleDrive.js';
import { isSharedWithUser } from '../services/recordSharing.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import {
  generateProcedureDraft,
  generateProcedureDraftFromQqoqccp,
  checkProcedureTemplateCompliance,
  compareProcedureVersions,
  generateProcedureDistributionSheet,
  suggestProcedureRevisionFromCapa,
} from '../services/groq.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  defParamCharset: 'utf8',
});

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];
const PROCEDURE_STATUSES = ['draft', 'in_review', 'approved', 'obsolete'];

router.use(requireAuth);
router.use(requireMenuVisible('procedures'));

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
// routes/procedureTemplates.js#DEFAULT_SECTION_STRUCTURE) tant qu'aucun gabarit n'est
// réellement enregistré — sans quoi generate-draft/check-compliance/generate-draft-from-
// qqoqccp verraient un gabarit "vide" différent de celui affiché à l'écran par
// ProcedureSectionsEditor, et rédigeraient une procédure sans aucune section de contenu réel.
const DEFAULT_SECTION_STRUCTURE = [{ key: 'etapes', label: 'Étapes du processus' }];

async function fetchTenantTemplate(tenantId) {
  const { data } = await supabase.from('procedure_templates').select('*').eq('tenant_id', tenantId).maybeSingle();
  return data || { tenant_id: tenantId, section_structure: DEFAULT_SECTION_STRUCTURE };
}

// POST /api/procedures/generate-draft — appelé depuis le formulaire de création, AVANT que la
// procédure existe : rien n'est persisté ici, le frontend préremplit juste l'éditeur avec le
// résultat (éditable, jamais publié tel quel — voir POST /:id/versions pour la vraie création).
router.post(
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
      const draft = await generateProcedureDraft({ title: req.body.title, process: req.body.process }, template);
      res.json(draft);
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer un brouillon IA : ${err.message}` });
    }
  }
);

// POST /api/procedures/generate-draft-from-qqoqccp — même principe que /generate-draft ci-
// dessus (rien n'est persisté, préremplit juste le formulaire de création), mais informé par
// une analyse QQOQCCP existante plutôt qu'un titre/processus tapés à la main : la procédure
// est créée PARCE QUE ce diagnostic a révélé un manque à formaliser (voir
// QqoqccpDetail.jsx#handleCreateProcedure). Même vérification de permission que
// GET /api/qqoqccp/:id (catégorie restreinte ou partage individuel), dupliquée ici plutôt que
// mutualisée : ce n'est qu'une lecture, pas une action sur l'analyse elle-même.
router.post(
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
      const draft = await generateProcedureDraftFromQqoqccp(analysis, template);
      res.json({ ...draft, title: analysis.title });
    } catch (err) {
      res.status(503).json({ error: `Impossible de générer un brouillon IA : ${err.message}` });
    }
  }
);

// GET /api/procedures — liste, filtrable par statut/processus/recherche texte. Pas de système
// de catégories pour ce module (contrairement à CAPA/Documents) : ouvert à tout rôle
// authentifié, comme la lecture des audits/CAPA.
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

    res.json(data);
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
      '*, current_version:procedure_versions!procedures_current_version_id_fkey(id, version, status), obsoleted_by_user:users!procedures_obsoleted_by_fkey(id, full_name)'
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
  if (procedure.current_version_id) {
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

  const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
  const pdfBuffer = await buildProcedurePdf({ tenantName: tenant?.name, tenantLogo, procedure, version, versions });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${procedure.number}.pdf"`);
  res.send(pdfBuffer);
});

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
  '/',
  [
    body('number').trim().notEmpty().withMessage('Le numéro est requis.'),
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('process').optional({ values: 'falsy' }).trim(),
    body('next_review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de révision invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { number, title, process, next_review_date: nextReviewDate } = req.body;

    const { data, error } = await supabase
      .from('procedures')
      .insert({
        tenant_id: req.tenantId,
        number,
        title,
        process: process || null,
        next_review_date: nextReviewDate || null,
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
// contenu structuré, jamais à sa place (voir schema.sql) : le document officiel que le client
// possédait déjà, attaché tel quel à une version encore en brouillon. Drive-only, pas de repli
// Supabase comme documents.js — un tenant qui n'a pas activé Drive n'a simplement pas cette
// fonctionnalité (message actionnable ci-dessous), plutôt que de réimporter tout le mécanisme
// dual-provider (dossiers de catégorie, ticket de prévisualisation...) pour une pièce jointe
// occasionnelle. Même garde que PUT ci-dessus : auteur ou admin/manager, brouillon uniquement.
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
  if (storage.provider !== 'google_drive') {
    return res.status(400).json({
      error:
        "Google Drive n'est pas activé pour votre entreprise — activez-le depuis Paramètres > Documents pour joindre un fichier.",
    });
  }

  let driveFileId;
  try {
    driveFileId = await uploadFileToDrive(storage.accessToken, {
      name: req.file.originalname,
      mimeType: safeStorageContentType(req.file.mimetype),
      buffer: req.file.buffer,
      parentFolderId: storage.connection.root_folder_id,
    });
  } catch (uploadError) {
    console.error("Échec de l'upload d'une pièce jointe de procédure vers Google Drive :", uploadError);
    return res.status(500).json({ error: "Échec de l'upload vers Google Drive." });
  }

  const { data, error } = await supabase
    .from('procedure_versions')
    .update({ attachment_drive_file_id: driveFileId, attachment_file_name: req.file.originalname })
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
    .update({ attachment_drive_file_id: null, attachment_file_name: null })
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

  if (!version.attachment_drive_file_id) {
    return res.status(404).json({ error: 'Aucune pièce jointe pour cette version.' });
  }

  const ticket = signDownloadTicket(req.tenantId, version.attachment_drive_file_id, version.attachment_file_name);
  res.json({ url: `${req.protocol}://${req.get('host')}/api/documents/drive-file?ticket=${encodeURIComponent(ticket)}` });
});

// POST /api/procedures/:id/versions/:versionId/check-compliance — vérifie le contenu de cette
// version contre le gabarit du tenant. Rien n'est persisté (ni le résultat, ni un flag sur la
// version) : c'est une aide avant soumission, pas une décision enregistrée.
router.post('/:id/versions/:versionId/check-compliance', async (req, res) => {
  const version = await fetchVersionForAction(req, res);
  if (!version) return;

  const template = await fetchTenantTemplate(req.tenantId);

  try {
    const result = await checkProcedureTemplateCompliance(version.content, template);
    res.json(result);
  } catch (err) {
    res.status(503).json({ error: `Impossible de vérifier la conformité : ${err.message}` });
  }
});

// POST /api/procedures/:id/versions/:versionId/compare — compare cette version à celle qui la
// précède immédiatement pour la même procédure (previous = null pour une toute première
// version, voir compareProcedureVersions dans groq.js qui gère ce cas explicitement).
router.post('/:id/versions/:versionId/compare', async (req, res) => {
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
router.post(
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
      sheet = await generateProcedureDistributionSheet(version.content, req.body.target_audience);
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

// POST /api/procedures/:id/suggest-revision-from-capa — à partir d'un CAPA déjà lié à cette
// procédure (voir procedure_capa_links / POST .../link-capa), propose les sections à réviser.
// Ne persiste rien (comme generate-draft) : le résultat n'est qu'une proposition, à l'auteur
// de choisir de préremplir une nouvelle version avec ou de l'ignorer.
router.post('/:id/suggest-revision-from-capa', [body('capa_id').isUUID().withMessage('CAPA invalide.')], async (req, res) => {
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

  let currentContent = null;
  if (procedure.current_version_id) {
    const { data: currentVersion } = await supabase
      .from('procedure_versions')
      .select('content')
      .eq('id', procedure.current_version_id)
      .maybeSingle();
    currentContent = currentVersion?.content ?? null;
  }

  try {
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

// POST /api/procedures/:id/versions/:versionId/validate — même principe que la vérification
// d'efficacité CAPA (requireRole admin/manager) : pas d'approbateur désigné à l'avance,
// n'importe quel admin/manager du tenant peut valider une version en attente.
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
    .select('id, current_version_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !procedure) {
    return res.status(404).json({ error: 'Procédure introuvable.' });
  }
  if (!procedure.current_version_id) {
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
  [body('reason').optional({ values: 'falsy' }).trim()],
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

    const { data, error } = await supabase
      .from('procedures')
      .update({
        status: 'obsolete',
        obsolete_reason: req.body.reason || null,
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
