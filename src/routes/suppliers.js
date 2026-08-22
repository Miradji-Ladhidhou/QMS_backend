import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const SUPPLIER_STATUSES = ['active', 'inactive', 'suspended'];
const EVALUATION_DECISIONS = ['maintained', 'under_watch', 'to_replace'];

router.use(requireAuth);

const SUPPLIER_SELECT = '*, service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/suppliers — liste tenant-wide par défaut (transparence, comme audits/risks : un
// fournisseur n'est "possédé" par personne en particulier), sauf catégorie restreinte
// explicitement créée par l'admin (voir Paramètres > Catégories modules) — opt-in, ne change
// rien tant qu'aucune catégorie fournisseur n'est marquée restreinte.
router.get('/', async (req, res) => {
  let query = supabase.from('suppliers').select(SUPPLIER_SELECT).eq('tenant_id', req.tenantId).order('name', { ascending: true });

  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.service_id) query = query.eq('service_id', req.query.service_id);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les fournisseurs.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  const viewable = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(viewable);
});

// GET /api/suppliers/:id — détail avec l'historique de ses évaluations, CAPA liée résolue.
router.get('/:id', async (req, res) => {
  const { data: supplier, error } = await supabase
    .from('suppliers')
    .select(SUPPLIER_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !supplier) {
    return res.status(404).json({ error: 'Fournisseur introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const categoryAllowed = await hasGenericCategoryPermission({
      tenantId: req.tenantId,
      userId: req.user.id,
      userRole: req.userRole,
      categoryId: supplier.category_id,
      permission: 'view',
    });
    if (!categoryAllowed) {
      return res.status(404).json({ error: 'Fournisseur introuvable.' });
    }
  }

  const { data: evaluations, error: evaluationsError } = await supabase
    .from('supplier_evaluations')
    .select(
      '*, evaluator:users!supplier_evaluations_evaluated_by_fkey(id, full_name), linked_capa:capas!supplier_evaluations_linked_capa_id_fkey(id, number, title, status)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('supplier_id', supplier.id)
    .order('evaluation_date', { ascending: false });

  if (evaluationsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les évaluations de ce fournisseur.' });
  }

  res.json({ ...supplier, evaluations, is_private_to_me: supplier.category?.owner_user_id === req.user.id });
});

// POST /api/suppliers — admin/manager uniquement : la gestion du référentiel fournisseurs est
// une activité de pilotage, comme Services/Personnel (services.js/employees.js).
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage('Le nom du fournisseur est requis.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('contact_name').optional({ values: 'falsy' }).trim(),
    body('contact_email').optional({ values: 'falsy' }).trim(),
    body('contact_phone').optional({ values: 'falsy' }).trim(),
    body('criticality').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Criticité invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('next_evaluation_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      name,
      category,
      contact_name: contactName,
      contact_email: contactEmail,
      contact_phone: contactPhone,
      criticality,
      service_id: serviceId,
      next_evaluation_date: nextEvaluationDate,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        tenant_id: req.tenantId,
        name,
        category: category || null,
        contact_name: contactName || null,
        contact_email: contactEmail || null,
        contact_phone: contactPhone || null,
        criticality: criticality || undefined,
        service_id: serviceId || null,
        next_evaluation_date: nextEvaluationDate || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(SUPPLIER_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du fournisseur.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/suppliers/:id — admin/manager uniquement.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom ne peut pas être vide.'),
    body('category').optional({ values: 'falsy' }).trim(),
    body('contact_name').optional({ values: 'falsy' }).trim(),
    body('contact_email').optional({ values: 'falsy' }).trim(),
    body('contact_phone').optional({ values: 'falsy' }).trim(),
    body('criticality').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Criticité invalide.'),
    body('status').optional().isIn(SUPPLIER_STATUSES).withMessage('Statut invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('next_evaluation_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de revue invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['name', 'category', 'contact_name', 'contact_email', 'contact_phone', 'criticality', 'status', 'next_evaluation_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('suppliers')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(SUPPLIER_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Fournisseur introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/suppliers/:id — admin/manager uniquement. Cascade sur les évaluations (voir
// schema.sql) ; les CAPA déjà créées à partir d'une évaluation survivent
// (supplier_evaluation_id passe à null, on delete set null).
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase.from('suppliers').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du fournisseur.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Fournisseur introuvable.' });
  }

  res.status(204).end();
});

async function resolveSupplier(req, res) {
  const { data: supplier, error } = await supabase
    .from('suppliers')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.supplierId)
    .single();

  if (error || !supplier) {
    res.status(404).json({ error: 'Fournisseur introuvable.' });
    return null;
  }
  return supplier;
}

const EVALUATION_SELECT =
  '*, evaluator:users!supplier_evaluations_evaluated_by_fkey(id, full_name), linked_capa:capas!supplier_evaluations_linked_capa_id_fkey(id, number, title, status)';

// POST /api/suppliers/:supplierId/evaluations — admin/manager uniquement.
router.post(
  '/:supplierId/evaluations',
  requireRole('admin', 'manager'),
  [
    body('evaluation_date').isISO8601().withMessage("Date d'évaluation invalide."),
    body('quality_score').isInt({ min: 1, max: 5 }).withMessage('Note qualité invalide (1 à 5).'),
    body('delivery_score').isInt({ min: 1, max: 5 }).withMessage('Note délais invalide (1 à 5).'),
    body('price_score').isInt({ min: 1, max: 5 }).withMessage('Note prix invalide (1 à 5).'),
    body('responsiveness_score').isInt({ min: 1, max: 5 }).withMessage('Note réactivité invalide (1 à 5).'),
    body('decision').optional({ values: 'falsy' }).isIn(EVALUATION_DECISIONS).withMessage('Décision invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const supplier = await resolveSupplier(req, res);
    if (!supplier) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      evaluation_date: evaluationDate,
      quality_score: qualityScore,
      delivery_score: deliveryScore,
      price_score: priceScore,
      responsiveness_score: responsivenessScore,
      decision,
      comment,
    } = req.body;

    const { data, error } = await supabase
      .from('supplier_evaluations')
      .insert({
        tenant_id: req.tenantId,
        supplier_id: supplier.id,
        evaluation_date: evaluationDate,
        quality_score: qualityScore,
        delivery_score: deliveryScore,
        price_score: priceScore,
        responsiveness_score: responsivenessScore,
        decision: decision || undefined,
        comment: comment || null,
        evaluated_by: req.user.id,
      })
      .select(EVALUATION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'évaluation." });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/suppliers/:supplierId/evaluations/:id — admin/manager uniquement. Pas de PATCH :
// une évaluation est un relevé daté (comme un training_record ou un kpi_record), on en ajoute
// une nouvelle plutôt que de réécrire l'historique.
router.delete('/:supplierId/evaluations/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('supplier_evaluations')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('supplier_id', req.params.supplierId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'évaluation." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Évaluation introuvable.' });
  }

  res.status(204).end();
});

// POST /api/suppliers/:supplierId/evaluations/:id/create-capa — crée une CAPA à partir d'une
// évaluation (typiquement quand decision = 'under_watch'/'to_replace') et lie les deux dans
// les deux sens. Même mécanique que les autres modules (audits/complaints/risks/reviews).
router.post(
  '/:supplierId/evaluations/:id/create-capa',
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
    const { data: evaluation, error: fetchError } = await supabase
      .from('supplier_evaluations')
      .select('id, supplier:suppliers(name)')
      .eq('tenant_id', req.tenantId)
      .eq('supplier_id', req.params.supplierId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !evaluation) {
      return res.status(404).json({ error: 'Évaluation introuvable.' });
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
        origin: `Évaluation fournisseur — ${evaluation.supplier?.name || ''}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        supplier_evaluation_id: evaluation.id,
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
      .from('supplier_evaluations')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', evaluation.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'évaluation après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
