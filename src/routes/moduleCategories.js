import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { filterViewableGenericCategories, hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';

const router = Router();
const SUBJECT_TYPES = ['user', 'group'];
// Audits et Risques volontairement absents : transparence totale assumée (voir routes/audits.js
// et routes/risks.js) — une catégorie restreinte irait à l'encontre de ce choix, comme pour le
// partage individuel (record_shares).
const RESOURCE_TYPES = [
  'capa',
  'complaint',
  'qqoqccp',
  'supplier',
  'training',
  'management_review',
  'audit',
  'risk',
  'task',
  'kpi',
];

router.use(requireAuth);

// GET /api/module-categories?resource_type=capa — liste des catégories de ce type pour le
// tenant. Une catégorie restreinte à laquelle l'utilisateur n'a pas accès (can_view)
// n'apparaît pas — même principe de moindre divulgation que GET /api/categories (documents).
router.get('/', [query('resource_type').isIn(RESOURCE_TYPES).withMessage('Type de ressource invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Requête invalide.', details: errors.array() });
  }

  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('resource_type', req.query.resource_type)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les catégories.' });
  }

  const viewable = await filterViewableGenericCategories({ userId: req.user.id, userRole: req.userRole, categories: data });

  res.json(viewable);
});

// POST /api/module-categories — création (admin uniquement)
router.post(
  '/',
  requireRole('admin'),
  [
    body('resource_type').isIn(RESOURCE_TYPES).withMessage('Type de ressource invalide.'),
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { resource_type: resourceType, name, color, is_restricted: isRestricted } = req.body;

    const { data, error } = await supabase
      .from('categories')
      .insert({
        tenant_id: req.tenantId,
        resource_type: resourceType,
        name,
        color: color || null,
        is_restricted: isRestricted ?? false,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une catégorie porte déjà ce nom pour ce module.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création de la catégorie.' });
    }

    res.status(201).json(data);
  }
);

// PUT /api/module-categories/:id — mise à jour (admin uniquement). resource_type n'est jamais
// modifiable après coup : changer le type reviendrait à faire apparaître cette catégorie dans
// un autre module, ce qui n'a pas de sens (les éléments qui y sont déjà rattachés resteraient
// du mauvais resource_type).
router.put(
  '/:id',
  requireRole('admin'),
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, is_restricted: isRestricted } = req.body;

    const update = { name, color: color || null };
    if ('is_restricted' in req.body) {
      update.is_restricted = isRestricted;
    }

    const { data, error } = await supabase
      .from('categories')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Catégorie introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/module-categories/:id — suppression (admin uniquement). Les éléments qui y
// étaient rattachés retombent à category_id=null (on delete set null) plutôt que d'être
// bloqués ou supprimés en cascade.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('categories')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la catégorie.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  res.status(204).send();
});

// GET /api/module-categories/:id/permissions — permissions d'accès (utilisateurs et groupes)
// sur une catégorie restreinte. Même règle que pour les documents : visible par les admins et
// par quiconque a can_edit sur cette catégorie, pas les simples lecteurs.
router.get('/:id/permissions', async (req, res) => {
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (categoryError || !category) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  const allowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: category.id,
    permission: 'edit',
  });

  if (!allowed) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette information." });
  }

  const { data: permissions, error } = await supabase
    .from('generic_category_permissions')
    .select('*')
    .eq('category_id', category.id)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les permissions.' });
  }

  const userIds = permissions.filter((p) => p.subject_type === 'user').map((p) => p.subject_id);
  const groupIds = permissions.filter((p) => p.subject_type === 'group').map((p) => p.subject_id);

  const [{ data: users }, { data: groups }] = await Promise.all([
    userIds.length
      ? supabase.from('users').select('id, full_name').eq('tenant_id', req.tenantId).in('id', userIds)
      : Promise.resolve({ data: [] }),
    groupIds.length
      ? supabase.from('groups').select('id, name').eq('tenant_id', req.tenantId).in('id', groupIds)
      : Promise.resolve({ data: [] }),
  ]);

  const usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  const groupsById = Object.fromEntries((groups || []).map((g) => [g.id, g]));

  const enriched = permissions.map((p) => ({
    ...p,
    subject: p.subject_type === 'user' ? usersById[p.subject_id] || null : groupsById[p.subject_id] || null,
  }));

  res.json(enriched);
});

// POST /api/module-categories/:id/permissions — accorde/modifie les droits d'un utilisateur ou
// groupe sur la catégorie (upsert : un même sujet ne peut avoir qu'une ligne par catégorie).
router.post(
  '/:id/permissions',
  requireRole('admin'),
  [
    body('subject_type').isIn(SUBJECT_TYPES).withMessage('Type de sujet invalide.'),
    body('subject_id').isUUID().withMessage('Sujet invalide.'),
    body('can_view').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_edit').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_approve').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_delete').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (categoryError || !category) {
      return res.status(404).json({ error: 'Catégorie introuvable.' });
    }

    const {
      subject_type: subjectType,
      subject_id: subjectId,
      can_view: canView = true,
      can_edit: canEdit = false,
      can_approve: canApprove = false,
      can_delete: canDelete = false,
    } = req.body;

    const { data, error } = await supabase
      .from('generic_category_permissions')
      .upsert(
        {
          tenant_id: req.tenantId,
          category_id: category.id,
          subject_type: subjectType,
          subject_id: subjectId,
          can_view: canView,
          can_edit: canEdit,
          can_approve: canApprove,
          can_delete: canDelete,
        },
        { onConflict: 'category_id,subject_type,subject_id' }
      )
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la permission." });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/module-categories/:id/permissions/:permissionId — révoque un accès
router.delete('/:id/permissions/:permissionId', requireRole('admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('generic_category_permissions')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('category_id', req.params.id)
    .eq('id', req.params.permissionId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la permission.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Permission introuvable.' });
  }

  res.status(204).send();
});

export default router;
