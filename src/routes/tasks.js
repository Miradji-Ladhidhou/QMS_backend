import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();
const MANAGER_ROLES = ['admin', 'manager'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];

router.use(requireAuth);

function isValidChecklist(value) {
  return (
    Array.isArray(value) &&
    value.every((entry) => entry && typeof entry.text === 'string' && typeof entry.done === 'boolean')
  );
}

// Prochaine échéance calculée depuis l'échéance d'origine (pas "aujourd'hui") pour ne pas
// dériver si une tâche récurrente est clôturée en retard — voir la note de garde-fou plus bas.
// Arithmétique en UTC de bout en bout (Date.UTC + setUTC*) : purement pour éviter qu'un
// serveur dans un fuseau horaire différent d'UTC ne décale la date d'un jour en repassant par
// des méthodes locales (getDate/setDate) autour de minuit — bug réel constaté en test.
function nextDueDate(dueDate, recurrence, interval) {
  const [year, month, day] = dueDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (recurrence === 'daily') date.setUTCDate(date.getUTCDate() + interval);
  else if (recurrence === 'weekly') date.setUTCDate(date.getUTCDate() + interval * 7);
  else if (recurrence === 'monthly') date.setUTCMonth(date.getUTCMonth() + interval);
  return date.toISOString().slice(0, 10);
}

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
      '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id)'
    )
    .eq('tenant_id', req.tenantId)
    .order('due_date', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les tâches.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  // is_private_to_me : le formulaire d'édition (Planning.jsx, TaskFormModal) prend sa tâche
  // directement dans cette liste, jamais un second appel — calculé ici pour la même raison
  // que can_edit sur les documents (éviter au frontend de comparer lui-même owner_user_id à
  // l'utilisateur courant, chargé séparément et pas forcément déjà disponible).
  res.json(visible.map((task) => ({ ...task, is_private_to_me: task.category?.owner_user_id === req.user.id })));
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
    body('priority').optional().isIn(PRIORITIES).withMessage('Priorité invalide.'),
    body('checklist').optional().custom(isValidChecklist).withMessage('Checklist invalide.'),
    body('recurrence').optional().isIn(RECURRENCES).withMessage('Récurrence invalide.'),
    body('recurrence_interval').optional().isInt({ min: 1 }).withMessage('Intervalle de récurrence invalide.'),
  ],
  requireValidCategoryId('task'),
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
      priority,
      checklist,
      recurrence,
      recurrence_interval: recurrenceInterval,
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
        priority: priority || 'normal',
        checklist: checklist || [],
        recurrence: recurrence || 'none',
        recurrence_interval: recurrenceInterval || 1,
        created_by: req.user.id,
      })
      .select(
        '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id)'
      )
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la tâche.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/tasks/bulk-category — déplace plusieurs tâches d'un coup vers une catégorie.
// Placée avant PATCH /:id pour ne pas être capturée comme un id. Réservé admin/manager
// (contrairement au PATCH individuel ci-dessous, ouvert au créateur/assigné) : un déplacement
// en masse touche potentiellement des tâches d'autres personnes.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une tâche.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('task'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tasks')
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
    body('priority').optional().isIn(PRIORITIES).withMessage('Priorité invalide.'),
    body('checklist').optional().custom(isValidChecklist).withMessage('Checklist invalide.'),
    body('recurrence').optional().isIn(RECURRENCES).withMessage('Récurrence invalide.'),
    body('recurrence_interval').optional().isInt({ min: 1 }).withMessage('Intervalle de récurrence invalide.'),
  ],
  requireValidCategoryId('task'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('tasks')
      .select(
        'id, created_by, assigned_to, assigned_employee_id, category_id, title, description, due_date, status, priority, recurrence, recurrence_interval'
      )
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
    if ('priority' in req.body) update.priority = req.body.priority;
    if ('checklist' in req.body) update.checklist = req.body.checklist;
    if ('recurrence' in req.body) update.recurrence = req.body.recurrence;
    if ('recurrence_interval' in req.body) update.recurrence_interval = req.body.recurrence_interval;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Clôture d'une tâche récurrente : on recrée la prochaine occurrence à partir de
    // l'échéance D'ORIGINE (existing.due_date), jamais "aujourd'hui" — sinon une tâche
    // hebdomadaire complétée en retard verrait sa cadence dériver au fil des semaines.
    const isClosingRecurring = existing.status !== 'done' && update.status === 'done' && existing.recurrence !== 'none';
    if (isClosingRecurring) {
      await supabase.from('tasks').insert({
        tenant_id: req.tenantId,
        title: existing.title,
        description: existing.description,
        due_date: nextDueDate(existing.due_date, existing.recurrence, existing.recurrence_interval),
        status: 'todo',
        assigned_to: existing.assigned_to,
        assigned_employee_id: existing.assigned_employee_id,
        category_id: existing.category_id,
        priority: existing.priority,
        checklist: [],
        recurrence: existing.recurrence,
        recurrence_interval: existing.recurrence_interval,
        created_by: req.user.id,
      });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(
        '*, assigned_user:users!tasks_assigned_to_fkey(id, full_name), assigned_employee:employees(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id)'
      )
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Tâche introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/tasks/:id — admin/manager ou créateur
// DELETE /api/tasks/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas être
// capturée comme un id, même convention que /bulk-category. Un member ne supprime que ses
// propres tâches (mêmes règles que DELETE /:id) : les ids qu'il ne peut pas supprimer sont
// silencieusement ignorés plutôt que de faire échouer toute la sélection.
router.delete(
  '/bulk',
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une tâche.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    let query = supabase.from('tasks').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).in('id', req.body.ids);
    if (!MANAGER_ROLES.includes(req.userRole)) {
      query = query.eq('created_by', req.user.id);
    }

    const { error, count } = await query;
    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

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
