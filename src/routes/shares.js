import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { SHAREABLE_ROLES } from '../services/recordSharing.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { sendEmail } from '../services/email.js';
import {
  GUEST_EXPIRY_DAYS,
  generateGuestToken,
  hashGuestToken,
  normalizeGuestEmail,
} from '../services/guestSharing.js';
import { SHAREABLE_RESOURCES } from '../services/shareableResources.js';
import guestBundlesRouter from './guestBundles.js';
import { getSharePermissions } from '../services/sharePermissions.js';
import { readSharedResource } from './guestShares.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { selectionFields, selectionItem, SHAREABLE_RESOURCE_LABELS, filterProcedureSources, filterShareableRecords, readGuestBundleItems } from '../services/guestShareSelection.js';
import { resolveSharedTarget } from '../middleware/sharePermissions.js';

const router = Router();

// Table source par type de ressource — utilisée pour vérifier que resource_id existe bien
// dans ce tenant avant de créer un partage dessus (jamais un partage sur un id fantôme).
const RESOURCE_TABLES = Object.fromEntries(
  Object.entries(SHAREABLE_RESOURCES).map(([type, resource]) => [type, resource.table])
);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

router.use(requireAuth);
router.get('/my-permissions', async (req, res) => {
  const permissions = await getSharePermissions({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  res.json(Object.fromEntries(permissions));
});
router.post('/check-export', async (req, res) => {
  const path = req.body.path;
  if (typeof path !== 'string' || !/^\/[a-z0-9/-]*$/i.test(path) || path.length > 240) {
    return res.status(400).json({ error: 'Périmètre d’export invalide.' });
  }
  const target = await resolveSharedTarget({ ...req, originalUrl: `/api${path.replace(/^\/planning(?=\/|$)/, '/tasks')}` });
  const permissions = req.recordSharePermissions || new Map();
  const denied = [...permissions].some(([key, access]) =>
    access.can_export === false && (!target.type || (target.id ? key === `${target.type}:${target.id}` : key.startsWith(`${target.type}:`))));
  if (denied) return res.status(403).json({ error: 'Export interdit : ce périmètre contient des éléments dont le partage interdit l’export.' });
  res.sendStatus(204);
});
router.get('/received', async (req, res) => {
  const permissions = await getSharePermissions({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  const visible = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: 'admin' });
  const items = [];
  for (const [type, config] of Object.entries(SHAREABLE_RESOURCES)) {
    if (!visible.has(config.module)) continue;
    const ids = [...permissions.keys()].filter((key) => key.startsWith(`${type}:`)).map((key) => key.split(':')[1]);
    for (let offset = 0; offset < ids.length; offset += 100) {
      const { data, error } = await supabase.from(config.table).select(selectionFields(type))
        .eq('tenant_id', req.tenantId).in('id', ids.slice(offset, offset + 100));
      if (error) throw new Error(`Lecture des partages reçus impossible : ${error.message}`);
      const rows = type === 'procedure' ? await filterProcedureSources(req, data) : data;
      items.push(...rows.map((row) => ({
        ...selectionItem(type, row), type_label: SHAREABLE_RESOURCE_LABELS[type],
        permissions: permissions.get(`${type}:${row.id}`),
      })));
    }
  }
  res.json(items);
});

router.get(['/received/:type/:id', '/received/:type/:id/export'], async (req, res) => {
  const { type, id } = req.params;
  if (!Object.hasOwn(SHAREABLE_RESOURCES, type) || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Élément invalide.' });
  }
  const permissions = await getSharePermissions({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole });
  const access = permissions.get(`${type}:${id}`);
  const visible = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: 'admin' });
  if (!access?.shared || !visible.has(SHAREABLE_RESOURCES[type].module)) return res.status(404).json({ error: 'Partage introuvable.' });
  if (type === 'procedure') {
    const { data: procedure, error } = await supabase.from('procedures').select('id, source_document_id')
      .eq('tenant_id', req.tenantId).eq('id', id).maybeSingle();
    if (error) throw new Error(`Vérification de la procédure reçue impossible : ${error.message}`);
    if (!procedure || !(await filterProcedureSources(req, [procedure])).length) return res.status(404).json({ error: 'Procédure inaccessible.' });
  }
  const resource = await readSharedResource({ tenant_id: req.tenantId, resource_type: type, resource_id: id });
  if (!resource) return res.status(404).json({ error: 'Élément supprimé.' });
  if (req.path.endsWith('/export')) {
    if (!access.can_export) return res.status(403).json({ error: 'Export interdit pour cet élément.' });
    res.set('Content-Disposition', 'attachment; filename="donnees-partagees.json"');
    res.set('Cache-Control', 'no-store');
    return res.json(resource);
  }
  res.json({ resource, permissions: access });
});
router.use(async (req, res, next) => {
  const resourceType = req.query.resource_type || req.body?.resource_type;
  const moduleByResource = {
    ...Object.fromEntries(Object.entries(SHAREABLE_RESOURCES).map(([type, resource]) => [type, resource.module])),
  };
  const module = moduleByResource[resourceType];
  if (!module) return next();
  return requireMenuVisible(module)(req, res, next);
});
// Gérer les partages est réservé à admin/manager : ce sont déjà les seuls rôles qui voient
// tout par défaut dans les modules concernés (documents, CAPA) — laisser un membre partager
// lui-même reviendrait à le laisser s'auto-accorder ou accorder à d'autres un accès qu'il n'a
// pas le pouvoir de décider.
router.use(requireRole('admin', 'manager'));
router.use(async (req, res, next) => {
  if (req.userRole === 'admin' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (req.body?.resource_type && req.body?.resource_id) items = [...items, req.body];
  const match = /^\/(?:(internal|guest|bundles)\/)?([0-9a-f-]{36})$/i.exec(req.path);
  if (match) {
    const table = ['guest', 'bundles'].includes(match[1]) ? 'guest_shares' : 'record_shares';
    const { data: share, error } = await supabase.from(table).select('id, resource_type, resource_id')
      .eq('tenant_id', req.tenantId).eq('id', match[2]).maybeSingle();
    if (error) throw new Error(`Vérification du droit de gérer ce partage impossible : ${error.message}`);
    if (share?.resource_type) items = [...items, share];
    else if (share && table === 'guest_shares') {
      items = [...items, ...await readGuestBundleItems({ ...share, tenant_id: req.tenantId })];
    }
  }
  if (items.some((item) => req.recordSharePermissions?.get(`${item?.resource_type}:${item?.resource_id}`)?.restricted)) {
    return res.status(403).json({ error: 'Seul un administrateur peut redistribuer ou retirer les droits qui restreignent votre accès à cet élément.' });
  }
  next();
});
router.use('/bundles', guestBundlesRouter);

router.get('/internal', async (req, res) => {
  const offset = Number(req.query.offset || 0);
  if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'Pagination invalide.' });
  const { data, error } = await supabase.from('record_shares')
    .select('id, title, resource_type, resource_id, subject_type, subject_id, can_edit, can_export, created_at')
    .eq('tenant_id', req.tenantId).order('created_at', { ascending: false }).order('id').range(offset, offset + 49);
  if (error) throw new Error(`Lecture des partages internes impossible : ${error.message}`);
  res.json({ items: data, next_offset: data.length === 50 ? offset + 50 : null });
});

router.patch('/internal/:id', [
  body('can_edit').isBoolean({ strict: true }),
  body('can_export').isBoolean({ strict: true }),
], async (req, res) => {
  if (!validationResult(req).isEmpty() || !/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Droits ou identifiant invalides.' });
  }
  const { data, error } = await supabase.from('record_shares')
    .update({ can_edit: req.body.can_edit, can_export: req.body.can_export })
    .eq('tenant_id', req.tenantId).eq('id', req.params.id).select('id').maybeSingle();
  if (error) throw new Error(`Mise à jour des droits internes impossible : ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Partage introuvable.' });
  res.json(data);
});

router.get('/guest', async (req, res) => {
  const { resource_type: resourceType, resource_id: resourceId } = req.query;
  if (!Object.hasOwn(RESOURCE_TABLES, resourceType) || !/^[0-9a-f-]{36}$/i.test(resourceId || '')) {
    return res.status(400).json({ error: 'Ressource invalide.' });
  }
  const { data, error } = await supabase
    .from('guest_shares')
    .select('id, email, expires_at, revoked_at, created_at')
    .eq('tenant_id', req.tenantId)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Impossible de récupérer les accès invités.' });
  res.json(data);
});

router.post(
  '/guest',
  [
    body('resource_type').isIn(Object.keys(RESOURCE_TABLES)).withMessage('Type de ressource invalide.'),
    body('resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('expires_in_days').optional().isInt().toInt().custom((days) => GUEST_EXPIRY_DAYS.includes(days))
      .withMessage('Choisissez une durée de 1, 7 ou 30 jours.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { resource_type: resourceType, resource_id: resourceId } = req.body;
    const email = normalizeGuestEmail(req.body.email);
    const expiresInDays = req.body.expires_in_days || 7;
    const { data: resource, error: resourceError } = await supabase
      .from(RESOURCE_TABLES[resourceType])
      .select(selectionFields(resourceType))
      .eq('tenant_id', req.tenantId)
      .eq('id', resourceId)
      .maybeSingle();
    if (resourceError) return res.status(500).json({ error: 'Impossible de vérifier la ressource.' });
    if (!resource) return res.status(404).json({ error: 'Élément introuvable.' });
    if (!(await filterShareableRecords(req, resourceType, [resource])).length) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }

    const token = generateGuestToken();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const { data: guestShare, error } = await supabase
      .from('guest_shares')
      .insert({
        tenant_id: req.tenantId,
        resource_type: resourceType,
        resource_id: resourceId,
        email,
        token_hash: hashGuestToken(token),
        expires_at: expiresAt,
        created_by: req.user.id,
      })
      .select('id, email, expires_at, created_at')
      .single();
    if (error) return res.status(500).json({ error: 'Impossible de créer cet accès invité.' });

    const itemName = resource[SHAREABLE_RESOURCES[resourceType].labelField] || resource.number || resourceType;
    const link = `${process.env.FRONTEND_URL}/guest/${token}`;
    const html = `<p>Vous avez reçu un accès temporaire en lecture seule à un élément partagé depuis QMS SaaS.</p>
      <p><strong>Élément :</strong> ${escapeHtml(itemName)}</p>
      <p>Ouvrez ce lien. Un code de vérification vous sera ensuite envoyé par email : <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
      <p>L'accès expire le ${new Date(expiresAt).toLocaleDateString('fr-FR')} et peut être révoqué à tout moment.</p>`;

    try {
      await sendEmail(email, 'Votre accès invité en lecture seule — QMS SaaS', html);
    } catch (sendError) {
      const { error: cleanupError } = await supabase.from('guest_shares').delete().eq('id', guestShare.id).eq('tenant_id', req.tenantId);
      if (cleanupError) console.error('[guest-share] cleanup after email failure failed:', cleanupError.message);
      throw sendError;
    }
    res.status(201).json(guestShare);
  }
);

router.delete('/guest/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('guest_shares')
    .update({ revoked_at: new Date().toISOString(), access_token_hash: null })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Impossible de révoquer cet accès invité.' });
  if (!data) return res.status(404).json({ error: 'Accès invité introuvable ou déjà révoqué.' });
  res.status(204).send();
});

// GET /api/shares?resource_type=capa&resource_id=... — partages actifs sur UN élément précis,
// avec le nom de la personne résolu pour les partages par utilisateur (affichage direct côté
// frontend sans aller-retour supplémentaire).
router.get(
  '/',
  [
    query('resource_type').isIn(Object.keys(RESOURCE_TABLES)).withMessage('Type de ressource invalide.'),
    query('resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Requête invalide.', details: errors.array() });
    }

    const { resource_type: resourceType, resource_id: resourceId } = req.query;

    const { data, error } = await supabase
      .from('record_shares')
      .select('id, subject_type, subject_id, created_at, created_by_user:users!record_shares_created_by_fkey(full_name)')
      .eq('tenant_id', req.tenantId)
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer les partages.' });
    }

    const userIds = data.filter((row) => row.subject_type === 'user').map((row) => row.subject_id);
    let usersById = {};
    if (userIds.length > 0) {
      const { data: users } = await supabase.from('users').select('id, full_name').in('id', userIds);
      usersById = Object.fromEntries((users || []).map((u) => [u.id, u.full_name]));
    }

    res.json(
      data.map((row) => ({
        id: row.id,
        subject_type: row.subject_type,
        subject_id: row.subject_id,
        subject_label: row.subject_type === 'user' ? usersById[row.subject_id] || 'Utilisateur supprimé' : row.subject_id,
        created_at: row.created_at,
        created_by: row.created_by_user?.full_name || null,
      }))
    );
  }
);

// POST /api/shares — accorde l'accès à UN élément précis à un rôle ou une personne.
router.post(
  '/',
  [
    body('resource_type').isIn(Object.keys(RESOURCE_TABLES)).withMessage('Type de ressource invalide.'),
    body('resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
    body('subject_type').isIn(['role', 'user']).withMessage('Type de destinataire invalide.'),
    body('subject_id').trim().notEmpty().withMessage('Destinataire requis.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { resource_type: resourceType, resource_id: resourceId, subject_type: subjectType, subject_id: subjectId } =
      req.body;

    if (subjectType === 'role' && !SHAREABLE_ROLES.includes(subjectId)) {
      return res.status(400).json({ error: 'Rôle invalide — choisissez manager ou membre.' });
    }
    if (subjectType === 'user') {
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', subjectId)
        .maybeSingle();
      if (!user) {
        return res.status(400).json({ error: "Cet utilisateur n'appartient pas à votre entreprise." });
      }
    }

    const { data: resource } = await supabase
      .from(RESOURCE_TABLES[resourceType])
      .select(selectionFields(resourceType))
      .eq('tenant_id', req.tenantId)
      .eq('id', resourceId)
      .maybeSingle();
    if (!resource) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }
    if (!(await filterShareableRecords(req, resourceType, [resource])).length) {
      return res.status(404).json({ error: 'Élément introuvable.' });
    }

    const { data, error } = await supabase
      .from('record_shares')
      .insert({
        tenant_id: req.tenantId,
        resource_type: resourceType,
        resource_id: resourceId,
        subject_type: subjectType,
        subject_id: subjectId,
        created_by: req.user.id,
      })
      .select('id, subject_type, subject_id, created_at')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Cet élément est déjà partagé avec ce destinataire.' });
      }
      return res.status(500).json({ error: 'Impossible de créer le partage.' });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/shares/:id — retire un partage.
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('record_shares')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Impossible de retirer ce partage.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Partage introuvable.' });
  }

  res.status(204).send();
});

export default router;
