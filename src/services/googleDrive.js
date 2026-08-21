import crypto from 'crypto';
import { google } from 'googleapis';
import { supabase } from './supabase.js';
import { encrypt, decrypt } from './encryption.js';

// drive.file : l'app ne voit et ne touche QUE les fichiers qu'elle a elle-même créés dans le
// Drive du tenant, jamais le reste — le scope le plus restreint compatible avec l'usage,
// documenté dans Prompt 0. Distinct des scopes drive/gmail.send de l'intégration existante
// (sauvegarde + envoi d'email), qui portent sur le compte Google de l'éditeur de l'app, pas
// sur celui d'un tenant.
// userinfo.email : nécessaire pour afficher "connecté en tant que [email]" côté Paramètres —
// sans ce scope, l'appel à l'API userinfo échoue (accès insuffisant) et faisait échouer tout
// le callback (bug rencontré : "Impossible de finaliser la connexion à Google Drive").
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/userinfo.email'];
const ROOT_FOLDER_NAME = 'QMS SaaS';

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error(
      'Variables Google Drive OAuth manquantes : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_DRIVE_REDIRECT_URI.'
    );
    err.statusCode = 500;
    throw err;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getStateSecret() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    const err = new Error('ENCRYPTION_KEY est manquant.');
    err.statusCode = 500;
    throw err;
  }
  return secret;
}

function signState(tenantId, userId) {
  const payload = `${tenantId}:${userId}`;
  const signature = crypto.createHmac('sha256', getStateSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

// Vérifie que le paramètre state revenu de Google n'a pas été altéré. Sans cette vérification,
// n'importe qui pourrait compléter le consentement OAuth avec SON PROPRE compte Google puis
// rattacher cette connexion au tenant de son choix en forgeant tenantId dans state — les
// prochains documents de ce tenant partiraient silencieusement vers le Drive de l'attaquant.
export function verifyState(state) {
  const raw = String(state || '');
  const separatorIndex = raw.lastIndexOf('.');
  if (separatorIndex === -1) return null;

  const payload = raw.slice(0, separatorIndex);
  const signature = raw.slice(separatorIndex + 1);
  const expected = crypto.createHmac('sha256', getStateSecret()).update(payload).digest('hex');

  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const [tenantId, userId] = payload.split(':');
  if (!tenantId || !userId) return null;
  return { tenantId, userId };
}

// tenantId/userId : l'admin qui initie la connexion (state signé, voir verifyState) — jamais
// une confiance aveugle dans un state fourni au retour du callback.
export function getAuthUrl(tenantId, userId) {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // 'consent' force Google à renvoyer un refresh_token à CHAQUE autorisation — sans ça, une
    // reconnexion après un disconnect ne renverrait qu'un access_token (Google ne redonne le
    // refresh_token qu'au tout premier consentement d'un compte pour cette app).
    prompt: 'consent',
    scope: SCOPES,
    state: signState(tenantId, userId),
  });
}

export async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, scope, token_type }
}

function driveClientFromAccessToken(accessToken) {
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

export async function createRootFolder(accessToken) {
  const drive = driveClientFromAccessToken(accessToken);
  const response = await drive.files.create({
    resource: { name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  return response.data.id;
}

// Idempotent : cherche d'abord un sous-dossier existant du même nom sous le dossier racine
// avant d'en créer un, pour ne jamais dupliquer un dossier de catégorie déjà créé lors d'un
// appel précédent.
export async function getOrCreateCategoryFolder(accessToken, rootFolderId, categoryName) {
  const drive = driveClientFromAccessToken(accessToken);
  // Un nom de catégorie peut contenir une apostrophe, qui casserait la requête q ci-dessous
  // si elle n'est pas échappée (syntaxe de requête Drive, pas SQL).
  const escapedName = categoryName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const existing = await drive.files.list({
    q: `'${rootFolderId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });

  if (existing.data.files?.length) {
    return existing.data.files[0].id;
  }

  const response = await drive.files.create({
    resource: { name: categoryName, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] },
    fields: 'id',
  });
  return response.data.id;
}

// Renvoie un access_token toujours valide pour cette connexion : le déchiffre tel quel s'il a
// encore une marge de vie confortable, sinon le rafraîchit via le refresh_token et persiste le
// nouveau token chiffré + sa nouvelle expiration avant de le renvoyer.
export async function refreshAccessTokenIfNeeded(connection) {
  const SAFETY_MARGIN_MS = 60 * 1000; // évite d'utiliser un token qui expire pendant la requête elle-même
  const expiresAt = new Date(connection.token_expires_at).getTime();

  if (expiresAt - Date.now() > SAFETY_MARGIN_MS) {
    return decrypt(connection.access_token);
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: decrypt(connection.refresh_token) });

  const { credentials } = await oauth2Client.refreshAccessToken();

  const { error } = await supabase
    .from('google_drive_connections')
    .update({
      access_token: encrypt(credentials.access_token),
      token_expires_at: new Date(credentials.expiry_date).toISOString(),
    })
    .eq('id', connection.id);

  if (error) {
    throw new Error('Impossible de mettre à jour le token Google Drive rafraîchi.');
  }

  return credentials.access_token;
}
