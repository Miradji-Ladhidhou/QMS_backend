import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';
import { hasGenericCategoryPermission, filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const COMPLAINT_STATUSES = ['received', 'investigating', 'resolved', 'closed'];

router.use(requireAuth);

const COMPLAINT_SELECT =
  '*, assigned:users!complaints_assigned_to_fkey(id, full_name), service:services(id, name), category:categories(id, name, color, is_restricted), linked_capa:capas!complaints_linked_capa_id_fkey(id, number, title, status)';

// GET /api/complaints — même scope que CAPA (capas.js) : un member ne voit que les
// réclamations qui lui sont assignées, admin/manager voient tout le tenant — plus une
// éventuelle catégorie restreinte (voir Paramètres > Catégories modules), qui s'applique
// aussi au manager désormais.
router.get('/', async (req, res) => {
  let query = supabase.from('complaints').select(COMPLAINT_SELECT).eq('tenant_id', req.tenantId).order('received_date', { ascending: false });

  const sharedIds =
    req.userRole === 'admin'
      ? new Set()
      : await getSharedResourceIds({ tenantId: req.tenantId, resourceType: 'complaint', userId: req.user.id, userRole: req.userRole });

  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les réclamations.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte : filterViewableByCategory laisse passer toute réclamation dont la
  // catégorie n'est PAS restreinte (ou sans catégorie) — sur celles-là, la règle de base "un
  // member ne voit que les siennes" s'applique encore, sans quoi la catégorie rendrait tout
  // visible par défaut. Sur une catégorie explicitement restreinte, la permission de catégorie
  // devient l'autorité et peut donner accès même non-assigné (ou le retirer même assigné).
  const categoryViewableIds = new Set(
    (await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data })).map((c) => c.id)
  );
  const visible = data.filter((complaint) => {
    if (sharedIds.has(complaint.id)) return true;
    if (!categoryViewableIds.has(complaint.id)) return false;
    if (req.userRole === 'member' && !complaint.category?.is_restricted) {
      return complaint.assigned_to === req.user.id;
    }
    return true;
  });
  res.json(visible);
});

// GET /api/complaints/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('complaints')
    .select(COMPLAINT_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Réclamation introuvable.' });
  }

  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'complaint',
      resourceId: data.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: data.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'Réclamation introuvable.' });
      }
      if (req.userRole === 'member' && !data.category?.is_restricted && data.assigned_to !== req.user.id) {
        return res.status(404).json({ error: 'Réclamation introuvable.' });
      }
    }
  }

  res.json(data);
});

// POST /api/complaints — tous les rôles (comme CAPA : n'importe qui peut enregistrer une
// réclamation reçue), mais un member se la voit toujours auto-assigner, même règle que
// POST /api/capas.
router.post(
  '/',
  [
    body('customer_name').trim().notEmpty().withMessage('Le nom du client est requis.'),
    body('customer_contact').optional({ values: 'falsy' }).trim(),
    body('received_date').isISO8601().withMessage('Date de réception invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('description').trim().notEmpty().withMessage('La description est requise.'),
    body('product_service').optional({ values: 'falsy' }).trim(),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      customer_name: customerName,
      customer_contact: customerContact,
      received_date: receivedDate,
      due_date: dueDate,
      description,
      product_service: productService,
      severity,
      service_id: serviceId,
      assigned_to: assignedTo,
      category_id: categoryId,
    } = req.body;

    const finalAssignedTo = req.userRole === 'member' ? req.user.id : assignedTo || null;

    const { data, error } = await supabase
      .from('complaints')
      .insert({
        tenant_id: req.tenantId,
        customer_name: customerName,
        customer_contact: customerContact || null,
        received_date: receivedDate,
        due_date: dueDate || null,
        description,
        product_service: productService || null,
        severity: severity || undefined,
        service_id: serviceId || null,
        assigned_to: finalAssignedTo,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(COMPLAINT_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la réclamation.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/complaints/:id — réservé à admin/manager, même règle que CAPA : un member peut
// enregistrer une réclamation mais ne peut plus la faire évoluer une fois créée.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('customer_name').optional().trim().notEmpty().withMessage('Le nom du client ne peut pas être vide.'),
    body('customer_contact').optional({ values: 'falsy' }).trim(),
    body('received_date').optional().isISO8601().withMessage('Date de réception invalide.'),
    body('due_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'),
    body('product_service').optional({ values: 'falsy' }).trim(),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('status').optional().isIn(COMPLAINT_STATUSES).withMessage('Statut invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('assigned_to').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('resolution').optional({ values: 'falsy' }).trim(),
    body('resolution_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de résolution invalide.'),
    body('customer_satisfied').optional({ nullable: true }).isBoolean().withMessage('Valeur invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of [
      'customer_name',
      'customer_contact',
      'received_date',
      'due_date',
      'description',
      'product_service',
      'severity',
      'status',
      'service_id',
      'assigned_to',
      'root_cause',
      'resolution',
      'resolution_date',
      'category_id',
    ]) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('customer_satisfied' in req.body) update.customer_satisfied = req.body.customer_satisfied;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('complaints')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(COMPLAINT_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Réclamation introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/complaints/:id — admin/manager uniquement, comme CAPA.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('complaints')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la réclamation.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Réclamation introuvable.' });
  }

  res.status(204).end();
});

// POST /api/complaints/:id/create-capa — crée une CAPA à partir de cette réclamation et lie
// les deux dans les deux sens. Même mécanique que POST /qqoqccp/:id/create-capa (lien direct,
// pas de sous-ressource comme pour les audits — la réclamation est déjà l'unité atomique).
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
    const { data: complaint, error: fetchError } = await supabase
      .from('complaints')
      .select('id, customer_name, description')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !complaint) {
      return res.status(404).json({ error: 'Réclamation introuvable.' });
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
        origin: `Réclamation client (${complaint.customer_name}) — ${complaint.description.slice(0, 150)}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        complaint_id: complaint.id,
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
      .from('complaints')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', complaint.id);

    if (linkError) {
      console.error('Échec de la mise à jour de la réclamation après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
