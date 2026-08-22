import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';
import { hasGenericCategoryPermission, filterViewableByCategory } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const CAPA_STATUSES = ['open', 'in_progress', 'pending_verification', 'closed', 'overdue'];
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];
const PATCHABLE_FIELDS = [
  'status',
  'priority',
  'severity',
  'assigned_to',
  'due_date',
  'service_id',
  'description',
  'root_cause',
  'corrective_action',
  'preventive_action',
  'effectiveness_verified',
  'effectiveness_notes',
  'comment',
  'category_id',
];

// Colonnes explicites (sans "service", le champ texte libre historique) plutôt que '*' :
// aliaser l'embed services(...) en "service" à côté d'un '*' qui contient déjà une colonne
// service texte du même nom provoquerait une collision de clé côté PostgREST. "service" reste
// en base (non supprimée, voir schema.sql) mais l'API ne la lit/écrit plus nulle part — seul
// service_id fait foi désormais, résolu ici en {id, name} comme pour audits/risks/complaints/
// suppliers (voir leurs routes GET respectives, même pattern déjà en place chez eux).
const CAPA_COLUMNS =
  'id, tenant_id, number, title, origin, ref_document, priority, status, assigned_to, due_date, closed_at, created_by, created_at, updated_at, description, severity, root_cause, corrective_action, preventive_action, effectiveness_verified, effectiveness_notes, comment, qqoqccp_analysis_id, service_id, audit_finding_id, management_review_action_id, complaint_id, risk_id, supplier_evaluation_id, category_id';
const CAPA_SELECT = `${CAPA_COLUMNS}, assigned:users!capas_assigned_to_fkey(id, full_name), service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)`;

// Délai de traitement par défaut (en jours depuis la création) quand le tenant n'a pas
// paramétré ses propres valeurs via PUT /api/capas/priority-delays.
const DEFAULT_PRIORITY_DELAYS = { critical: 30, high: 60, medium: 90, low: 120 };

router.use(requireAuth);

async function closeOverdueCapas(tenantId) {
  const today = new Date().toISOString().slice(0, 10);

  await supabase
    .from('capas')
    .update({ status: 'overdue' })
    .eq('tenant_id', tenantId)
    .lt('due_date', today)
    .not('status', 'in', '(closed,overdue)');
}

// GET /api/capas/priority-delays — délais de traitement configurés (jours), avec repli sur
// les valeurs par défaut pour toute priorité non paramétrée par ce tenant.
router.get('/priority-delays', async (req, res) => {
  const { data, error } = await supabase
    .from('capa_priority_delays')
    .select('priority, delay_days')
    .eq('tenant_id', req.tenantId);

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les délais de traitement.' });
  }

  const delays = { ...DEFAULT_PRIORITY_DELAYS };
  for (const row of data) {
    delays[row.priority] = row.delay_days;
  }

  res.json(delays);
});

// PUT /api/capas/priority-delays — paramétrage des délais par priorité (admin uniquement)
router.put(
  '/priority-delays',
  requireRole('admin'),
  CAPA_LEVELS.map((level) => body(level).isInt({ min: 1 }).withMessage(`Délai invalide pour la priorité "${level}".`)),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const rows = CAPA_LEVELS.map((level) => ({
      tenant_id: req.tenantId,
      priority: level,
      delay_days: Number(req.body[level]),
    }));

    const { error } = await supabase.from('capa_priority_delays').upsert(rows, { onConflict: 'tenant_id,priority' });

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour des délais de traitement.' });
    }

    const delays = Object.fromEntries(rows.map((row) => [row.priority, row.delay_days]));
    res.json(delays);
  }
);

// GET /api/capas — liste avec le responsable assigné, statuts en retard mis à jour.
// Visible par tout le tenant par défaut (même modèle que les Documents) — seule une catégorie
// explicitement restreinte (Paramètres > Catégories) limite l'accès, quel que soit le rôle.
// Un member ne peut toujours MODIFIER que les CAPA qui lui sont assignées (voir PATCH /:id) —
// ça, ça reste inchangé, seule la visibilité en lecture s'est simplifiée.
router.get('/', async (req, res) => {
  await closeOverdueCapas(req.tenantId);

  const query = supabase
    .from('capas')
    .select(CAPA_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  // Un partage (voir record_shares/recordSharing.js, bouton Partager) donne accès à une CAPA
  // précise en plus des règles normales — jamais une restriction, uniquement un octroi
  // supplémentaire. Calculé pour tous les rôles non-admin.
  const sharedIds =
    req.userRole === 'admin'
      ? new Set()
      : await getSharedResourceIds({ tenantId: req.tenantId, resourceType: 'capa', userId: req.user.id, userRole: req.userRole });

  const { data, error } = await query;

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les CAPA.' });
  }

  if (req.userRole === 'admin') {
    return res.json(data);
  }

  // Catégorie restreinte (voir Paramètres > Catégories CAPA) : filterViewableByCategory laisse
  // passer toute CAPA dont la catégorie n'est PAS restreinte (ou sans catégorie) — visible par
  // tous dans ce cas. Sur une catégorie explicitement restreinte, seule la permission de
  // catégorie (ou un partage individuel) donne accès, quel que soit le rôle ou l'assignation.
  const categoryViewableIds = new Set(
    (await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data })).map((c) => c.id)
  );
  const visible = data.filter((capa) => sharedIds.has(capa.id) || categoryViewableIds.has(capa.id));

  res.json(visible);
});

// GET /api/capas/:id — détail avec commentaires de suivi
router.get('/:id', async (req, res) => {
  // qqoqccp_analysis!capas_qqoqccp_analysis_id_fkey : deux FK existent entre capas et
  // qqoqccp_analyses (voir B1), PostgREST refuse sinon l'embed (ambigu). many-to-one via
  // capas.qqoqccp_analysis_id = "L'analyse à l'origine de cette CAPA", objet singulier.
  const { data: capa, error } = await supabase
    .from('capas')
    .select(
      `${CAPA_SELECT}, qqoqccp_analysis:qqoqccp_analyses!capas_qqoqccp_analysis_id_fkey(id, title, ai_synthesis)`
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !capa) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  // Même règle que GET / (liste) : visible par tout le tenant, sauf catégorie restreinte
  // (voir Paramètres > Catégories) ou partage individuel qui en lève l'accès.
  if (req.userRole !== 'admin') {
    const shared = await isSharedWithUser({
      tenantId: req.tenantId,
      resourceType: 'capa',
      resourceId: capa.id,
      userId: req.user.id,
      userRole: req.userRole,
    });
    if (!shared) {
      const categoryAllowed = await hasGenericCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: capa.category_id,
        permission: 'view',
      });
      if (!categoryAllowed) {
        return res.status(404).json({ error: 'CAPA introuvable.' });
      }
    }
  }

  const { data: comments, error: commentsError } = await supabase
    .from('capa_comments')
    .select('*, author:users(id, full_name)')
    .eq('capa_id', capa.id)
    .order('created_at', { ascending: true });

  if (commentsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les commentaires.' });
  }

  res.json({ ...capa, comments });
});

// POST /api/capas — création, numérotation automatique CAPA-{année}-{seq}
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('origin').optional({ values: 'falsy' }).trim(),
    body('ref_document').optional({ values: 'falsy' }).isUUID().withMessage('Document de référence invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      description,
      origin,
      ref_document: refDocument,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
      category_id: categoryId,
    } = req.body;

    // Un member peut ouvrir une CAPA mais elle lui est toujours auto-assignée : on ignore
    // toute valeur d'assigned_to reçue du corps de la requête pour ce rôle, sans faire
    // confiance au frontend. admin/manager gardent le comportement d'origine.
    const finalAssignedTo = req.userRole === 'member' ? req.user.id : assignedTo || null;

    const { data, error } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        service_id: serviceId || null,
        description: description || null,
        origin: origin || null,
        ref_document: refDocument || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: finalAssignedTo,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(CAPA_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    notifyCapaAssigned(req.tenantId, data).catch((err) =>
      console.error("Échec de la notification d'assignation CAPA :", err.message)
    );

    res.status(201).json(data);
  }
);

// PATCH /api/capas/:id — mise à jour des champs de suivi (statut, priorité, gravité,
// assignation, échéance, description, analyse des causes, actions, vérification d'efficacité...)
// Réservé à admin/manager : un member peut ouvrir une CAPA mais ne peut plus la modifier une
// fois créée, même si elle lui est assignée — seul le commentaire de suivi lui reste ouvert
// (POST /:id/comments, non restreint).
router.patch(
  '/:id',
  (req, res, next) => {
    if (req.userRole === 'member') {
      return res.status(403).json({
        error: 'Seuls les administrateurs et managers peuvent modifier une CAPA après sa création.',
      });
    }
    next();
  },
  [
    body('status').optional({ values: 'falsy' }).isIn(CAPA_STATUSES).withMessage('Statut invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
    body('effectiveness_verified').optional({ nullable: true }).isBoolean().withMessage('Valeur invalide.'),
    body('effectiveness_notes').optional({ values: 'falsy' }).trim(),
    body('comment').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of PATCHABLE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    if (update.status === 'closed') {
      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('capas')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(CAPA_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    if (update.assigned_to) {
      notifyCapaAssigned(req.tenantId, data).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    res.json(data);
  }
);

// DELETE /api/capas/:id — supprime une CAPA (admin uniquement)
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { data, error } = await supabase
    .from('capas')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  res.status(204).end();
});

// POST /api/capas/:id/comments — ajoute un commentaire de suivi horodaté
router.post(
  '/:id/comments',
  [body('comment').trim().notEmpty().withMessage('Le commentaire ne peut pas être vide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (capaError || !capa) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    const { data, error } = await supabase
      .from('capa_comments')
      .insert({
        tenant_id: req.tenantId,
        capa_id: capa.id,
        user_id: req.user.id,
        comment: req.body.comment,
      })
      .select('*, author:users(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'ajout du commentaire." });
    }

    res.status(201).json(data);
  }
);

export default router;
