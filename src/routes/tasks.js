import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];

router.use(requireAuth);

// Un admin/manager peut tout gérer. Sinon, seuls le créateur et l'assigné peuvent modifier
// ou supprimer une tâche — pour qu'un member reste capable de cocher/corriger ses propres
// tâches (contrairement à CAPA, il n'y a pas ici de workflow qualité à protéger).
function canManageTask(req, task) {
  return MANAGER_ROLES.includes(req.userRole) || task.created_by === req.user.id || task.assigned_to === req.user.id;
}

// GET /api/tasks — toutes les tâches du tenant (tous les rôles) ; le filtrage "mes tâches"
// pour un member se fait côté planning.js, pas ici (cette liste reste la vue de gestion). Une
// catégorie explicitement restreinte (Paramètres > Catégories) peut limiter l'accès — opt-in,
// sans effet tant qu'aucune catégorie n'est créée.
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tasks')
    .select(
      '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted)'
    )
    .eq('tenant_id', req.tenantId)
    .order('due_date', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les tâches.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// POST /api/tasks — création (tous les rôles)
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('due_date').isISO8601().withMessage('Échéance invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('assigned_employee_id').optional({ values: 'falsy' }).isUUID().withMessage('Personne assignée invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      description,
      due_date: dueDate,
      assigned_to: assignedTo,
      assigned_employee_id: assignedEmployeeId,
      category_id: categoryId,
    } = req.body;

    if (assignedTo && assignedEmployeeId) {
      return res.status(400).json({ error: "Choisissez un assigné, pas les deux à la fois." });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        tenant_id: req.tenantId,
        title,
        description: description || null,
        due_date: dueDate,
        assigned_to: assignedTo || null,
        assigned_employee_id: assignedEmployeeId || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(
        '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted)'
      )
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la tâche.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/tasks/:id — modification (admin/manager, créateur, ou assigné)
router.patch(
  '/:id',
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional({ nullable: true, values: 'falsy' }).trim(),
    body('due_date').optional().isISO8601().withMessage('Échéance invalide.'),
    body('status').optional().isIn(['todo', 'done']).withMessage('Statut invalide.'),
    body('assigned_to').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('assigned_employee_id')
      .optional({ nullable: true, values: 'falsy' })
      .isUUID()
      .withMessage('Personne assignée invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('tasks')
      .select('id, created_by, assigned_to')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Tâche introuvable.' });
    }

    if (!canManageTask(req, existing)) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }

    if (req.body.assigned_to && req.body.assigned_employee_id) {
      return res.status(400).json({ error: "Choisissez un assigné, pas les deux à la fois." });
    }

    const update = {};
    for (const field of ['title', 'description', 'due_date', 'status']) {
      if (field in req.body) update[field] = req.body[field] ?? null;
    }
    if ('assigned_to' in req.body) {
      update.assigned_to = req.body.assigned_to || null;
      if (update.assigned_to) update.assigned_employee_id = null;
    }
    if ('assigned_employee_id' in req.body) {
      update.assigned_employee_id = req.body.assigned_employee_id || null;
      if (update.assigned_employee_id) update.assigned_to = null;
    }
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(
        '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted)'
      )
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Tâche introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/tasks/:id — admin/manager ou créateur
router.delete('/:id', async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from('tasks')
    .select('id, created_by, assigned_to')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: 'Tâche introuvable.' });
  }

  if (!(MANAGER_ROLES.includes(req.userRole) || existing.created_by === req.user.id)) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }

  const { error } = await supabase.from('tasks').delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la tâche.' });
  }

  res.status(204).end();
});

export default router;
