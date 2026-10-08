import { supabase } from './supabase.js';
import imageSize from 'image-size';
import {
  deleteDriveFile,
  getDriveFileStream,
  getOrCreateCategoryFolder,
  refreshAccessTokenIfNeeded,
  uploadFile,
} from './googleDrive.js';

const MAX_ATTACHMENTS_PER_RECORD = 10;

export async function getEvidenceDriveConnection(tenantId) {
  const { data: connection, error } = await supabase
    .from('google_drive_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error || !connection) {
    const err = new Error('Connectez Google Drive depuis Paramètres > Documents pour ajouter des photos de preuve.');
    err.driveConnectionError = true;
    throw err;
  }

  try {
    return { connection, accessToken: await refreshAccessTokenIfNeeded(connection) };
  } catch (error) {
    console.error('Échec du rafraîchissement du jeton Google Drive (preuves QMS) :', error.message);
    const err = new Error('La connexion Google Drive a expiré ou a été révoquée — reconnectez-vous depuis Paramètres > Documents.');
    err.driveConnectionError = true;
    throw err;
  }
}

export async function listEvidence({ tenantId, moduleKey, recordId }) {
  const { data, error } = await supabase
    .from('qms_evidence_attachments')
    .select('id, module_key, record_id, file_name, mime_type, file_size, caption, uploaded_by, created_at')
    .eq('tenant_id', tenantId)
    .eq('module_key', moduleKey)
    .eq('record_id', recordId)
    .order('created_at', { ascending: true });

  if (error) throw new Error('Impossible de récupérer les photos de preuve.');
  return data || [];
}

export async function uploadEvidence({ tenantId, moduleKey, recordId, userId, file, caption }) {
  let dimensions;
  try {
    dimensions = imageSize(file.buffer);
  } catch {
    const err = new Error('Le fichier choisi ne contient pas une image JPEG ou PNG valide.');
    err.statusCode = 400;
    throw err;
  }
  const detectedMimeType = dimensions.type === 'jpg' ? 'image/jpeg' : dimensions.type === 'png' ? 'image/png' : null;
  if (
    !dimensions.width ||
    !dimensions.height ||
    dimensions.width > 12000 ||
    dimensions.height > 12000 ||
    dimensions.width * dimensions.height > 40_000_000 ||
    detectedMimeType !== file.mimetype
  ) {
    const err = new Error('Le fichier doit être une image JPEG ou PNG valide, avec des dimensions inférieures à 12 000 × 12 000 pixels.');
    err.statusCode = 400;
    throw err;
  }

  const existing = await listEvidence({ tenantId, moduleKey, recordId });
  if (existing.length >= MAX_ATTACHMENTS_PER_RECORD) {
    const err = new Error(`Une fiche peut contenir au maximum ${MAX_ATTACHMENTS_PER_RECORD} photos.`);
    err.statusCode = 400;
    throw err;
  }

  const { connection, accessToken } = await getEvidenceDriveConnection(tenantId);
  const folderCacheKey = '__qms_evidence__';
  let folderId = connection.category_folder_ids?.[folderCacheKey];
  if (!folderId) {
    folderId = await getOrCreateCategoryFolder(accessToken, connection.root_folder_id, 'Preuves terrain');
    const categoryFolderIds = { ...(connection.category_folder_ids || {}), [folderCacheKey]: folderId };
    const { error } = await supabase
      .from('google_drive_connections')
      .update({ category_folder_ids: categoryFolderIds })
      .eq('tenant_id', tenantId);
    if (error) throw new Error('Impossible de mettre à jour les dossiers Google Drive.');
  }

  const driveFileId = await uploadFile(accessToken, {
    name: `${moduleKey}-${recordId}-${Date.now()}-${file.originalname}`,
    mimeType: file.mimetype,
    buffer: file.buffer,
    parentFolderId: folderId,
  });

  const { data, error } = await supabase
    .from('qms_evidence_attachments')
    .insert({
      tenant_id: tenantId,
      module_key: moduleKey,
      record_id: recordId,
      drive_file_id: driveFileId,
      file_name: file.originalname,
      mime_type: file.mimetype,
      file_size: file.size,
      caption: caption || null,
      uploaded_by: userId,
    })
    .select('id, module_key, record_id, file_name, mime_type, file_size, caption, uploaded_by, created_at')
    .single();

  if (error) {
    try {
      await deleteDriveFile(accessToken, driveFileId);
    } catch (deleteError) {
      console.error('La métadonnée de preuve a échoué et le fichier Drive orphelin n’a pas pu être supprimé :', deleteError.message);
    }
    throw new Error('La photo a été envoyée sur Drive, mais ses métadonnées n’ont pas pu être enregistrées.');
  }
  return data;
}

export async function loadEvidenceForExport({ tenantId, moduleKey, recordId }) {
  const evidence = await listEvidence({ tenantId, moduleKey, recordId });
  if (evidence.length === 0) return [];
  const { accessToken } = await getEvidenceDriveConnection(tenantId);
  return Promise.all(
    evidence.map(async (item) => {
      const stream = await getDriveFileStream(accessToken, item.drive_file_id);
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return { ...item, buffer: Buffer.concat(chunks) };
    })
  );
}
