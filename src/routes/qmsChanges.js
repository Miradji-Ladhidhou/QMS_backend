import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const STATUSES = ['planned', 'approved', 'implemented', 'cancelled'];

// Graphe de transition explicite (ISO 9001 §6.3 : une modification du SMQ doit être réalisée
// "de façon planifiée") — contrairement à orderReviews.js/nonconforming_outputs.js où status
// est un simple enum validé à l'arrivée, ici un saut direct planned -> implemented (sans être
// jamais passé par 'approved') irait à l'encontre du sens même de la clause. planned/approved
// mènent chacun à un sous-ensemble précis d'états suivants ; implemented/cancelled sont
// terminaux (absents de cet objet = aucune transition sortante autorisée).
const VALID_TRANSITIONS = {
  planned: ['approved', 'cancelled'],
  approved: ['implemented', 'cancelled'],
};

router.use(requireAuth);
router.use(requireMenuVisible('qms-changes'));

const CHANGE_SELECT =
  '*, service:services(id, name), approver:users!qms_changes_approved_by_fkey(id, full_name), implementer:users!qms_changes_implemented_by_fkey(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/qms-changes — liste tenant-wide, tous les rôles (comme order_reviews.js :
// identifier le besoin d'une modification du SMQ n'est pas réservé au management).
// Filtrable par statut.
router.get('/', async (req, res) => {
  let query = supabase.from('qms_changes').select(CHANGE_SELECT).eq('tenant_id', req.tenantId).order('created_at', {
    ascending: false,
  });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les modifications planifiées.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/qms-changes/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('qms_changes')
    .select(CHANGE_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Modification introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Modification introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/qms-changes — ouvert à tous les rôles : identifier le besoin d'une modification
// du SMQ n'est pas réservé au management (même principe que order_reviews.js/accidents.js).
// purpose/planned_date optionnels à la création ; potential_consequences/integrity_impact/
// resources_needed/responsibilities_reallocation/status/approved_by/implemented_by/
// cancellation_reason ne sont pas acceptés ici : l'instruction (les points a à d de §6.3)
// vient après le signalement, lors de la revue admin/manager.
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('description').trim().notEmpty().withMessage('La description est requise.'),
    body('purpose').optional({ values: 'falsy' }).trim(),
    body('planned_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date prévue invalide.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('qms_change'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      description,
      purpose,
      planned_date: plannedDate,
      service_id: serviceId,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('qms_changes')
      .insert({
        tenant_id: req.tenantId,
        title,
        description,
        purpose: purpose || null,
        planned_date: plannedDate || null,
        service_id: serviceId || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(CHANGE_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la modification.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/qms-changes/bulk-category — déplace plusieurs modifications d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une modification.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('qms_change'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('qms_changes')
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

// PATCH /api/qms-changes/:id — admin/manager uniquement : approuver, mettre en œuvre ou
// annuler une modification du SMQ est une décision managériale, contrairement à son
// signalement initial ouvert à tous.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional().trim().notEmpty().withMessage('La description ne peut pas être vide.'),
    body('purpose').optional({ nullable: true, values: 'falsy' }).trim(),
    body('potential_consequences').optional({ nullable: true, values: 'falsy' }).trim(),
    body('integrity_impact').optional({ nullable: true, values: 'falsy' }).trim(),
    body('resources_needed').optional({ nullable: true, values: 'falsy' }).trim(),
    body('responsibilities_reallocation').optional({ nullable: true, values: 'falsy' }).trim(),
    body('planned_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date prévue invalide.'),
    body('cancellation_reason').optional({ nullable: true, values: 'falsy' }).trim(),
    body('approved_by').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Approbateur invalide.'),
    body('implemented_by').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Metteur en œuvre invalide.'),
    body('status').optional().isIn(STATUSES).withMessage('Statut invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('qms_change'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('qms_changes')
      .select(
        'id, status, purpose, potential_consequences, integrity_impact, resources_needed, responsibilities_reallocation, cancellation_reason, approved_by, implemented_by'
      )
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Modification introuvable.' });
    }

    if ('status' in req.body && req.body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(req.body.status)) {
        return res.status(400).json({
          error: `Impossible de passer directement de "${existing.status}" à "${req.body.status}".`,
        });
      }
    }

    const update = {};
    for (const field of [
      'title',
      'description',
      'purpose',
      'potential_consequences',
      'integrity_impact',
      'resources_needed',
      'responsibilities_reallocation',
      'planned_date',
      'cancellation_reason',
      'status',
    ]) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('approved_by' in req.body) update.approved_by = req.body.approved_by || null;
    if ('implemented_by' in req.body) update.implemented_by = req.body.implemented_by || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Approuver sans avoir instruit les 4 points de §6.3 (finalité/conséquences, intégrité du
    // SMQ, ressources, responsabilités) viderait la revue de son sens. On relit l'existant pour
    // couvrir le cas où un champ n'est pas dans CETTE requête (même idiome fetch-fallback que
    // routes/order_reviews.js).
    if (update.status === 'approved') {
      const checks = [
        ['purpose', "la finalité et les conséquences potentielles (§6.3 a)"],
        ['potential_consequences', "les conséquences potentielles (§6.3 a)"],
        ['integrity_impact', "l'impact sur l'intégrité du SMQ (§6.3 b)"],
        ['resources_needed', 'les ressources nécessaires (§6.3 c)'],
        ['responsibilities_reallocation', 'les responsabilités et autorités concernées (§6.3 d)'],
      ];
      for (const [field, label] of checks) {
        const value = field in update ? update[field] : existing[field];
        if (!value) {
          return res.status(400).json({ error: `Renseignez ${label} avant d'approuver cette modification.` });
        }
      }

      // approved_by identifie qui a approuvé — par défaut la personne qui valide cette étape,
      // sauf précision explicite d'une autre personne. Valeur EFFECTIVE (pas simple présence de
      // clé) : un formulaire d'édition qui enverrait systématiquement `approved_by` (null si
      // rien n'est sélectionné) contournerait sinon silencieusement ce défaut — leçon
      // d'order_reviews.js#reviewed_by, appliquée dès le départ ici.
      const approvedBy = 'approved_by' in update ? update.approved_by : existing.approved_by;
      if (!approvedBy) {
        update.approved_by = req.user.id;
      }
      update.approved_at = new Date().toISOString();
    }

    if (update.status === 'implemented') {
      const implementedBy = 'implemented_by' in update ? update.implemented_by : existing.implemented_by;
      if (!implementedBy) {
        update.implemented_by = req.user.id;
      }
      update.implemented_at = new Date().toISOString();
    }

    // Annuler une modification planifiée sans motif prive la décision de toute valeur de
    // preuve — même idiome "commentaire obligatoire sur verdict négatif" que les autres
    // modules (audits, order_reviews...).
    if (update.status === 'cancelled') {
      const cancellationReason = 'cancellation_reason' in update ? update.cancellation_reason : existing.cancellation_reason;
      if (!cancellationReason) {
        return res.status(400).json({ error: 'Renseignez un motif avant d’annuler cette modification.' });
      }
      update.cancelled_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('qms_changes')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(CHANGE_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Modification introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/qms-changes/bulk — suppression en masse. Placée avant DELETE /:id pour ne pas
// être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une modification.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('qms_changes')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/qms-changes/:id — admin/manager uniquement, sans exception créateur (même choix
// que order_reviews.js/nonconforming_outputs.js).
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('qms_changes')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la modification.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Modification introuvable.' });
  }

  res.status(204).end();
});

export default router;
