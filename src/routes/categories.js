import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { filterViewableCategories } from '../middleware/documentPermissions.js';

const router = Router();
const APPROVER_ROLES = ['owner', 'admin', 'manager', 'member'];
const SUBJECT_TYPES = ['user', 'group'];

router.use(requireAuth);

// GET /api/categories — liste des catégories du tenant. Une catégorie restreinte à
// laquelle l'utilisateur n'a pas accès (can_view) n'apparaît pas — principe de moindre
// divulgation, notamment pour le sélecteur de filtre de la liste des documents.
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('document_categories')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les catégories.' });
  }

  const viewable = await filterViewableCategories({ userId: req.user.id, userRole: req.userRole, categories: data });

  res.json(viewable);
});

// POST /api/categories — création
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('required_approver_role').optional({ values: 'falsy' }).isIn(APPROVER_ROLES).withMessage('Rôle approbateur invalide.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, required_approver_role: requiredApproverRole, is_restricted: isRestricted } = req.body;

    const { data, error } = await supabase
      .from('document_categories')
      .insert({
        tenant_id: req.tenantId,
        name,
        color: color || null,
        required_approver_role: requiredApproverRole || null,
        is_restricted: isRestricted ?? false,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la catégorie.' });
    }

    res.status(201).json(data);
  }
);

// PUT /api/categories/:id — mise à jour
router.put(
  '/:id',
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('required_approver_role').optional({ values: 'falsy' }).isIn(APPROVER_ROLES).withMessage('Rôle approbateur invalide.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, required_approver_role: requiredApproverRole, is_restricted: isRestricted } = req.body;

    const update = { name, color: color || null, required_approver_role: requiredApproverRole || null };
    if ('is_restricted' in req.body) {
      update.is_restricted = isRestricted;
    }

    const { data, error } = await supabase
      .from('document_categories')
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

// DELETE /api/categories/:id — suppression
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('document_categories')
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

// GET /api/categories/:id/permissions — permissions d'accès (utilisateurs et groupes) sur
// une catégorie restreinte. Réservé aux admins : le tableau des accès est lui-même une
// information sensible.
router.get('/:id/permissions', requireRole('owner', 'admin'), async (req, res) => {
  const { data: category, error: categoryError } = await supabase
    .from('document_categories')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (categoryError || !category) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  const { data: permissions, error } = await supabase
    .from('category_permissions')
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
    subject:
      p.subject_type === 'user' ? usersById[p.subject_id] || null : groupsById[p.subject_id] || null,
  }));

  res.json(enriched);
});

// POST /api/categories/:id/permissions — accorde/modifie les droits d'un utilisateur ou
// groupe sur la catégorie (upsert : un même sujet ne peut avoir qu'une ligne par catégorie).
router.post(
  '/:id/permissions',
  requireRole('owner', 'admin'),
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
      .from('document_categories')
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
      .from('category_permissions')
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

// DELETE /api/categories/:id/permissions/:permissionId — révoque un accès
router.delete('/:id/permissions/:permissionId', requireRole('owner', 'admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('category_permissions')
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
