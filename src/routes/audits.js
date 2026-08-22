import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const AUDIT_TYPES = ['process', 'product', 'system'];
const AUDIT_STATUSES = ['planned', 'in_progress', 'completed', 'closed'];
const FINDING_TYPES = ['major_nc', 'minor_nc', 'observation', 'strength'];
// Même niveaux que capas.js (CAPA_LEVELS) — dupliqués ici plutôt qu'importés, comme
// qqoqccp.js le fait déjà pour la même raison (fichiers indépendants, pas de couplage utile).
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);

const AUDIT_SELECT =
  '*, lead:users!audits_lead_auditor_fkey(id, full_name), service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/audits — liste tenant-wide, tous les rôles (transparence : un audit concerne le
// SMQ dans son ensemble, contrairement aux CAPA qui peuvent rester personnelles). Filtrable
// par statut et par service audité. Une catégorie explicitement restreinte (Paramètres >
// Catégories) peut limiter l'accès — opt-in, sans effet tant qu'aucune catégorie n'est créée.
router.get('/', async (req, res) => {
  let query = supabase.from('audits').select(AUDIT_SELECT).eq('tenant_id', req.tenantId).order('planned_date', { ascending: false });

  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }
  if (req.query.service_id) {
    query = query.eq('service_id', req.query.service_id);
  }

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les audits.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/audits/:id — détail avec ses constats (findings), CAPA liée résolue pour chacun.
router.get('/:id', async (req, res) => {
  const { data: audit, error } = await supabase
    .from('audits')
    .select(AUDIT_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !audit) {
    return res.status(404).json({ error: 'Audit introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: audit.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Audit introuvable.' });
  }

  const { data: findings, error: findingsError } = await supabase
    .from('audit_findings')
    .select('*, linked_capa:capas!audit_findings_linked_capa_id_fkey(id, number, title, status)')
    .eq('tenant_id', req.tenantId)
    .eq('audit_id', audit.id)
    .order('created_at', { ascending: true });

  if (findingsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les constats de cet audit.' });
  }

  res.json({ ...audit, findings, is_private_to_me: audit.category?.owner_user_id === req.user.id });
});

const AUDIT_VALIDATORS = [
  body('title').trim().notEmpty().withMessage('Le titre est requis.'),
  body('audit_type').optional({ values: 'falsy' }).isIn(AUDIT_TYPES).withMessage('Type d\'audit invalide.'),
  body('scope').optional({ values: 'falsy' }).trim(),
  body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
  body('lead_auditor').optional({ values: 'falsy' }).isUUID().withMessage('Auditeur invalide.'),
  body('planned_date').isISO8601().withMessage('Date planifiée invalide.'),
  body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
];

// POST /api/audits — planification (admin/manager uniquement : contrairement à CAPA/QQOQCCP,
// un member n'ouvre pas d'audit de sa propre initiative, c'est une décision de pilotage SMQ).
router.post('/', requireRole('admin', 'manager'), AUDIT_VALIDATORS, requireValidCategoryId('audit'), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
  }

  const {
    title,
    audit_type: auditType,
    scope,
    service_id: serviceId,
    lead_auditor: leadAuditor,
    planned_date: plannedDate,
    category_id: categoryId,
  } = req.body;

  const { data, error } = await supabase
    .from('audits')
    .insert({
      tenant_id: req.tenantId,
      title,
      audit_type: auditType || undefined,
      scope: scope || null,
      service_id: serviceId || null,
      lead_auditor: leadAuditor || null,
      planned_date: plannedDate,
      category_id: categoryId || null,
      created_by: req.user.id,
    })
    .select(AUDIT_SELECT)
    .single();

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la création de l'audit." });
  }

  res.status(201).json(data);
});

// PATCH /api/audits/bulk-category — déplace plusieurs audits d'un coup vers une catégorie.
// Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un audit.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('audit'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('audits')
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

// PATCH /api/audits/:id — admin/manager uniquement, même périmètre que la création.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('audit_type').optional({ values: 'falsy' }).isIn(AUDIT_TYPES).withMessage('Type d\'audit invalide.'),
    body('scope').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('lead_auditor').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Auditeur invalide.'),
    body('planned_date').optional().isISO8601().withMessage('Date planifiée invalide.'),
    body('completed_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date de clôture invalide.'),
    body('status').optional().isIn(AUDIT_STATUSES).withMessage('Statut invalide.'),
    body('conclusion').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('audit'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'audit_type', 'scope', 'planned_date', 'completed_date', 'status', 'conclusion']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('lead_auditor' in req.body) update.lead_auditor = req.body.lead_auditor || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('audits')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(AUDIT_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Audit introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/audits/:id — admin/manager uniquement. Cascade sur audit_findings (voir
// schema.sql, audit_findings.audit_id on delete cascade) ; les CAPA déjà créées à partir de
// constats survivent (audit_finding_id passe à null, on delete set null).
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('audits')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'audit." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Audit introuvable.' });
  }

  res.status(204).end();
});

async function resolveAudit(req, res) {
  const { data: audit, error } = await supabase
    .from('audits')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.auditId)
    .single();

  if (error || !audit) {
    res.status(404).json({ error: 'Audit introuvable.' });
    return null;
  }
  return audit;
}

// POST /api/audits/:auditId/findings — ajoute un constat (admin/manager uniquement).
router.post(
  '/:auditId/findings',
  requireRole('admin', 'manager'),
  [
    body('type').isIn(FINDING_TYPES).withMessage('Type de constat invalide.'),
    body('description').trim().notEmpty().withMessage('La description est requise.'),
  ],
  async (req, res) => {
    const audit = await resolveAudit(req, res);
    if (!audit) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('audit_findings')
      .insert({
        tenant_id: req.tenantId,
        audit_id: audit.id,
        type: req.body.type,
        description: req.body.description,
        created_by: req.user.id,
      })
      .select('*, linked_capa:capas!audit_findings_linked_capa_id_fkey(id, number, title, status)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création du constat." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/audits/:auditId/findings/:id — admin/manager uniquement.
router.patch(
  '/:auditId/findings/:id',
  requireRole('admin', 'manager'),
  [
    body('type').optional().isIn(FINDING_TYPES).withMessage('Type de constat invalide.'),
    body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['type', 'description']) {
      if (field in req.body) update[field] = req.body[field];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('audit_findings')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('audit_id', req.params.auditId)
      .eq('id', req.params.id)
      .select('*, linked_capa:capas!audit_findings_linked_capa_id_fkey(id, number, title, status)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Constat introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/audits/:auditId/findings/:id — admin/manager uniquement.
router.delete('/:auditId/findings/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('audit_findings')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('audit_id', req.params.auditId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du constat.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Constat introuvable.' });
  }

  res.status(204).end();
});

// POST /api/audits/:auditId/findings/:id/create-capa — crée une CAPA à partir d'un constat et
// lie les deux dans les deux sens. Même mécanique que POST /qqoqccp/:id/create-capa
// (qqoqccp.js), en plus léger (pas de synthèse IA/actions suggérées côté audits).
router.post(
  '/:auditId/findings/:id/create-capa',
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
    const { data: finding, error: fetchError } = await supabase
      .from('audit_findings')
      .select('id, description')
      .eq('tenant_id', req.tenantId)
      .eq('audit_id', req.params.auditId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !finding) {
      return res.status(404).json({ error: 'Constat introuvable.' });
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
        origin: `Audit interne — constat : ${finding.description.slice(0, 200)}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        audit_finding_id: finding.id,
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
      .from('audit_findings')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', finding.id);

    if (linkError) {
      console.error('Échec de la mise à jour du constat après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
