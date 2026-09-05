import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const SEVERITIES = ['minor', 'moderate', 'severe', 'fatal'];
const STATUSES = ['open', 'investigating', 'closed'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans risks.js/complaints.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('accidents'));

const ACCIDENT_SELECT =
  '*, service:services(id, name), injured_user:users!accidents_injured_user_id_fkey(id, full_name), injured_employee:employees(id, full_name), linked_capa:capas!accidents_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/accidents — liste tenant-wide, tous les rôles (comme risks.js/audits.js : le
// registre concerne le SMQ dans son ensemble). Une catégorie explicitement restreinte
// (Paramètres > Catégories) peut limiter l'accès — opt-in, sans effet par défaut.
router.get('/', async (req, res) => {
  let query = supabase.from('accidents').select(ACCIDENT_SELECT).eq('tenant_id', req.tenantId).order('occurred_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.severity) query = query.eq('severity', req.query.severity);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);
  if (req.query.with_lost_time !== undefined) query = query.eq('with_lost_time', req.query.with_lost_time === 'true');

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le registre des accidents du travail.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible.map((accident) => ({ ...accident, is_private_to_me: accident.category?.owner_user_id === req.user.id })));
});

// GET /api/accidents/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('accidents').select(ACCIDENT_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).single();

  if (error || !data) {
    return res.status(404).json({ error: 'Accident introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Accident introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/accidents — ouvert à tous les rôles : déclarer un accident du travail doit rester
// simple pour quiconque en est témoin, contrairement à la création d'une CAPA/d'un risque qui
// reste une activité de pilotage réservée admin/manager. root_cause et status ne sont pas
// acceptés ici : la cause vient d'une investigation ultérieure, le statut démarre à 'open'.
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('occurred_at').isISO8601().withMessage("Date de l'accident invalide."),
    body('location').optional({ values: 'falsy' }).trim(),
    body('injured_user_id').optional({ values: 'falsy' }).isUUID().withMessage('Personne concernée invalide.'),
    body('injured_employee_id').optional({ values: 'falsy' }).isUUID().withMessage('Personne concernée invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('immediate_cause').optional({ values: 'falsy' }).trim(),
    body('immediate_actions').optional({ values: 'falsy' }).trim(),
    body('severity').optional({ values: 'falsy' }).isIn(SEVERITIES).withMessage('Gravité invalide.'),
    body('with_lost_time').optional().isBoolean().withMessage('Valeur invalide.'),
    body('lost_days').optional({ values: 'falsy' }).isInt({ min: 0 }).withMessage("Nombre de jours d'arrêt invalide."),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('accident'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      occurred_at: occurredAt,
      location,
      injured_user_id: injuredUserId,
      injured_employee_id: injuredEmployeeId,
      service_id: serviceId,
      description,
      immediate_cause: immediateCause,
      immediate_actions: immediateActions,
      severity,
      with_lost_time: withLostTime,
      lost_days: lostDays,
      category_id: categoryId,
    } = req.body;

    if (injuredUserId && injuredEmployeeId) {
      return res.status(400).json({ error: 'Choisissez une seule personne concernée.' });
    }

    const { data, error } = await supabase
      .from('accidents')
      .insert({
        tenant_id: req.tenantId,
        title,
        occurred_at: occurredAt,
        location: location || null,
        injured_user_id: injuredUserId || null,
        injured_employee_id: injuredEmployeeId || null,
        service_id: serviceId || null,
        description: description || null,
        immediate_cause: immediateCause || null,
        immediate_actions: immediateActions || null,
        severity: severity || undefined,
        with_lost_time: withLostTime || false,
        lost_days: lostDays || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(ACCIDENT_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'accident." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/accidents/bulk-category — déplace plusieurs accidents d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un accident.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('accident'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('accidents')
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

// PATCH /api/accidents/:id — admin/manager uniquement : investiguer/clôturer un accident est
// une décision managériale, contrairement à sa déclaration initiale ouverte à tous.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('occurred_at').optional().isISO8601().withMessage("Date de l'accident invalide."),
    body('location').optional({ nullable: true, values: 'falsy' }).trim(),
    body('injured_user_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Personne concernée invalide.'),
    body('injured_employee_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Personne concernée invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ nullable: true, values: 'falsy' }).trim(),
    body('immediate_cause').optional({ nullable: true, values: 'falsy' }).trim(),
    body('immediate_actions').optional({ nullable: true, values: 'falsy' }).trim(),
    body('root_cause').optional({ nullable: true, values: 'falsy' }).trim(),
    body('severity').optional().isIn(SEVERITIES).withMessage('Gravité invalide.'),
    body('with_lost_time').optional().isBoolean().withMessage('Valeur invalide.'),
    body('lost_days').optional({ nullable: true, values: 'falsy' }).isInt({ min: 0 }).withMessage("Nombre de jours d'arrêt invalide."),
    body('status').optional().isIn(STATUSES).withMessage('Statut invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('accident'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (req.body.injured_user_id && req.body.injured_employee_id) {
      return res.status(400).json({ error: 'Choisissez une seule personne concernée.' });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('accidents')
      .select('id, status')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Accident introuvable.' });
    }

    const update = {};
    for (const field of ['title', 'location', 'description', 'immediate_cause', 'immediate_actions', 'root_cause', 'occurred_at', 'severity', 'status']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('with_lost_time' in req.body) update.with_lost_time = req.body.with_lost_time;
    if ('lost_days' in req.body) update.lost_days = req.body.lost_days || null;
    if ('injured_user_id' in req.body) {
      update.injured_user_id = req.body.injured_user_id || null;
      if (update.injured_user_id) update.injured_employee_id = null;
    }
    if ('injured_employee_id' in req.body) {
      update.injured_employee_id = req.body.injured_employee_id || null;
      if (update.injured_employee_id) update.injured_user_id = null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Clôture : horodatage posé une seule fois, à la transition vers 'closed' (mirroring
    // capas.js/complaints.js) — jamais réécrit si l'accident était déjà clôturé.
    if (update.status === 'closed' && existing.status !== 'closed') {
      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('accidents')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(ACCIDENT_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Accident introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/accidents/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas
// être capturée comme un id, même convention que /bulk-category. Un admin supprime tout ce
// qui est sélectionné ; les autres rôles ne suppriment que leurs propres accidents — les ids
// qu'ils ne peuvent pas supprimer sont silencieusement ignorés (même logique que
// DELETE /tasks/bulk), pas de blocage "métier" comme sur les CAPA.
router.delete(
  '/bulk',
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un accident.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    let query = supabase.from('accidents').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).in('id', req.body.ids);
    if (req.userRole !== 'admin') {
      query = query.eq('created_by', req.user.id);
    }

    const { error, count } = await query;
    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/accidents/:id — admin ou créateur.
router.delete('/:id', async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from('accidents')
    .select('id, created_by')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: 'Accident introuvable.' });
  }

  if (req.userRole !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }

  const { error } = await supabase.from('accidents').delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'accident." });
  }

  res.status(204).end();
});

// POST /api/accidents/:id/create-capa — crée une CAPA à partir de cet accident et lie les
// deux dans les deux sens. Même mécanique que POST /risks/:id/create-capa.
router.post(
  '/:id/create-capa',
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
    const { data: accident, error: fetchError } = await supabase
      .from('accidents')
      .select('id, title')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !accident) {
      return res.status(404).json({ error: 'Accident introuvable.' });
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
        origin: `Accident du travail — ${accident.title}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        accident_id: accident.id,
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
      .from('accidents')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', accident.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'accident après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
