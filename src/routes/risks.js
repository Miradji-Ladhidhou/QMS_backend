import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const RISK_TYPES = ['risk', 'opportunity'];
const RISK_STATUSES = ['identified', 'treating', 'treated', 'accepted', 'closed'];
// Même niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans audits.js/complaints.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);

const RISK_SELECT =
  '*, owner_user:users!risks_owner_fkey(id, full_name), service:services(id, name), linked_capa:capas!risks_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted)';

// GET /api/risks — liste tenant-wide, tous les rôles (transparence : le registre des risques
// concerne le SMQ dans son ensemble, comme les audits). Filtrable par statut/type/service. Une
// catégorie explicitement restreinte (Paramètres > Catégories) peut limiter l'accès — opt-in,
// sans effet tant qu'aucune catégorie n'est créée.
router.get('/', async (req, res) => {
  let query = supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).order('risk_score', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.type) query = query.eq('type', req.query.type);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le registre des risques.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/risks/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('risks').select(RISK_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).single();

  if (error || !data) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  res.json(data);
});

// POST /api/risks — admin/manager uniquement : l'identification structurée d'un risque est
// une activité de pilotage SMQ, comme pour les audits/revues de direction — un member ne
// l'ouvre pas de sa propre initiative.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('type').optional({ values: 'falsy' }).isIn(RISK_TYPES).withMessage('Type invalide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('likelihood').isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('impact').isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('review_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      type,
      category,
      description,
      service_id: serviceId,
      owner,
      likelihood,
      impact,
      review_date: reviewDate,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('risks')
      .insert({
        tenant_id: req.tenantId,
        title,
        type: type || undefined,
        category: category || null,
        description: description || null,
        service_id: serviceId || null,
        owner: owner || null,
        likelihood,
        impact,
        review_date: reviewDate || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(RISK_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du risque.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/risks/:id — admin/manager uniquement. risk_score/residual_score ne sont jamais
// acceptés en entrée : ce sont des generated columns (voir schema.sql), Postgres les calcule
// lui-même à partir de likelihood/impact et residual_likelihood/residual_impact.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('type').optional({ values: 'falsy' }).isIn(RISK_TYPES).withMessage('Type invalide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('likelihood').optional().isInt({ min: 1, max: 5 }).withMessage('Probabilité invalide (1 à 5).'),
    body('impact').optional().isInt({ min: 1, max: 5 }).withMessage('Gravité invalide (1 à 5).'),
    body('current_controls').optional({ values: 'falsy' }).trim(),
    body('treatment_plan').optional({ values: 'falsy' }).trim(),
    body('residual_likelihood').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Probabilité résiduelle invalide (1 à 5).'),
    body('residual_impact').optional({ nullable: true, values: 'falsy' }).isInt({ min: 1, max: 5 }).withMessage('Gravité résiduelle invalide (1 à 5).'),
    body('status').optional().isIn(RISK_STATUSES).withMessage('Statut invalide.'),
    body('review_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'type', 'category', 'description', 'current_controls', 'treatment_plan', 'status', 'review_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('likelihood' in req.body) update.likelihood = req.body.likelihood;
    if ('impact' in req.body) update.impact = req.body.impact;
    if ('residual_likelihood' in req.body) update.residual_likelihood = req.body.residual_likelihood || null;
    if ('residual_impact' in req.body) update.residual_impact = req.body.residual_impact || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('risks')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(RISK_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Risque introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/risks/:id — admin/manager uniquement.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('risks').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du risque.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Risque introuvable.' });
  }

  res.status(204).end();
});

// POST /api/risks/:id/create-capa — crée une CAPA à partir de ce risque (typiquement pour
// porter le plan de traitement) et lie les deux dans les deux sens. Même mécanique que
// POST /complaints/:id/create-capa.
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
    const { data: risk, error: fetchError } = await supabase
      .from('risks')
      .select('id, title')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !risk) {
      return res.status(404).json({ error: 'Risque introuvable.' });
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
        origin: `Risque/opportunité — ${risk.title}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        risk_id: risk.id,
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

    const { error: linkError } = await supabase.from('risks').update({ linked_capa_id: capa.id }).eq('tenant_id', req.tenantId).eq('id', risk.id);

    if (linkError) {
      console.error('Échec de la mise à jour du risque après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
