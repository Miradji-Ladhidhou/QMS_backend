import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const METHODS = ['questionnaire', 'phone', 'email', 'in_person', 'other'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans les autres modules.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('customer-satisfaction'));

const SURVEY_SELECT =
  '*, service:services(id, name), linked_capa:capas!customer_satisfaction_surveys_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/customer-satisfaction — liste tenant-wide, tous les rôles (comme
// nonconforming_outputs.js : le registre concerne le SMQ dans son ensemble). Filtrable par
// méthode.
router.get('/', async (req, res) => {
  let query = supabase.from('customer_satisfaction_surveys').select(SURVEY_SELECT).eq('tenant_id', req.tenantId).order('survey_date', {
    ascending: false,
  });

  if (req.query.method) query = query.eq('method', req.query.method);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les enquêtes de satisfaction.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/customer-satisfaction/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('customer_satisfaction_surveys')
    .select(SURVEY_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Enquête introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Enquête introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/customer-satisfaction — ouvert à tous les rôles : n'importe qui en contact avec
// le client (commercial, support, production...) doit pouvoir consigner une enquête, même
// principe que accidents.js/nonconforming_outputs.js.
router.post(
  '/',
  [
    body('customer_name').trim().notEmpty().withMessage('Le nom du client est requis.'),
    body('survey_date').isISO8601().withMessage('Date invalide.'),
    body('method').optional({ values: 'falsy' }).isIn(METHODS).withMessage('Méthode invalide.'),
    body('score').isInt({ min: 1, max: 5 }).withMessage('La note doit être comprise entre 1 et 5.'),
    body('comments').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('customer_satisfaction'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      customer_name: customerName,
      survey_date: surveyDate,
      method,
      score,
      comments,
      service_id: serviceId,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('customer_satisfaction_surveys')
      .insert({
        tenant_id: req.tenantId,
        customer_name: customerName,
        survey_date: surveyDate,
        method: method || undefined,
        score,
        comments: comments || null,
        service_id: serviceId || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(SURVEY_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de l’enquête.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/customer-satisfaction/bulk-category — déplace plusieurs enquêtes d'un coup vers
// une catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une enquête.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('customer_satisfaction'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('customer_satisfaction_surveys')
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

// PATCH /api/customer-satisfaction/:id — admin/manager uniquement : corriger une enquête déjà
// consignée (score, commentaire, date...) reste une action de gestion, contrairement à son
// signalement initial ouvert à tous. Pas de statut/workflow : une enquête est un fait constaté,
// pas un dossier à trancher — aucun garde-fou de clôture ici.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('customer_name').optional().trim().notEmpty().withMessage('Le nom du client ne peut pas être vide.'),
    body('survey_date').optional().isISO8601().withMessage('Date invalide.'),
    body('method').optional().isIn(METHODS).withMessage('Méthode invalide.'),
    body('score').optional().isInt({ min: 1, max: 5 }).withMessage('La note doit être comprise entre 1 et 5.'),
    body('comments').optional({ nullable: true, values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('customer_satisfaction'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['customer_name', 'survey_date', 'method', 'comments']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('score' in req.body) update.score = req.body.score;
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('customer_satisfaction_surveys')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(SURVEY_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Enquête introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/customer-satisfaction/bulk — suppression en masse. Placée avant DELETE /:id
// pour ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une enquête.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('customer_satisfaction_surveys')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/customer-satisfaction/:id — admin/manager uniquement, sans exception créateur
// (même choix que les modules précédents).
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('customer_satisfaction_surveys')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de l’enquête.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Enquête introuvable.' });
  }

  res.status(204).end();
});

// POST /api/customer-satisfaction/:id/create-capa — crée une CAPA à partir de cette enquête
// et lie les deux dans les deux sens. Même mécanique optionnelle que
// POST /suppliers/:supplierId/evaluations/:id/create-capa. Pas de lien obligatoire même sur
// un score de 1 : rien n'impose historiquement une CAPA systématique dans ce cas ici.
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
    const { data: survey, error: fetchError } = await supabase
      .from('customer_satisfaction_surveys')
      .select('id, customer_name, score')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !survey) {
      return res.status(404).json({ error: 'Enquête introuvable.' });
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
        origin: `Enquête de satisfaction — ${survey.customer_name} (${survey.score}/5)`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        customer_satisfaction_survey_id: survey.id,
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
      .from('customer_satisfaction_surveys')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', survey.id);

    if (linkError) {
      console.error('Échec de la mise à jour de l’enquête après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
