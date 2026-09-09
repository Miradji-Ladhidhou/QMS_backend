import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const OBJECTIVE_STATUSES = ['in_progress', 'achieved', 'not_achieved', 'abandoned'];
// Statuts qui affirment qu'une décision négative a été prise sur cet objectif et exigent donc
// une justification à l'appui — voir le gate dans PATCH /:id. "achieved" n'en fait pas partie :
// la valeur cible/le KPI lié sert déjà de preuve, contrairement à un objectif manqué ou
// abandonné qui doit rester exploitable en revue de direction (§9.3.2 c).
const NEGATIVE_OBJECTIVE_STATUSES = ['not_achieved', 'abandoned'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans risks.js/kpis.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('quality-objectives'));

const OBJECTIVE_SELECT =
  '*, owner_user:users!quality_objectives_owner_fkey(id, full_name), linked_kpi:kpis(id, name, unit, target, target_direction), linked_capa:capas!quality_objectives_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/quality-objectives — liste tenant-wide, tous les rôles (comme risks.js/audits.js :
// les objectifs qualité concernent le SMQ dans son ensemble). Filtrable par statut. Une
// catégorie explicitement restreinte peut limiter l'accès — opt-in, sans effet par défaut.
router.get('/', async (req, res) => {
  let query = supabase.from('quality_objectives').select(OBJECTIVE_SELECT).eq('tenant_id', req.tenantId).order('target_date', {
    ascending: true,
  });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les objectifs qualité.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/quality-objectives/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('quality_objectives')
    .select(OBJECTIVE_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Objectif qualité introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Objectif qualité introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/quality-objectives — admin/manager uniquement : établir un objectif qualité est
// une décision de pilotage SMQ, comme pour les audits/risques — un member ne l'ouvre pas de
// sa propre initiative.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('resources_needed').optional({ values: 'falsy' }).trim(),
    body('owner').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('target_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('evaluation_method').optional({ values: 'falsy' }).trim(),
    body('linked_kpi_id').optional({ values: 'falsy' }).isUUID().withMessage('KPI invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('quality_objective'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      description,
      resources_needed: resourcesNeeded,
      owner,
      target_date: targetDate,
      evaluation_method: evaluationMethod,
      linked_kpi_id: linkedKpiId,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('quality_objectives')
      .insert({
        tenant_id: req.tenantId,
        title,
        description: description || null,
        resources_needed: resourcesNeeded || null,
        owner: owner || null,
        target_date: targetDate || null,
        evaluation_method: evaluationMethod || null,
        linked_kpi_id: linkedKpiId || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(OBJECTIVE_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'objectif qualité." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/quality-objectives/bulk-category — déplace plusieurs objectifs d'un coup vers
// une catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un objectif.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('quality_objective'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('quality_objectives')
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

// PATCH /api/quality-objectives/:id — admin/manager uniquement.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional({ nullable: true, values: 'falsy' }).trim(),
    body('resources_needed').optional({ nullable: true, values: 'falsy' }).trim(),
    body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('target_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('evaluation_method').optional({ nullable: true, values: 'falsy' }).trim(),
    body('status').optional().isIn(OBJECTIVE_STATUSES).withMessage('Statut invalide.'),
    body('status_comment').optional({ nullable: true, values: 'falsy' }).trim(),
    body('linked_kpi_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('KPI invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('quality_objective'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('quality_objectives')
      .select('id, status, status_comment')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Objectif qualité introuvable.' });
    }

    const update = {};
    for (const field of ['title', 'description', 'resources_needed', 'evaluation_method', 'status', 'status_comment']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('target_date' in req.body) update.target_date = req.body.target_date || null;
    if ('linked_kpi_id' in req.body) update.linked_kpi_id = req.body.linked_kpi_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Un objectif manqué ou abandonné doit être expliqué (§9.3.2 c, performance du SMQ en
    // revue de direction) — "achieved" n'a pas besoin de ce filet, la valeur cible/le KPI lié
    // sert déjà de preuve. On relit l'existant pour couvrir le cas où status_comment n'est pas
    // dans CETTE requête (même idiome que routes/audits.js PATCH /:id).
    if (NEGATIVE_OBJECTIVE_STATUSES.includes(update.status)) {
      const statusComment = 'status_comment' in update ? update.status_comment : existing.status_comment;
      if (!statusComment) {
        return res.status(400).json({ error: 'Justifiez ce statut par un commentaire.' });
      }
    }

    // achieved_at : posé une seule fois, à la transition vers "achieved" (mirroring
    // capas.js/complaints.js#closed_at) — jamais réécrit si l'objectif était déjà atteint.
    if (update.status === 'achieved' && existing.status !== 'achieved') {
      update.achieved_at = new Date().toISOString().slice(0, 10);
    }

    const { data, error } = await supabase
      .from('quality_objectives')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(OBJECTIVE_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Objectif qualité introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/quality-objectives/bulk — suppression en masse. Placée avant DELETE /:id pour
// ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un objectif.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('quality_objectives')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/quality-objectives/:id — admin/manager uniquement.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('quality_objectives')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'objectif qualité." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Objectif qualité introuvable.' });
  }

  res.status(204).end();
});

// POST /api/quality-objectives/:id/create-capa — crée une CAPA à partir de cet objectif et lie
// les deux dans les deux sens. Même mécanique que POST /kpis/:id/create-capa : lien OPTIONNEL,
// jamais une condition pour changer de statut (contrairement aux NC majeures d'audit ou aux
// accidents graves) — un objectif manqué peut simplement rester documenté par status_comment.
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
    const { data: objective, error: fetchError } = await supabase
      .from('quality_objectives')
      .select('id, title, owner')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !objective) {
      return res.status(404).json({ error: 'Objectif qualité introuvable.' });
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
        origin: `Objectif qualité — ${objective.title}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || objective.owner || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        quality_objective_id: objective.id,
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
      .from('quality_objectives')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', objective.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'objectif qualité après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
