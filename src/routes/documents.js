import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { buildCertificatePdf } from '../services/certificatePdf.js';
import { sendImmediateNotification, getUserFullName } from '../services/notificationHelpers.js';
import { extractText } from '../services/textExtraction.js';
import { sanitizeFileName } from '../utils/storagePath.js';
import { parseExcelBuffer } from '../services/excelParsing.js';
import {
  refreshAccessTokenIfNeeded,
  uploadFile as uploadFileToDrive,
  getDriveFileStream,
  getOrCreateCategoryFolder,
  getFileWebViewLink,
} from '../services/googleDrive.js';
import {
  requireCategoryPermission,
  filterViewableDocuments,
  resolveDocumentById,
  resolveCategoryFromBody,
  hasCategoryPermission,
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

// Un document peut légitimement être de presque n'importe quel type (Word, Excel, PDF,
// image scannée...) — on ne rejette donc aucun upload sur son type. En revanche le bucket est
// public (getPublicUrl) et le type stocké vient tel quel du client (file.mimetype) : un fichier
// HTML/SVG/JS uploadé avec ce content-type s'ouvrirait et s'exécuterait dans le navigateur au
// lieu de se télécharger — XSS stocké. On neutralise seulement ces types "actifs" en les
// stockant comme flux binaire générique (toujours téléchargé, jamais rendu/exécuté), sans
// bloquer l'upload lui-même.
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
]);

function safeStorageContentType(mimetype) {
  return ACTIVE_CONTENT_TYPES.has(mimetype) ? 'application/octet-stream' : mimetype;
}

function getTicketSecret() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    const err = new Error('ENCRYPTION_KEY est manquant.');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

// Ticket signé, à durée de vie courte, pour /drive-file : cette route est atteinte par une
// navigation navigateur classique (window.open depuis le frontend), qui ne porte pas notre
// en-tête Authorization — elle ne peut donc pas passer par requireAuth comme le reste de ce
// routeur. La permission de consultation est déjà vérifiée avant l'émission du ticket (par
// requireCategoryPermission sur GET /:id/download et GET /:id/versions/:versionId/download) ;
// le ticket transporte directement le fileId Drive déjà résolu (pas un id de document/version)
// pour que ce même proxy serve indifféremment un document courant ou une ancienne version
// archivée, sans avoir à re-consulter la bonne table pour savoir laquelle. Nom de fichier
// encodé en base64url : évite qu'un ':' dans un nom de fichier réel ne casse le split ci-dessous.
const DOWNLOAD_TICKET_TTL_MS = 5 * 60 * 1000;

function signDownloadTicket(tenantId, driveFileId, fileName) {
  const expiresAt = Date.now() + DOWNLOAD_TICKET_TTL_MS;
  const fileNameB64 = Buffer.from(fileName || '', 'utf8').toString('base64url');
  const payload = `${tenantId}:${driveFileId}:${fileNameB64}:${expiresAt}`;
  const signature = createHmac('sha256', getTicketSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyDownloadTicket(ticket) {
  const raw = String(ticket || '');
  const separatorIndex = raw.lastIndexOf('.');
  if (separatorIndex === -1) return null;

  const payload = raw.slice(0, separatorIndex);
  const signature = raw.slice(separatorIndex + 1);
  const expected = createHmac('sha256', getTicketSecret()).update(payload).digest('hex');

  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const [tenantId, driveFileId, fileNameB64, expiresAtStr] = payload.split(':');
  const expiresAt = Number(expiresAtStr);
  if (!tenantId || !driveFileId || !expiresAt || Date.now() > expiresAt) return null;

  return { tenantId, driveFileId, fileName: fileNameB64 ? Buffer.from(fileNameB64, 'base64url').toString('utf8') : null };
}

// GET /api/documents/drive-file — proxy de streaming pour les fichiers (documents courants ET
// anciennes versions archivées) stockés sur Google Drive, authentifié par ticket signé (voir
// ci-dessus) plutôt que par requireAuth. Sans ce proxy, il faudrait soit un lien Drive direct
// en "quiconque a le lien" (contourne entièrement le RBAC par catégorie de l'app pour les
// catégories restreintes), soit envoyer le Bearer token depuis une simple navigation
// (impossible) — d'où ce détour.
router.get('/drive-file', async (req, res) => {
  const verified = verifyDownloadTicket(req.query.ticket);
  if (!verified) {
    return res.status(403).json({ error: 'Lien de téléchargement invalide ou expiré.' });
  }

  let accessToken;
  try {
    accessToken = await getTenantDriveAccessToken(verified.tenantId);
  } catch (tokenError) {
    return res.status(tokenError.statusCode || 500).json({ error: tokenError.message });
  }

  try {
    const driveStream = await getDriveFileStream(accessToken, verified.driveFileId);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(verified.fileName || 'document')}"`);
    driveStream.on('error', (streamErr) => {
      console.error('Erreur de streaming depuis Google Drive :', streamErr);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    driveStream.pipe(res);
  } catch (streamError) {
    console.error('Échec du streaming du fichier Google Drive :', streamError);
    res.status(500).json({ error: 'Impossible de récupérer le fichier depuis Google Drive.' });
  }
});

router.use(requireAuth);

function bumpVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(version ?? '');
  if (match) {
    return `${match[1]}.${Number(match[2]) + 1}`;
  }
  return `${version}.1`;
}

// Number(months) en filet de sécurité : date.getMonth() + "1" concatène des chaînes ("71")
// au lieu d'additionner, ce qui projette la date des années dans le futur sans jamais planter
// (voir le bug "2031" corrigé dans tenant.js, même helper dupliqué).
function addMonthsIso(dateStr, months) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + Number(months));
  return date.toISOString().slice(0, 10);
}

// Accepte une date déjà ISO (yyyy-mm-dd, produite par une cellule Excel native ou une saisie
// directe) ou une saisie française JJ/MM/AAAA — le format le plus naturel dans un modèle
// d'import destiné à des utilisateurs francophones. Renvoie null si rien ne correspond,
// plutôt que de planter sur une valeur mal formée.
function parseFlexibleDate(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(str);
  if (match) {
    const [, day, month, year] = match;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
}

async function uploadToStorage(path, file) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file.buffer, { contentType: safeStorageContentType(file.mimetype), upsert: false });

  if (error) {
    console.error("Échec de l'upload d'un document vers le storage :", error);
    throw new Error("Échec de l'upload du fichier.");
  }
}

// Connexion Drive + access_token valides pour un tenant, ou lève une erreur avec un
// statusCode/message déjà prêts à renvoyer tels quels — factorisé, utilisé par le proxy de
// téléchargement (/drive-file) et par la résolution du lien "Ouvrir dans Google Drive" (F2).
async function getTenantDriveAccessToken(tenantId) {
  const { data: connection, error } = await supabase
    .from('google_drive_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !connection) {
    const err = new Error('La connexion Google Drive de cette entreprise est introuvable.');
    err.statusCode = 409;
    throw err;
  }

  try {
    return await refreshAccessTokenIfNeeded(connection);
  } catch (refreshError) {
    console.error('Échec du rafraîchissement du token Google Drive :', refreshError.message);
    const err = new Error('La connexion Google Drive a expiré — reconnectez-vous depuis Paramètres > Documents.');
    err.statusCode = 409;
    throw err;
  }
}

// Résout où un nouvel upload doit atterrir pour ce tenant. Ne retombe JAMAIS silencieusement
// sur Supabase si Google Drive est activé mais inutilisable (connexion révoquée, refresh en
// échec) : un repli silencieux disperserait les documents entre deux stockages sans que
// personne ne le remarque avant longtemps. err.driveConnectionError marque cette erreur pour
// que l'appelant renvoie un message actionnable ("reconnectez-vous") plutôt qu'un 500 générique.
async function resolveTenantStorageProvider(tenantId) {
  const { data: settings } = await supabase
    .from('tenant_storage_settings')
    .select('storage_provider')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!settings || settings.storage_provider !== 'google_drive') {
    return { provider: 'supabase' };
  }

  const { data: connection, error } = await supabase
    .from('google_drive_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !connection) {
    const err = new Error(
      "Google Drive est activé pour votre entreprise mais aucune connexion n'a été trouvée — reconnectez-vous depuis Paramètres > Documents."
    );
    err.driveConnectionError = true;
    throw err;
  }

  try {
    const accessToken = await refreshAccessTokenIfNeeded(connection);
    return { provider: 'google_drive', connection, accessToken };
  } catch (refreshError) {
    console.error('Échec du rafraîchissement du token Google Drive (upload) :', refreshError.message);
    const err = new Error(
      'La connexion Google Drive a expiré ou a été révoquée — reconnectez-vous depuis Paramètres > Documents.'
    );
    err.driveConnectionError = true;
    throw err;
  }
}

// Dossier de destination sur Drive pour une catégorie donnée : dossier racine si le document
// n'a pas de catégorie, sinon son sous-dossier dédié — créé au premier upload de cette
// catégorie puis mis en cache dans category_folder_ids pour éviter un appel Drive
// (list-then-create) à chaque upload suivant de la même catégorie.
async function resolveDriveDestinationFolder(connection, accessToken, categoryId) {
  if (!categoryId) return connection.root_folder_id;

  const cached = connection.category_folder_ids?.[categoryId];
  if (cached) return cached;

  const { data: category } = await supabase.from('document_categories').select('name').eq('id', categoryId).single();
  const categoryName = category?.name || 'Sans catégorie';

  const folderId = await getOrCreateCategoryFolder(accessToken, connection.root_folder_id, categoryName);

  const updatedCache = { ...(connection.category_folder_ids || {}), [categoryId]: folderId };
  const { error: cacheError } = await supabase
    .from('google_drive_connections')
    .update({ category_folder_ids: updatedCache })
    .eq('id', connection.id);
  if (cacheError) {
    console.error('Échec de mise en cache du dossier Drive de catégorie :', cacheError.message);
  }
  connection.category_folder_ids = updatedCache;

  return folderId;
}

// Point d'entrée unique pour tout upload de fichier document, quel que soit l'appelant
// (création, nouvelle version). storage est déjà résolu (resolveTenantStorageProvider) avant
// l'appel — cette fonction exécute le choix déjà tranché, elle n'en fait aucun elle-même, pour
// qu'un changement de provider tenant pendant qu'une requête est en vol ne puisse jamais faire
// dévier un même document entre deux branches.
// Même extraction que driveIntegration.js#extractErrorDetail (dupliquée plutôt que partagée,
// convention déjà suivie pour addMonthsIso dans ce fichier) : une erreur googleapis porte le
// détail utile dans response.data.error, pas dans .message, qui reste souvent vide ou générique.
function extractDriveErrorDetail(err) {
  return (
    err.response?.data?.error_description ||
    (typeof err.response?.data?.error === 'string' ? err.response.data.error : err.response?.data?.error?.message) ||
    err.message ||
    'erreur inconnue'
  );
}

async function uploadDocumentFile({ storage, file, categoryId, supabasePath }) {
  if (storage.provider === 'google_drive') {
    try {
      const folderId = await resolveDriveDestinationFolder(storage.connection, storage.accessToken, categoryId);
      const driveFileId = await uploadFileToDrive(storage.accessToken, {
        name: file.originalname,
        mimeType: safeStorageContentType(file.mimetype),
        buffer: file.buffer,
        parentFolderId: folderId,
      });
      return { filePath: driveFileId, fileName: file.originalname, storageProvider: 'google_drive' };
    } catch (driveError) {
      console.error("Échec de l'upload d'un document vers Google Drive :", driveError);
      // Préfixé "Google Drive" pour ne jamais se confondre avec le message générique de
      // uploadToStorage ci-dessous (branche Supabase) — un bug rapporté sans ce préfixe
      // aurait pu venir de l'une ou l'autre branche sans moyen de le distinguer.
      throw new Error(`Échec de l'upload vers Google Drive : ${extractDriveErrorDetail(driveError)}`);
    }
  }

  await uploadToStorage(supabasePath, file);
  return { filePath: supabasePath, fileName: file.originalname, storageProvider: null };
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
    tenantId: req.tenantId,
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

// Colonnes partagées entre le modèle généré (GET .../import-template.xlsx) et le parseur de
// l'import (POST .../import) — un seul point de vérité pour ne jamais les laisser diverger.
const IMPORT_COLUMNS = {
  number: 'Numéro *',
  title: 'Titre *',
  description: 'Description',
  category: 'Catégorie',
  version: 'Version',
  createdAt: 'Date de création (JJ/MM/AAAA)',
  reviewDate: 'Date de révision (JJ/MM/AAAA)',
  reviewFrequency: 'Fréquence de révision (mois)',
};

// Compare les en-têtes en ignorant l'astérisque des colonnes obligatoires, la casse et les
// espaces superflus — un fichier renvoyé après passage par Excel peut légèrement modifier le
// texte des en-têtes (espace insécable, casse...) sans que la colonne ait vraiment changé.
function normalizeHeader(text) {
  return String(text || '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getRowValue(row, expectedHeader) {
  if (expectedHeader in row) return row[expectedHeader];
  const target = normalizeHeader(expectedHeader);
  const matchKey = Object.keys(row).find((key) => normalizeHeader(key) === target);
  return matchKey ? row[matchKey] : undefined;
}

// GET /api/documents/import-template.xlsx — modèle Excel vierge (+ liste des catégories du
// tenant, pour que la colonne Catégorie soit remplie avec des noms qui existent réellement)
// à télécharger, remplir, puis renvoyer à POST /import. Placée avant GET /:id : Express
// matche les routes dans l'ordre d'enregistrement (pas par spécificité), donc /:id
// intercepterait "import-template.xlsx" comme valeur d'id si cette route venait après.
router.get('/import-template.xlsx', async (req, res) => {
  const { data: categories } = await supabase
    .from('document_categories')
    .select('name')
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Documents');
  sheet.columns = [
    { header: IMPORT_COLUMNS.number, key: 'number', width: 16 },
    { header: IMPORT_COLUMNS.title, key: 'title', width: 32 },
    { header: IMPORT_COLUMNS.description, key: 'description', width: 40 },
    { header: IMPORT_COLUMNS.category, key: 'category', width: 22 },
    { header: IMPORT_COLUMNS.version, key: 'version', width: 10 },
    { header: IMPORT_COLUMNS.createdAt, key: 'createdAt', width: 26 },
    { header: IMPORT_COLUMNS.reviewDate, key: 'reviewDate', width: 26 },
    { header: IMPORT_COLUMNS.reviewFrequency, key: 'reviewFrequency', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({
    number: 'QP-001',
    title: 'Exemple de procédure',
    description: "Ligne d'exemple — à modifier ou supprimer avant import.",
    category: categories?.[0]?.name || '',
    version: '1.0',
    createdAt: '',
    reviewDate: '',
    reviewFrequency: '',
  });
  sheet.getRow(2).font = { italic: true, color: { argb: 'FF94A3B8' } };
  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  });

  if (categories && categories.length > 0) {
    const categoriesSheet = workbook.addWorksheet('Catégories disponibles');
    categoriesSheet.columns = [{ header: 'Nom de la catégorie', key: 'name', width: 30 }];
    categoriesSheet.getRow(1).font = { bold: true };
    categories.forEach((category) => categoriesSheet.addRow({ name: category.name }));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modele-import-documents.xlsx"');
  res.send(Buffer.from(buffer));
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

  // Le frontend en a besoin pour n'afficher "Nouvelle version" (et les autres actions
  // d'édition) que si l'utilisateur peut réellement les faire — bug réel rapporté : le bouton
  // s'affichait pour tout le monde, y compris quelqu'un avec uniquement "Voir" sur la
  // catégorie restreinte, qui se heurtait alors à un 403 après avoir rempli le formulaire.
  const canEdit = await hasCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: document.category_id,
    permission: 'edit',
  });

  res.json({ ...document, versions, workflow: workflow ? { ...workflow, approvals } : null, can_edit: canEdit });
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
    body('review_frequency_months').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Fréquence de révision invalide.').toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      number,
      title,
      description,
      category_id: categoryId,
      review_date: reviewDate,
      review_frequency_months: reviewFrequencyMonths,
    } = req.body;
    const documentId = randomUUID();

    let filePath = null;
    let fileName = null;
    let extractedText = null;
    let storageProvider = null;

    if (req.file) {
      let storage;
      try {
        storage = await resolveTenantStorageProvider(req.tenantId);
      } catch (storageError) {
        return res
          .status(409)
          .json({ error: storageError.message, code: storageError.driveConnectionError ? 'drive_connection_error' : undefined });
      }

      try {
        const uploadResult = await uploadDocumentFile({
          storage,
          file: req.file,
          categoryId: categoryId || null,
          supabasePath: `${req.tenantId}/${documentId}/${sanitizeFileName(req.file.originalname)}`,
        });
        filePath = uploadResult.filePath;
        fileName = uploadResult.fileName;
        storageProvider = uploadResult.storageProvider;
      } catch (uploadError) {
        console.error("Échec de l'upload d'un document :", uploadError);
        return res.status(500).json({ error: uploadError.message || "Échec de l'upload du fichier." });
      }

      extractedText = await extractText(req.file);
    }

    // review_date explicite prioritaire ; sinon calculé depuis la fréquence propre à ce
    // document, sinon depuis le défaut du tenant (voir tenants.document_review_frequency_months) —
    // même logique de repli que capas.js pour due_date/priority delays.
    let effectiveReviewDate = reviewDate || null;
    if (!effectiveReviewDate) {
      const frequency = reviewFrequencyMonths
        ? Number(reviewFrequencyMonths)
        : (await supabase.from('tenants').select('document_review_frequency_months').eq('id', req.tenantId).single()).data
            ?.document_review_frequency_months;
      if (frequency) {
        effectiveReviewDate = addMonthsIso(new Date().toISOString().slice(0, 10), frequency);
      }
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
        review_date: effectiveReviewDate,
        review_frequency_months: reviewFrequencyMonths ? Number(reviewFrequencyMonths) : null,
        file_path: filePath,
        file_name: fileName,
        storage_provider: storageProvider,
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

  // Archive la version courante avant de la remplacer — storage_provider capturé ICI (avant
  // que la mise à jour ci-dessous n'écrase documents.storage_provider) : un tenant peut
  // changer de provider entre deux versions, et sans cette capture une ancienne version
  // stockée sur Drive deviendrait irrésolvable une fois documents.storage_provider écrasé par
  // la nouvelle valeur.
  const { error: archiveError } = await supabase.from('document_versions').insert({
    document_id: document.id,
    tenant_id: req.tenantId,
    version: document.version,
    file_path: document.file_path,
    file_name: document.file_name,
    storage_provider: document.storage_provider,
    status: document.status,
    change_note: req.body.change_note || null,
    changed_by: req.user.id,
  });

  if (archiveError) {
    return res.status(500).json({ error: "Impossible d'archiver la version précédente." });
  }

  const newVersion = bumpVersion(document.version);

  let storage;
  try {
    storage = await resolveTenantStorageProvider(req.tenantId);
  } catch (storageError) {
    return res
      .status(409)
      .json({ error: storageError.message, code: storageError.driveConnectionError ? 'drive_connection_error' : undefined });
  }

  let uploadResult;
  try {
    uploadResult = await uploadDocumentFile({
      storage,
      file: req.file,
      categoryId: document.category_id || null,
      supabasePath: `${req.tenantId}/${document.id}/${newVersion}-${sanitizeFileName(req.file.originalname)}`,
    });
  } catch (uploadError) {
    console.error("Échec de l'upload d'une nouvelle version de document :", uploadError);
    return res.status(500).json({ error: uploadError.message || "Échec de l'upload du fichier." });
  }

  const extractedText = await extractText(req.file);

  // Une révision remet le compteur à zéro : recalculée depuis la fréquence propre à ce
  // document, sinon celle du tenant — seulement si l'une des deux est paramétrée, pour ne
  // rien changer aux tenants qui n'utilisent pas cette fonctionnalité.
  const update = {
    version: newVersion,
    file_path: uploadResult.filePath,
    file_name: uploadResult.fileName,
    storage_provider: uploadResult.storageProvider,
    extracted_text: extractedText,
    status: 'draft',
    approved_by: null,
  };

  const effectiveFrequency =
    document.review_frequency_months ||
    (await supabase.from('tenants').select('document_review_frequency_months').eq('id', req.tenantId).single()).data
      ?.document_review_frequency_months;
  if (effectiveFrequency) {
    update.review_date = addMonthsIso(new Date().toISOString().slice(0, 10), effectiveFrequency);
  }

  const { data, error } = await supabase
    .from('documents')
    .update(update)
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
    .select('id, file_path, file_name, storage_provider')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !document) {
    return res.status(404).json({ error: 'Document introuvable.' });
  }

  if (!document.file_path) {
    return res.status(404).json({ error: 'Aucun fichier associé à ce document.' });
  }

  // Branche sur le provider PROPRE au document, pas le réglage actuel du tenant : un tenant
  // qui a activé Drive après coup a toujours d'anciens documents stockés sur Supabase, et
  // inversement après une désactivation.
  const url =
    document.storage_provider === 'google_drive'
      ? `${req.protocol}://${req.get('host')}/api/documents/drive-file?ticket=${encodeURIComponent(signDownloadTicket(req.tenantId, document.file_path, document.file_name))}`
      : supabase.storage.from(STORAGE_BUCKET).getPublicUrl(document.file_path).data.publicUrl;

  await logAudit({
    tenantId: req.tenantId,
    documentId: document.id,
    userId: req.user.id,
    action: 'downloaded',
    details: { file_name: document.file_name },
  });

  res.json({ url });
});

// GET /api/documents/:id/drive-view-link — Prompt F2 : ouvre le document directement dans
// l'interface Google Drive (webViewLink) plutôt que de le télécharger, pour l'icône de
// provenance affichée sur chaque ligne du tableau des documents. 404 pour un document qui
// n'est pas (ou plus) sur Drive — le frontend garde alors le bouton de téléchargement normal.
router.get('/:id/drive-view-link', requireCategoryPermission('view', resolveDocumentById), async (req, res) => {
  const { data: document, error } = await supabase
    .from('documents')
    .select('id, file_path, storage_provider')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !document || document.storage_provider !== 'google_drive' || !document.file_path) {
    return res.status(404).json({ error: "Ce document n'est pas stocké sur Google Drive." });
  }

  let accessToken;
  try {
    accessToken = await getTenantDriveAccessToken(req.tenantId);
  } catch (tokenError) {
    return res.status(tokenError.statusCode || 500).json({ error: tokenError.message });
  }

  try {
    const url = await getFileWebViewLink(accessToken, document.file_path);
    res.json({ url });
  } catch (viewLinkError) {
    console.error('Échec de récupération du lien Google Drive :', viewLinkError);
    res.status(500).json({ error: 'Impossible de récupérer le lien Google Drive.' });
  }
});

// GET /api/documents/:id/versions/:versionId/download — même logique que /:id/download
// ci-dessus, mais pour une version archivée : storage_provider et file_path viennent de
// document_versions (capturés au moment de l'archivage), pas de la ligne documents courante,
// qui a pu depuis changer de provider ou de fichier.
router.get(
  '/:id/versions/:versionId/download',
  requireCategoryPermission('view', resolveDocumentById),
  async (req, res) => {
    const { data: version, error } = await supabase
      .from('document_versions')
      .select('id, file_path, file_name, storage_provider')
      .eq('tenant_id', req.tenantId)
      .eq('document_id', req.params.id)
      .eq('id', req.params.versionId)
      .single();

    if (error || !version) {
      return res.status(404).json({ error: 'Version introuvable.' });
    }

    if (!version.file_path) {
      return res.status(404).json({ error: 'Aucun fichier associé à cette version.' });
    }

    const url =
      version.storage_provider === 'google_drive'
        ? `${req.protocol}://${req.get('host')}/api/documents/drive-file?ticket=${encodeURIComponent(signDownloadTicket(req.tenantId, version.file_path, version.file_name))}`
        : supabase.storage.from(STORAGE_BUCKET).getPublicUrl(version.file_path).data.publicUrl;

    res.json({ url });
  }
);

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

  const { data: logRows, error } = await supabase
    .from('document_audit_log')
    .select('*')
    .eq('document_id', document.id)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer le journal d'audit." });
  }

  // user_id n'est plus une clé étrangère (voir schema.sql : le journal doit survivre à la
  // suppression du tenant/document/utilisateur qu'il documente), donc plus d'embed PostgREST
  // possible ici — jointure faite à la main. Un user_id sans utilisateur retrouvé (compte
  // supprimé depuis) donne simplement user: null plutôt que d'échouer.
  const userIds = [...new Set(logRows.map((row) => row.user_id).filter(Boolean))];
  const usersById = new Map();
  if (userIds.length > 0) {
    const { data: authors } = await supabase.from('users').select('id, full_name').in('id', userIds);
    for (const author of authors || []) {
      usersById.set(author.id, author);
    }
  }

  const data = logRows.map((row) => ({ ...row, user: usersById.get(row.user_id) || null }));

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

// PATCH /api/documents/:id/metadata — corrections manuelles réservées à l'administration
// documentaire : version, date de création, date/fréquence de révision. Jamais titre/numéro/
// description ni le fichier, qui restent gérés par leurs flux dédiés (nouvelle version,
// statut...) — ici seulement les champs qu'un import/rétro-saisie a besoin d'ajuster après
// coup. admin/manager + permission catégorie, comme DELETE : ce sont des champs qui touchent
// à la traçabilité (dont la date de création), pas une simple édition de contenu.
router.patch(
  '/:id/metadata',
  requireRole('admin', 'manager'),
  requireCategoryPermission('edit', resolveDocumentById),
  [
    body('version').optional().trim().notEmpty().withMessage('La version ne peut pas être vide.'),
    body('created_at').optional({ values: 'falsy' }).isISO8601().withMessage('Date de création invalide.'),
    body('review_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de révision invalide.'),
    body('review_frequency_months')
      .optional({ nullable: true, values: 'falsy' })
      .isInt({ min: 1 })
      .withMessage('Fréquence de révision invalide.')
      .toInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const patchableFields = ['version', 'created_at', 'review_date', 'review_frequency_months'];
    if (!patchableFields.some((field) => field in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const update = {};
    if ('version' in req.body) update.version = req.body.version;
    if ('created_at' in req.body) update.created_at = req.body.created_at;
    if ('review_date' in req.body) update.review_date = req.body.review_date || null;
    if ('review_frequency_months' in req.body) {
      update.review_frequency_months = req.body.review_frequency_months || null;
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
      action: 'metadata_edited_manually',
      details: update,
    });

    res.json(data);
  }
);

// DELETE /api/documents/:id — réservé aux admins/managers, et soumis à can_delete si la
// catégorie est restreinte (un manager n'a pas le bypass admin — il lui faut une permission
// explicite can_delete pour supprimer un document d'une catégorie restreinte).
router.delete(
  '/:id',
  requireRole('admin', 'manager'),
  requireCategoryPermission('delete', resolveDocumentById),
  async (req, res) => {
  // Le titre/numéro est capturé avant suppression : document_audit_log doit rester lisible
  // une fois le document parti (voir la note sur document_id dans schema.sql).
  const { data: document } = await supabase
    .from('documents')
    .select('number, title')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

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

  await logAudit({
    tenantId: req.tenantId,
    documentId: req.params.id,
    userId: req.user.id,
    action: 'deleted',
    details: { number: document?.number, title: document?.title },
  });

  res.status(204).send();
});

// Colonnes partagées entre le modèle généré (GET .../import-template.xlsx) et le parseur de
// l'import (POST .../import) — un seul point de vérité pour ne jamais les laisser diverger.
// POST /api/documents/import — création en masse à partir du modèle rempli. Chaque ligne est
// validée et insérée indépendamment (une erreur sur une ligne n'annule pas les autres) ; le
// détail ligne par ligne est renvoyé pour que l'utilisateur sache exactement quoi corriger.
// Pas de fichier joint par document ici : la ligne crée la fiche documentaire, le fichier
// s'ajoute ensuite via le flux "Nouvelle version" existant.
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier Excel (.xlsx) est requis.' });
  }

  let rows;
  try {
    // L'onglet "Documents" est ciblé par son nom plutôt que par position (premier onglet) : si
    // l'utilisateur a réordonné les onglets dans Excel (ex. "Catégories disponibles" avant
    // "Documents"), lire par position aurait silencieusement parsé le mauvais onglet — toutes
    // les lignes auraient alors semblé vides de Numéro/Titre. Repli sur le premier onglet
    // seulement si aucun onglet ne s'appelle "Documents" (fichier renommé).
    const sheetNames = (await parseExcelBuffer(req.file.buffer)).sheetNames;
    const targetSheet = sheetNames.includes('Documents') ? 'Documents' : undefined;
    const parsed = await parseExcelBuffer(req.file.buffer, targetSheet);
    rows = parsed.rows;
  } catch (parseError) {
    return res
      .status(parseError.userFacing ? 400 : 500)
      .json({ error: parseError.userFacing ? parseError.message : `Fichier illisible : ${parseError.message}` });
  }

  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: 'Le fichier ne contient aucune ligne exploitable.' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 documents par import.' });
  }

  // Si aucune colonne attendue n'est reconnue dans la première ligne, mieux vaut le dire
  // clairement (avec les en-têtes réellement trouvées) que de laisser chaque ligne échouer
  // silencieusement avec "Numéro requis" sans que l'utilisateur comprenne pourquoi.
  const detectedHeaders = Object.keys(rows[0] || {});
  const expectedHeaders = Object.values(IMPORT_COLUMNS);
  const recognizedCount = expectedHeaders.filter((expected) =>
    detectedHeaders.some((detected) => normalizeHeader(detected) === normalizeHeader(expected))
  ).length;
  if (recognizedCount === 0) {
    return res.status(400).json({
      error: `Colonnes non reconnues. Colonnes attendues : ${expectedHeaders.join(', ')}. Colonnes trouvées dans le fichier : ${detectedHeaders.join(', ') || 'aucune'}.`,
    });
  }

  const [{ data: categories }, { data: tenant }, { data: existingDocs }] = await Promise.all([
    supabase.from('document_categories').select('id, name').eq('tenant_id', req.tenantId),
    supabase.from('tenants').select('document_review_frequency_months').eq('id', req.tenantId).single(),
    supabase.from('documents').select('number').eq('tenant_id', req.tenantId),
  ]);

  const categoriesByName = new Map((categories || []).map((category) => [category.name.trim().toLowerCase(), category]));
  const existingNumbers = new Set((existingDocs || []).map((document) => document.number));
  const seenNumbersInFile = new Set();
  const defaultFrequency = tenant?.document_review_frequency_months || null;

  const results = [];
  const toInsert = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 2; // ligne 1 = en-têtes
    const number = String(getRowValue(row, IMPORT_COLUMNS.number) ?? '').trim();
    const title = String(getRowValue(row, IMPORT_COLUMNS.title) ?? '').trim();

    if (!number) {
      results.push({ row: rowNumber, status: 'error', message: 'Numéro requis.' });
      continue;
    }
    if (!title) {
      results.push({ row: rowNumber, status: 'error', message: 'Titre requis.' });
      continue;
    }
    if (existingNumbers.has(number) || seenNumbersInFile.has(number)) {
      results.push({ row: rowNumber, status: 'error', message: `Numéro "${number}" déjà utilisé.`, number });
      continue;
    }

    const categoryNameRaw = String(getRowValue(row, IMPORT_COLUMNS.category) ?? '').trim();
    let categoryId = null;
    let warningMessage = null;
    if (categoryNameRaw) {
      const category = categoriesByName.get(categoryNameRaw.toLowerCase());
      if (!category) {
        warningMessage = `Catégorie "${categoryNameRaw}" introuvable — document créé sans catégorie.`;
      } else {
        const allowed = await hasCategoryPermission({
          tenantId: req.tenantId,
          userId: req.user.id,
          userRole: req.userRole,
          categoryId: category.id,
          permission: 'edit',
        });
        if (!allowed) {
          results.push({
            row: rowNumber,
            status: 'error',
            message: `Vous n'avez pas la permission de créer un document dans la catégorie "${categoryNameRaw}".`,
            number,
          });
          continue;
        }
        categoryId = category.id;
      }
    }

    const version = String(getRowValue(row, IMPORT_COLUMNS.version) ?? '').trim() || '1.0';
    const createdAtDate = parseFlexibleDate(getRowValue(row, IMPORT_COLUMNS.createdAt));
    const reviewFrequencyRaw = getRowValue(row, IMPORT_COLUMNS.reviewFrequency);
    const reviewFrequency =
      reviewFrequencyRaw !== null && reviewFrequencyRaw !== undefined && String(reviewFrequencyRaw).trim() !== ''
        ? parseInt(reviewFrequencyRaw, 10)
        : null;
    const effectiveFrequency = Number.isInteger(reviewFrequency) && reviewFrequency > 0 ? reviewFrequency : defaultFrequency;

    let reviewDate = parseFlexibleDate(getRowValue(row, IMPORT_COLUMNS.reviewDate));
    if (!reviewDate && effectiveFrequency) {
      reviewDate = addMonthsIso(createdAtDate || new Date().toISOString().slice(0, 10), effectiveFrequency);
    }

    seenNumbersInFile.add(number);
    toInsert.push({
      tenant_id: req.tenantId,
      category_id: categoryId,
      number,
      title,
      description: String(getRowValue(row, IMPORT_COLUMNS.description) ?? '').trim() || null,
      version,
      // Toujours une valeur concrète (jamais `undefined` pour retomber sur le défaut now() de
      // la base) : un insert groupé PostgREST exige que tous les objets du tableau aient
      // exactement le même jeu de clés. Si une seule ligne avait "created_at" et une autre non,
      // le batch entier échouait (bug réel rencontré : 500 générique côté PostgREST).
      created_at: createdAtDate ? `${createdAtDate}T00:00:00Z` : new Date().toISOString(),
      review_date: reviewDate,
      review_frequency_months: Number.isInteger(reviewFrequency) && reviewFrequency > 0 ? reviewFrequency : null,
      created_by: req.user.id,
    });
    results.push({ row: rowNumber, status: 'pending', number, warning: warningMessage });
  }

  if (toInsert.length > 0) {
    const { data: inserted, error: insertError } = await supabase
      .from('documents')
      .insert(toInsert)
      .select('id, number, title');

    if (insertError) {
      console.error("Échec de l'import en masse de documents :", insertError);
      return res.status(500).json({ error: 'Erreur lors de la création des documents.' });
    }

    const insertedByNumber = new Map(inserted.map((document) => [document.number, document]));
    results.forEach((result) => {
      if (result.status !== 'pending') return;
      const created = insertedByNumber.get(result.number);
      if (created) {
        result.status = result.warning ? 'warning' : 'created';
        result.message = result.warning || undefined;
        result.document_id = created.id;
        result.title = created.title;
      } else {
        result.status = 'error';
        result.message = 'Erreur inconnue lors de la création.';
      }
      delete result.warning;
    });
  }

  // document_audit_log.document_id est NOT NULL (voir schema.sql) : une entrée par document
  // créé, pas une entrée globale sans document_id.
  await Promise.all(
    results
      .filter((result) => result.document_id)
      .map((result) =>
        logAudit({
          tenantId: req.tenantId,
          documentId: result.document_id,
          userId: req.user.id,
          action: 'created_via_import',
          details: { file_name: req.file.originalname },
        })
      )
  );

  res.status(201).json({
    created_count: results.filter((r) => r.status === 'created' || r.status === 'warning').length,
    error_count: results.filter((r) => r.status === 'error').length,
    results,
  });
});

export default router;
