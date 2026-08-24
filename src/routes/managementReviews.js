import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { buildQmsSnapshot } from '../services/qmsSnapshot.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const REVIEW_STATUSES = ['draft', 'completed'];
// Même niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans audits.js/qqoqccp.js,
// pas de couplage utile entre ces fichiers indépendants.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('management-reviews'));

const REVIEW_TEXT_FIELDS = [
  'title',
  'participants',
  'previous_actions_status',
  'context_changes',
  'resource_adequacy',
  'improvement_opportunities',
  'conclusions',
];

// GET /api/management-reviews — liste tenant-wide, tous les rôles (même transparence que les
// audits : une revue de direction concerne le SMQ dans son ensemble).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('management_reviews')
    .select('id, title, review_date, status, created_at, category_id, category:categories(id, name, color, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .order('review_date', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les revues de direction.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte (voir Paramètres > Catégories modules) — opt-in, ne change rien tant
  // qu'aucune catégorie revue n'est marquée restreinte.
  const viewable = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(viewable);
});

// GET /api/management-reviews/:id — détail avec ses actions, CAPA liée résolue pour chacune.
router.get('/:id', async (req, res) => {
  const { data: review, error } = await supabase
    .from('management_reviews')
    .select('*, category:categories(id, name, color, is_restricted, owner_user_id)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !review) {
    return res.status(404).json({ error: 'Revue de direction introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const categoryAllowed = await hasGenericCategoryPermission({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      categoryId: review.category_id,
      permission: 'view',
    });
    if (!categoryAllowed) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }
  }

  const { data: actions, error: actionsError } = await supabase
    .from('management_review_actions')
    .select('*, linked_capa:capas!management_review_actions_linked_capa_id_fkey(id, number, title, status)')
    .eq('tenant_id', req.tenantId)
    .eq('review_id', review.id)
    .order('created_at', { ascending: true });

  if (actionsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les actions de cette revue.' });
  }

  res.json({ ...review, actions, is_private_to_me: review.category?.owner_user_id === req.user.id });
});

// POST /api/management-reviews — admin/manager uniquement, comme pour les audits : une revue
// de direction n'est pas ouverte à l'initiative d'un member.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('review_date').isISO8601().withMessage('Date de revue invalide.'),
    body('participants').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('management_reviews')
      .insert({
        tenant_id: req.tenantId,
        title: req.body.title,
        review_date: req.body.review_date,
        participants: req.body.participants || null,
        category_id: req.body.category_id || null,
        created_by: req.user.id,
      })
      .select('*')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la revue de direction.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/management-reviews/bulk-category — déplace plusieurs revues d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('management_reviews')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids)
      .select('id');

    if (error) {
      return res.status(500).json({ error: 'Erreur lors du déplacement.' });
    }

    res.json({ updated: data.length });
  }
);

// PATCH /api/management-reviews/:id — admin/manager uniquement. Le passage à status =
// 'completed' capture automatiquement un snapshot chiffré du SMQ (une seule fois : un
// snapshot déjà posé n'est jamais recalculé, pour rester une photo fidèle du jour de clôture
// même si la revue est rouverte/modifiée ensuite).
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('review_date').optional().isISO8601().withMessage('Date de revue invalide.'),
    body('status').optional().isIn(REVIEW_STATUSES).withMessage('Statut invalide.'),
    ...REVIEW_TEXT_FIELDS.filter((f) => f !== 'title').map((field) => body(field).optional({ values: 'falsy' }).trim()),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('management_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('management_reviews')
      .select('id, status, snapshot')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }

    const update = {};
    for (const field of [...REVIEW_TEXT_FIELDS, 'review_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('status' in req.body) update.status = req.body.status;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (update.status === 'completed' && !existing.snapshot) {
      update.snapshot = await buildQmsSnapshot(req.tenantId);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('management_reviews')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Revue de direction introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/management-reviews/:id — admin/manager uniquement. Cascade sur les actions
// (voir schema.sql) ; les CAPA déjà créées à partir d'une action survivent
// (management_review_action_id passe à null, on delete set null).
// DELETE /api/management-reviews/bulk — suppression en masse. Placée avant DELETE /:id pour
// ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('management_reviews')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('management_reviews')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la revue de direction.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Revue de direction introuvable.' });
  }

  res.status(204).end();
});

async function resolveReview(req, res) {
  const { data: review, error } = await supabase
    .from('management_reviews')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.reviewId)
    .single();

  if (error || !review) {
    res.status(404).json({ error: 'Revue de direction introuvable.' });
    return null;
  }
  return review;
}

// POST /api/management-reviews/:reviewId/actions — admin/manager uniquement.
router.post(
  '/:reviewId/actions',
  requireRole('admin', 'manager'),
  [body('description').trim().notEmpty().withMessage('La description est requise.')],
  async (req, res) => {
    const review = await resolveReview(req, res);
    if (!review) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('management_review_actions')
      .insert({
        tenant_id: req.tenantId,
        review_id: review.id,
        description: req.body.description,
        created_by: req.user.id,
      })
      .select('*, linked_capa:capas!management_review_actions_linked_capa_id_fkey(id, number, title, status)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'action." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/management-reviews/:reviewId/actions/:id — admin/manager uniquement.
router.patch(
  '/:reviewId/actions/:id',
  requireRole('admin', 'manager'),
  [body('description').trim().notEmpty().withMessage('La description ne peut pas être vide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('management_review_actions')
      .update({ description: req.body.description })
      .eq('tenant_id', req.tenantId)
      .eq('review_id', req.params.reviewId)
      .eq('id', req.params.id)
      .select('*, linked_capa:capas!management_review_actions_linked_capa_id_fkey(id, number, title, status)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Action introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/management-reviews/:reviewId/actions/:id — admin/manager uniquement.
router.delete('/:reviewId/actions/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('management_review_actions')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('review_id', req.params.reviewId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'action." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Action introuvable.' });
  }

  res.status(204).end();
});

// POST /api/management-reviews/:reviewId/actions/:id/create-capa — crée une CAPA à partir
// d'une action de revue et lie les deux dans les deux sens. Même mécanique que
// POST /audits/:auditId/findings/:id/create-capa.
router.post(
  '/:reviewId/actions/:id/create-capa',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: action, error: fetchError } = await supabase
      .from('management_review_actions')
      .select('id, description')
      .eq('tenant_id', req.tenantId)
      .eq('review_id', req.params.reviewId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !action) {
      return res.status(404).json({ error: 'Action introuvable.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
    } = req.body;

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        origin: `Revue de direction — action : ${action.description.slice(0, 200)}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        management_review_action_id: action.id,
        created_by: req.user.id,
      })
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (capaError) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    if (capa.assigned_to) {
      notifyCapaAssigned(req.tenantId, capa).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    const { error: linkError } = await supabase
      .from('management_review_actions')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', action.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'action après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
