import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { sendEmail } from '../services/email.js';
import { getVisibleMenuKeys } from '../middleware/menuVisibility.js';
import { SHAREABLE_RESOURCES } from '../services/shareableResources.js';
import { GUEST_EXPIRY_DAYS, generateGuestToken, hashGuestToken, normalizeGuestEmail } from '../services/guestSharing.js';
import { previewShareRights } from '../services/shareAccessPreview.js';
import {
  SHAREABLE_RESOURCE_LABELS, selectionFields, selectionItem, filterShareableRecords,
} from '../services/guestShareSelection.js';

const router = Router();
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function visibleTypes(req) {
  const keys = await getVisibleMenuKeys({
    tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, appModules: req.appModules,
  });
  return Object.keys(SHAREABLE_RESOURCES).filter((type) => keys.has(SHAREABLE_RESOURCES[type].module));
}

router.get('/catalog', async (req, res) => {
  const types = await visibleTypes(req);
  res.json(types.map((type) => ({ resource_type: type, label: SHAREABLE_RESOURCE_LABELS[type] })));
});

router.post('/preview', [
  body('recipient_type').isIn(['user', 'role']),
  body('subject_id').isString(),
  body('can_edit').isBoolean({ strict: true }),
  body('can_export').isBoolean({ strict: true }),
  body('items').isArray({ min: 1 }),
  body('items.*.resource_type').isIn(Object.keys(SHAREABLE_RESOURCES)),
  body('items.*.resource_id').isUUID(),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Aperçu du partage invalide.' });
  const { recipient_type: subjectType, subject_id: subjectId } = req.body;
  if ((subjectType === 'role' && !['member', 'manager'].includes(subjectId)) ||
      (subjectType === 'user' && !/^[0-9a-f-]{36}$/i.test(subjectId))) {
    return res.status(400).json({ error: 'Destinataire invalide.' });
  }
  let usersQuery = supabase.from('users').select('id, full_name, role').eq('tenant_id', req.tenantId).neq('role', 'admin').order('id');
  usersQuery = subjectType === 'user' ? usersQuery.eq('id', subjectId) : usersQuery.eq('role', subjectId);
  const recipients = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await usersQuery.range(offset, offset + 999);
    if (error) throw new Error(`Lecture des destinataires impossible : ${error.message}`);
    recipients.push(...data);
    if (data.length < 1000) break;
  }
  if (subjectType === 'user' && !recipients.length) return res.status(400).json({ error: 'Destinataire absent de cette entreprise.' });
  const enabled = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: req.user.id, userRole: 'admin' });
  const manageable = new Set(await visibleTypes(req));
  const grouped = new Map();
  for (const item of req.body.items) {
    if (!manageable.has(item.resource_type)) return res.status(403).json({ error: 'Module inaccessible.' });
    if (!grouped.has(item.resource_type)) grouped.set(item.resource_type, new Set());
    grouped.get(item.resource_type).add(item.resource_id.toLowerCase());
  }
  const records = [];
  const shares = [];
  for (const [type, idSet] of grouped) {
    const ids = [...idSet];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const { data, error } = await supabase.from(SHAREABLE_RESOURCES[type].table).select(selectionFields(type))
        .eq('tenant_id', req.tenantId).in('id', chunk);
      if (error) throw new Error(`Lecture de la sélection impossible : ${error.message}`);
      const accessible = await filterShareableRecords(req, type, data);
      if (accessible.length !== chunk.length) return res.status(404).json({ error: 'Un élément sélectionné est supprimé ou inaccessible.' });
      records.push(...accessible.map((row) => selectionItem(type, row)));
      for (let cursor = 0; ; cursor += 1000) {
        const { data: rows, error: sharesError } = await supabase.from('record_shares')
          .select('id, resource_type, resource_id, subject_type, subject_id, can_edit, can_export')
          .eq('tenant_id', req.tenantId).eq('resource_type', type).in('resource_id', chunk).order('id').range(cursor, cursor + 999);
        if (sharesError) throw new Error(`Lecture des droits existants impossible : ${sharesError.message}`);
        shares.push(...rows);
        if (rows.length < 1000) break;
      }
    }
  }
  const results = [];
  for (const recipient of recipients) {
    const visible = await getVisibleMenuKeys({ tenantId: req.tenantId, userId: recipient.id, userRole: recipient.role });
    results.push({
      id: recipient.id, name: recipient.full_name, role: recipient.role,
      items: records.map((item) => ({
        ...item, module_enabled: enabled.has(SHAREABLE_RESOURCES[item.resource_type].module),
        module_visible: visible.has(SHAREABLE_RESOURCES[item.resource_type].module),
        ...previewShareRights(shares.filter((row) => row.resource_type === item.resource_type && row.resource_id === item.resource_id),
          recipient, { subject_type: subjectType, subject_id: subjectId, can_edit: req.body.can_edit, can_export: req.body.can_export }),
      })),
    });
  }
  res.json({ recipients: results });
});

router.get('/resources', [
  query('resource_type').isIn(Object.keys(SHAREABLE_RESOURCES)),
  query('offset').optional().isInt({ min: 0 }).toInt(),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Sélection de module invalide.' });
  const type = req.query.resource_type;
  if (!(await visibleTypes(req)).includes(type)) return res.status(403).json({ error: 'Ce module ne vous est pas accessible.' });
  const offset = req.query.offset || 0;
  const { data, error } = await supabase.from(SHAREABLE_RESOURCES[type].table)
    .select(selectionFields(type)).eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false }).order('id')
    .range(offset, offset + 99);
  if (error) throw new Error(`Chargement des éléments à partager impossible : ${error.message}`);
  const rows = await filterShareableRecords(req, type, data);
  res.json({ items: rows.map((row) => selectionItem(type, row)), next_offset: data.length === 100 ? offset + 100 : null });
});

router.get('/', [
  query('offset').optional().isInt({ min: 0 }).toInt(),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Pagination invalide.' });
  const offset = req.query.offset || 0;
  const { data, error } = await supabase.from('guest_shares')
    .select('id, title, resource_type, resource_id, email, can_export, expires_at, revoked_at, created_at, guest_share_items(count)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false }).order('id')
    .range(offset, offset + 19);
  if (error) throw new Error(`Lecture des invitations groupées impossible : ${error.message}`);
  res.json({
    items: data.map(({ guest_share_items: counts, ...share }) => ({
      ...share, title: share.title || SHAREABLE_RESOURCE_LABELS[share.resource_type],
      item_count: share.resource_type ? 1 : counts[0]?.count || 0,
    })),
    next_offset: data.length === 20 ? offset + 20 : null,
  });
});

router.post('/', [
  body('recipient_type').optional().isIn(['guest', 'user', 'role']).withMessage('Destinataire invalide.'),
  body('title').trim().isLength({ min: 1, max: 160 }).withMessage('Le titre doit contenir entre 1 et 160 caractères.'),
  body('email').if((_value, { req }) => !req.body.recipient_type || req.body.recipient_type === 'guest')
    .trim().isEmail().withMessage('Adresse email invalide.'),
  body('expires_in_days').if((_value, { req }) => !req.body.recipient_type || req.body.recipient_type === 'guest')
    .isInt().toInt().custom((days) => GUEST_EXPIRY_DAYS.includes(days))
    .withMessage('Choisissez une durée de 1, 7 ou 30 jours.'),
  body('can_edit').optional().isBoolean({ strict: true }).withMessage('Droit de modification invalide.'),
  body('can_export').optional().isBoolean({ strict: true }).withMessage('Droit d’export invalide.'),
  body('items').isArray({ min: 1 }).withMessage('Sélectionnez au moins un élément.'),
  body('items.*.resource_type').isIn(Object.keys(SHAREABLE_RESOURCES)).withMessage('Type de ressource invalide.'),
  body('items.*.resource_id').isUUID().withMessage('Identifiant de ressource invalide.'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  const types = await visibleTypes(req);
  const selected = new Map(req.body.items.map((item) =>
    [`${item.resource_type}:${item.resource_id.toLowerCase()}`,
      { resource_type: item.resource_type, resource_id: item.resource_id.toLowerCase() }]
  ));
  const grouped = new Map();
  for (const item of selected.values()) {
    if (!types.includes(item.resource_type)) return res.status(403).json({ error: 'Un module sélectionné ne vous est pas accessible.' });
    if (!grouped.has(item.resource_type)) grouped.set(item.resource_type, []);
    grouped.get(item.resource_type).push(item.resource_id);
  }
  const items = [];
  for (const [type, ids] of grouped) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const { data, error } = await supabase.from(SHAREABLE_RESOURCES[type].table)
        .select(selectionFields(type)).eq('tenant_id', req.tenantId).in('id', chunk);
      if (error) throw new Error(`Vérification des éléments sélectionnés impossible : ${error.message}`);
      const rows = await filterShareableRecords(req, type, data);
      if (rows.length !== chunk.length) {
        return res.status(404).json({ error: 'Un élément sélectionné est supprimé ou ne vous est pas accessible. Actualisez votre sélection.' });
      }
      items.push(...rows.map((row) => selectionItem(type, row)));
    }
  }
    if (req.body.recipient_type && req.body.recipient_type !== 'guest') {
      const subjectType = req.body.recipient_type;
      const subjectId = req.body.subject_id;
      if (subjectType === 'role' && !['member', 'manager'].includes(subjectId)) {
        return res.status(400).json({ error: 'Choisissez le rôle membre ou gestionnaire.' });
      }
      if (subjectType === 'user') {
        if (typeof subjectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(subjectId)) {
          return res.status(400).json({ error: 'Sélectionnez un membre.' });
        }
        const { data: user, error: userError } = await supabase.from('users').select('id, role')
          .eq('tenant_id', req.tenantId).eq('id', subjectId).maybeSingle();
        if (userError) throw new Error(`Vérification du destinataire impossible : ${userError.message}`);
        if (!user || user.role === 'admin') return res.status(400).json({ error: 'Destinataire invalide. Les administrateurs conservent leurs droits.' });
      }
      const { data: count, error: batchError } = await supabase.rpc('create_internal_share_batch', {
        p_tenant_id: req.tenantId, p_created_by: req.user.id, p_title: req.body.title,
        p_subject_type: subjectType, p_subject_id: subjectId,
        p_can_edit: req.body.can_edit === true, p_can_export: req.body.can_export === true,
        p_items: items.map(({ resource_type, resource_id }) => ({ resource_type, resource_id })),
      });
      if (batchError) throw new Error(`Création du partage interne impossible : ${batchError.message}`);
      return res.status(201).json({ recipient_type: subjectType, item_count: count });
    }
    if (req.body.can_edit === true) return res.status(400).json({ error: 'Un invité sans compte ne peut pas modifier les données.' });
  const token = generateGuestToken();
  const email = normalizeGuestEmail(req.body.email);
  const expiresAt = new Date(Date.now() + req.body.expires_in_days * 86400000).toISOString();
  const { data: share, error } = await supabase.rpc('create_guest_share_bundle', {
    p_tenant_id: req.tenantId, p_created_by: req.user.id, p_title: req.body.title,
    p_email: email, p_token_hash: hashGuestToken(token), p_expires_at: expiresAt,
    p_items: items.map(({ resource_type, resource_id, label }) => ({ resource_type, resource_id, label })),
  }).single();
  if (error) throw new Error(`Création de l'invitation groupée impossible : ${error.message}`);
  const { error: permissionError } = await supabase.from('guest_shares')
    .update({ can_export: req.body.can_export === true }).eq('tenant_id', req.tenantId).eq('id', share.id);
  if (permissionError) {
    const { error: cleanupError } = await supabase.from('guest_shares').delete().eq('tenant_id', req.tenantId).eq('id', share.id);
    if (cleanupError) console.error('[guest-bundle] permission cleanup failed:', cleanupError.message);
    throw new Error(`Configuration des droits invités impossible : ${permissionError.message}`);
  }
  const link = `${process.env.FRONTEND_URL}/guest/${token}`;
  try {
    await sendEmail(email, 'Votre accès invité en lecture seule — QMS SaaS',
      `<p>Vous avez reçu un accès temporaire en lecture seule au partage <strong>${escapeHtml(req.body.title)}</strong>.</p>
       <p>Ce lot contient ${items.length} élément(s). Aucun nouvel élément ne sera ajouté automatiquement.</p>
       <p>Ouvrez <a href="${escapeHtml(link)}">ce lien</a>, puis demandez votre code de vérification par email.</p>
       <p>L'accès expire le ${new Date(expiresAt).toLocaleDateString('fr-FR')} et peut être révoqué à tout moment.</p>`);
  } catch (sendError) {
    const { error: cleanupError } = await supabase.from('guest_shares').delete().eq('tenant_id', req.tenantId).eq('id', share.id);
    if (cleanupError) console.error('[guest-bundle] cleanup after email failure failed:', cleanupError.message);
    throw sendError;
  }
  res.status(201).json({ id: share.id, title: share.title, email, expires_at: expiresAt, item_count: items.length });
});

router.patch('/:id', [
  body('can_export').isBoolean({ strict: true }).withMessage('Droit d’export invalide.'),
], async (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Droit d’export invalide.' });
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'Identifiant invalide.' });
  const { data, error } = await supabase.from('guest_shares').update({ can_export: req.body.can_export })
    .eq('tenant_id', req.tenantId).eq('id', req.params.id).select('id, can_export').maybeSingle();
  if (error) throw new Error(`Mise à jour des droits invités impossible : ${error.message}`);
  if (!data) return res.status(404).json({ error: 'Partage introuvable.' });
  res.json(data);
});

export default router;
