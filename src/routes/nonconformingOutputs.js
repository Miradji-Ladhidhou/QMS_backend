import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const DISPOSITIONS = ['correction', 'segregation', 'return_to_supplier', 'concession', 'scrap', 'other'];
const STATUSES = ['open', 'closed'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans accidents.js/risks.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('nonconforming-outputs'));

const OUTPUT_SELECT =
  '*, service:services(id, name), decider:users!nonconforming_outputs_decided_by_fkey(id, full_name), linked_capa:capas!nonconforming_outputs_linked_capa_id_fkey(id, number, title, status), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/nonconforming-outputs — liste tenant-wide, tous les rôles (comme accidents.js : le
// registre concerne le SMQ dans son ensemble). Filtrable par statut. Une catégorie
// explicitement restreinte peut limiter l'accès — opt-in, sans effet par défaut.
router.get('/', async (req, res) => {
  let query = supabase.from('nonconforming_outputs').select(OUTPUT_SELECT).eq('tenant_id', req.tenantId).order('detected_at', {
    ascending: false,
  });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les non-conformités produit/service.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/nonconforming-outputs/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('nonconforming_outputs')
    .select(OUTPUT_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Non-conformité introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Non-conformité introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/nonconforming-outputs — ouvert à tous les rôles : signaler une non-conformité
// produit/service doit rester simple pour quiconque la constate, contrairement à son
// traitement (réservé admin/manager, voir PATCH /:id ci-dessous). disposition/status/
// action_taken/decided_by ne sont pas acceptés ici : le traitement vient après le
// signalement — même principe que accidents.js (root_cause/status).
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('description').trim().notEmpty().withMessage('La description est requise.'),
    body('detected_at').isISO8601().withMessage('Date de détection invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('disposition').optional({ values: 'falsy' }).isIn(DISPOSITIONS).withMessage('Traitement invalide.'),
    body('customer_informed').optional().isBoolean().withMessage('Valeur invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('nonconforming_output'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      description,
      detected_at: detectedAt,
      service_id: serviceId,
      disposition,
      customer_informed: customerInformed,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('nonconforming_outputs')
      .insert({
        tenant_id: req.tenantId,
        title,
        description,
        detected_at: detectedAt,
        service_id: serviceId || null,
        disposition: disposition || undefined,
        customer_informed: customerInformed || false,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(OUTPUT_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la non-conformité.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/nonconforming-outputs/bulk-category — déplace plusieurs non-conformités d'un
// coup vers une catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une non-conformité.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('nonconforming_output'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('nonconforming_outputs')
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

// PATCH /api/nonconforming-outputs/:id — admin/manager uniquement : traiter/clôturer une
// non-conformité est une décision managériale, contrairement à son signalement initial
// ouvert à tous.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'),
    body('detected_at').optional().isISO8601().withMessage('Date de détection invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('disposition').optional().isIn(DISPOSITIONS).withMessage('Traitement invalide.'),
    body('action_taken').optional({ nullable: true, values: 'falsy' }).trim(),
    body('concession_reference').optional({ nullable: true, values: 'falsy' }).trim(),
    body('customer_informed').optional().isBoolean().withMessage('Valeur invalide.'),
    body('decided_by').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Décideur invalide.'),
    body('status').optional().isIn(STATUSES).withMessage('Statut invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('nonconforming_output'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('nonconforming_outputs')
      .select('id, status, disposition, action_taken, concession_reference')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Non-conformité introuvable.' });
    }

    const update = {};
    for (const field of ['title', 'description', 'detected_at', 'disposition', 'action_taken', 'concession_reference', 'status']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('customer_informed' in req.body) update.customer_informed = req.body.customer_informed;
    if ('decided_by' in req.body) update.decided_by = req.body.decided_by || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Clôturer sans avoir documenté l'action menée viderait la maîtrise de la non-conformité
    // de son sens : §8.7.1 (dernière phrase) exige de revérifier la conformité une fois
    // l'élément corrigé, ce qui suppose que l'action soit décrite. On relit l'existant pour
    // couvrir le cas où action_taken n'est pas dans CETTE requête (même idiome que
    // routes/accidents.js PATCH /:id).
    if (update.status === 'closed') {
      const actionTaken = 'action_taken' in update ? update.action_taken : existing.action_taken;
      if (!actionTaken) {
        return res.status(400).json({ error: "Renseignez l'action menée avant de clôturer cette non-conformité." });
      }

      // Une dérogation (concession) doit être documentée par sa référence d'autorisation
      // (§8.7.2 c) — sans ça, "accepté par dérogation" n'a aucune valeur de preuve.
      const disposition = 'disposition' in update ? update.disposition : existing.disposition;
      if (disposition === 'concession') {
        const concessionReference = 'concession_reference' in update ? update.concession_reference : existing.concession_reference;
        if (!concessionReference) {
          return res.status(400).json({ error: 'Renseignez la référence de la dérogation avant de clôturer cette non-conformité.' });
        }
      }

      // decided_by identifie l'autorité ayant décidé de l'action (§8.7.2 d) — par défaut celle
      // qui clôture, sauf précision explicite d'une autre personne dans cette même requête.
      if (!('decided_by' in update)) {
        update.decided_by = req.user.id;
      }
    }

    // Clôture : horodatage posé une seule fois, à la transition vers 'closed' (mirroring
    // accidents.js/capas.js).
    if (update.status === 'closed' && existing.status !== 'closed') {
      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('nonconforming_outputs')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(OUTPUT_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Non-conformité introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/nonconforming-outputs/bulk — suppression en masse. Placée avant DELETE /:id
// pour ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une non-conformité.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('nonconforming_outputs')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/nonconforming-outputs/:id — admin/manager uniquement.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('nonconforming_outputs')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la non-conformité.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Non-conformité introuvable.' });
  }

  res.status(204).end();
});

// POST /api/nonconforming-outputs/:id/create-capa — crée une CAPA à partir de cette
// non-conformité et lie les deux dans les deux sens. Même mécanique que
// POST /accidents/:id/create-capa.
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
    const { data: output, error: fetchError } = await supabase
      .from('nonconforming_outputs')
      .select('id, title')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !output) {
      return res.status(404).json({ error: 'Non-conformité introuvable.' });
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
        origin: `Non-conformité produit/service — ${output.title}`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        nonconforming_output_id: output.id,
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
      .from('nonconforming_outputs')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', output.id);

    if (linkError) {
      console.error('Échec de la mise à jour de la non-conformité après création de la CAPA :', linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
