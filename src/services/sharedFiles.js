import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabase } from './supabase.js';
import { getTicketSecret } from './driveDownloadTicket.js';
import { getDriveFileStream, refreshAccessTokenIfNeeded } from './googleDrive.js';
import { getSharePermissions } from './sharePermissions.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { hasCategoryPermission } from '../middleware/documentPermissions.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { isSharedWithUser } from './recordSharing.js';
import { SHAREABLE_RESOURCES } from './shareableResources.js';

export function protectedFileUrl(req, { resourceType, resourceId, versionId = null, disposition = 'attachment', guestShare = null }) {
  const payload = Buffer.from(JSON.stringify({
    tenantId: guestShare?.tenant_id || req.tenantId, userId: guestShare ? null : req.user.id,
    guestShareId: guestShare?.id || null, guestAccessHash: guestShare?.access_token_hash || null,
    resourceType, resourceId, versionId, disposition, exp: Date.now() + 60000,
  })).toString('base64url');
  const signature = createHmac('sha256', getTicketSecret()).update(payload).digest('hex');
  return `${req.protocol}://${req.get('host')}/api/public/shared-files/${payload}.${signature}`;
}

export function decodeFileTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 4000) return null;
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra || !/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = createHmac('sha256', getTicketSecret()).update(payload).digest();
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!Number.isFinite(data.exp) || data.exp <= Date.now()) return null;
  return data;
}

export async function authorizedFile(ticket) {
  const { tenantId, resourceType, resourceId, versionId } = ticket;
  if (!['document', 'procedure', 'supplier'].includes(resourceType)) return null;
  const config = SHAREABLE_RESOURCES[resourceType];
  const { data: record, error } = await supabase.from(config.table).select('*')
    .eq('tenant_id', tenantId).eq('id', resourceId).maybeSingle();
  if (error) throw new Error(`Vérification du fichier protégé impossible : ${error.message}`);
  if (!record) return null;
  if (ticket.guestShareId) {
    const { data: share, error: shareError } = await supabase.from('guest_shares').select('*')
      .eq('tenant_id', tenantId).eq('id', ticket.guestShareId).maybeSingle();
    if (shareError) throw new Error(`Vérification de l'accès invité au fichier impossible : ${shareError.message}`);
    if (!share || share.revoked_at || !share.can_export || share.failed_attempts >= 5 ||
        new Date(share.expires_at).getTime() <= Date.now() ||
        !share.access_token_hash || share.access_token_hash !== ticket.guestAccessHash) return null;
    if (share.resource_type) {
      if (share.resource_type !== resourceType || share.resource_id !== resourceId) return null;
    } else {
      const { data: item, error: itemError } = await supabase.from('guest_share_items').select('id')
        .eq('tenant_id', tenantId).eq('guest_share_id', share.id)
        .eq('resource_type', resourceType).eq('resource_id', resourceId).maybeSingle();
      if (itemError) throw new Error(`Vérification de l'appartenance du fichier au lot impossible : ${itemError.message}`);
      if (!item) return null;
    }
    if (resourceType === 'procedure' && versionId !== record.current_version_id) return null;
    if (resourceType === 'document' && versionId) return null;
  } else {
    const { data: user, error: userError } = await supabase.from('users')
      .select('id, role, is_active, tenant:tenants(is_suspended)').eq('tenant_id', tenantId).eq('id', ticket.userId).maybeSingle();
    if (userError) throw new Error(`Vérification du destinataire du fichier impossible : ${userError.message}`);
    if (!user?.is_active || user.tenant?.is_suspended) return null;
    const permissions = await getSharePermissions({ tenantId, userId: user.id, userRole: user.role });
    const visible = await getVisibleMenuKeys({ tenantId, userId: user.id, userRole: permissions.has(`${resourceType}:${resourceId}`) ? 'admin' : user.role });
    if (!visible.has(config.module)) return null;
    if (permissions.get(`${resourceType}:${resourceId}`)?.can_export === false) return null;
    const shared = await isSharedWithUser({ tenantId, resourceType, resourceId, userId: user.id, userRole: user.role });
    const categoryAllowed = resourceType === 'document'
      ? await hasCategoryPermission({ tenantId, userId: user.id, userRole: user.role, categoryId: record.category_id, documentId: record.id, permission: 'view' })
      : await hasGenericCategoryPermission({ tenantId, userId: user.id, userRole: user.role, categoryId: record.category_id, permission: 'view' });
    if (!shared && !categoryAllowed) return null;
    if (resourceType === 'procedure' && record.source_document_id) {
      const { data: source, error: sourceError } = await supabase.from('documents').select('id, category_id')
        .eq('tenant_id', tenantId).eq('id', record.source_document_id).maybeSingle();
      if (sourceError) throw new Error(`Vérification du document source impossible : ${sourceError.message}`);
      if (!source || permissions.get(`document:${source.id}`)?.can_export === false ||
          !(await hasCategoryPermission({ tenantId, userId: user.id, userRole: user.role, categoryId: source.category_id, documentId: source.id, permission: 'view' }))) return null;
    }
  }
  if (resourceType === 'document' && !versionId) {
    return { path: record.file_path, name: record.file_name, provider: record.storage_provider };
  }
  const table = resourceType === 'document' ? 'document_versions' : resourceType === 'procedure' ? 'procedure_versions' : 'supplier_documents';
  const parentKey = resourceType === 'document' ? 'document_id' : resourceType === 'procedure' ? 'procedure_id' : 'supplier_id';
  const { data: version, error: versionError } = await supabase.from(table).select('*')
    .eq('tenant_id', tenantId).eq(parentKey, resourceId).eq('id', versionId).maybeSingle();
  if (versionError) throw new Error(`Lecture de la pièce jointe protégée impossible : ${versionError.message}`);
  if (!version) return null;
  return resourceType === 'procedure'
    ? { path: version.attachment_file_path, name: version.attachment_file_name, provider: version.attachment_storage_provider }
    : { path: version.file_path, name: version.file_name, provider: version.storage_provider };
}

export async function streamProtectedFile(res, tenantId, file, disposition = 'attachment') {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Disposition', `${disposition === 'inline' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name || 'document')}`);
  const ext = (file.name || '').split('.').at(-1).toLowerCase();
  const previewTypes = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  res.type(disposition === 'inline' ? previewTypes[ext] || 'application/octet-stream' : 'application/octet-stream');
  if (file.provider === 'google_drive') {
    const { data: connection, error } = await supabase.from('google_drive_connections').select('*').eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(`Lecture de la connexion Drive impossible : ${error.message}`);
    if (!connection) { const missing = new Error('Connexion Drive indisponible.'); missing.status = 409; throw missing; }
    const accessToken = await refreshAccessTokenIfNeeded(connection);
    const stream = await getDriveFileStream(accessToken, file.path);
    stream.on('error', (error) => {
      console.error('[protected-file] streaming failed:', error.message);
      if (!res.headersSent) res.status(502).json({ error: 'Téléchargement du fichier impossible.' });
      else res.destroy(error);
    });
    stream.pipe(res);
    return;
  }
  const { data, error } = await supabase.storage.from(process.env.STORAGE_BUCKET || 'qms-documents').download(file.path);
  if (error) throw new Error(`Téléchargement du fichier protégé impossible : ${error.message}`);
  res.send(Buffer.from(await data.arrayBuffer()));
}
