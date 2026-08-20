import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import os from 'os';

function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const err = new Error(
      'Variables Google OAuth manquantes : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN.'
    );
    err.statusCode = 500;
    throw err;
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: 'v3', auth });
}

async function uploadBackupToDrive(filePath, filename) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    const err = new Error('GOOGLE_DRIVE_FOLDER_ID est manquant.');
    err.statusCode = 500;
    throw err;
  }

  const drive = getDriveClient();

  const response = await drive.files.create({
    resource: { name: filename, parents: [folderId] },
    media: { mimeType: 'application/octet-stream', body: fs.createReadStream(filePath) },
    fields: 'id, name, size, webViewLink, createdTime',
  });

  return response.data;
}

async function listDriveBackups(maxResults = 20) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return [];

  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, size, createdTime, webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: maxResults,
  });

  return response.data.files || [];
}

async function downloadFromDrive(fileId, filename) {
  const drive = getDriveClient();

  // path.basename neutralise tout `../` — filename vient de req.body côté route appelante,
  // jamais fiable tel quel pour construire un chemin de fichier.
  const safeName = path.basename(filename || '') || `restore_${Date.now()}.sql`;
  const destPath = path.join(os.tmpdir(), safeName);
  const dest = fs.createWriteStream(destPath);

  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  await new Promise((resolve, reject) => {
    response.data.on('error', reject).pipe(dest).on('error', reject).on('finish', resolve);
  });

  return destPath;
}

export { uploadBackupToDrive, listDriveBackups, downloadFromDrive };
