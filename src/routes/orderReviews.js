import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const STATUSES = ['pending', 'accepted', 'rejected'];

router.use(requireAuth);
router.use(requireMenuVisible('order-reviews'));

const ORDER_REVIEW_SELECT =
  '*, service:services(id, name), reviewer:users!order_reviews_reviewed_by_fkey(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/order-reviews — liste tenant-wide, tous les rôles (comme complaints.js/
// accidents.js : le registre concerne le SMQ dans son ensemble). Filtrable par statut.
router.get('/', async (req, res) => {
  let query = supabase.from('order_reviews').select(ORDER_REVIEW_SELECT).eq('tenant_id', req.tenantId).order('received_at', {
    ascending: false,
  });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les revues de commande.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/order-reviews/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('order_reviews')
    .select(ORDER_REVIEW_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Revue introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Revue introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/order-reviews — ouvert à tous les rôles : la personne qui reçoit une commande
// n'est pas nécessairement admin/manager (même principe que complaints.js/accidents.js).
// discrepancies/discrepancies_resolved/capability_confirmed/status/decision_comment/
// reviewed_by ne sont pas acceptés ici : la revue/décision vient après le signalement.
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('customer_name').trim().notEmpty().withMessage('Le nom du client est requis.'),
    body('customer_contact').optional({ values: 'falsy' }).trim(),
    body('reference').optional({ values: 'falsy' }).trim(),
    body('received_at').isISO8601().withMessage('Date de réception invalide.'),
    body('specified_requirements').trim().notEmpty().withMessage('Les exigences spécifiées sont requises.'),
    body('implicit_requirements').optional({ values: 'falsy' }).trim(),
    body('regulatory_requirements').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('order_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      customer_name: customerName,
      customer_contact: customerContact,
      reference,
      received_at: receivedAt,
      specified_requirements: specifiedRequirements,
      implicit_requirements: implicitRequirements,
      regulatory_requirements: regulatoryRequirements,
      service_id: serviceId,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('order_reviews')
      .insert({
        tenant_id: req.tenantId,
        title,
        customer_name: customerName,
        customer_contact: customerContact || null,
        reference: reference || null,
        received_at: receivedAt,
        specified_requirements: specifiedRequirements,
        implicit_requirements: implicitRequirements || null,
        regulatory_requirements: regulatoryRequirements || null,
        service_id: serviceId || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(ORDER_REVIEW_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la revue.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/order-reviews/bulk-category — déplace plusieurs revues d'un coup vers une
// catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('order_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('order_reviews')
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

// PATCH /api/order-reviews/:id — admin/manager uniquement : décider d'accepter ou de
// refuser une commande est une décision managériale/commerciale, contrairement au
// signalement initial ouvert à tous.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('customer_name').optional().trim().notEmpty().withMessage('Le nom du client ne peut pas être vide.'),
    body('customer_contact').optional({ nullable: true, values: 'falsy' }).trim(),
    body('reference').optional({ nullable: true, values: 'falsy' }).trim(),
    body('received_at').optional().isISO8601().withMessage('Date de réception invalide.'),
    body('specified_requirements').optional().trim().notEmpty().withMessage('Les exigences spécifiées ne peuvent pas être vides.'),
    body('implicit_requirements').optional({ nullable: true, values: 'falsy' }).trim(),
    body('regulatory_requirements').optional({ nullable: true, values: 'falsy' }).trim(),
    body('discrepancies').optional({ nullable: true, values: 'falsy' }).trim(),
    body('discrepancies_resolved').optional().isBoolean().withMessage('Valeur invalide.'),
    body('capability_confirmed').optional().isBoolean().withMessage('Valeur invalide.'),
    body('decision_comment').optional({ nullable: true, values: 'falsy' }).trim(),
    body('reviewed_by').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Décideur invalide.'),
    body('status').optional().isIn(STATUSES).withMessage('Statut invalide.'),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('order_review'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('order_reviews')
      .select('id, status, discrepancies, discrepancies_resolved, capability_confirmed, decision_comment, reviewed_by')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Revue introuvable.' });
    }

    const update = {};
    for (const field of [
      'title',
      'customer_name',
      'customer_contact',
      'reference',
      'received_at',
      'specified_requirements',
      'implicit_requirements',
      'regulatory_requirements',
      'discrepancies',
      'decision_comment',
      'status',
    ]) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('discrepancies_resolved' in req.body) update.discrepancies_resolved = req.body.discrepancies_resolved;
    if ('capability_confirmed' in req.body) update.capability_confirmed = req.body.capability_confirmed;
    if ('reviewed_by' in req.body) update.reviewed_by = req.body.reviewed_by || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    // Accepter une commande sans avoir confirmé la capacité à répondre aux exigences viderait
    // la revue de son sens (§8.2.3.1, introduction). On relit l'existant pour couvrir le cas où
    // capability_confirmed n'est pas dans CETTE requête (même idiome fetch-fallback que
    // routes/nonconforming_outputs.js et routes/accidents.js).
    if (update.status === 'accepted') {
      const capabilityConfirmed = 'capability_confirmed' in update ? update.capability_confirmed : existing.capability_confirmed;
      if (capabilityConfirmed !== true) {
        return res
          .status(400)
          .json({ error: "Confirmez la capacité à répondre aux exigences avant d'accepter cette commande." });
      }

      // Un écart avec ce qui avait été précédemment exprimé (ex. un devis) doit être résolu
      // avant l'engagement (§8.2.3.1 e / dernier paragraphe) — sinon la commande est acceptée
      // sur une base contradictoire avec l'offre initiale.
      const discrepancies = 'discrepancies' in update ? update.discrepancies : existing.discrepancies;
      if (discrepancies) {
        const discrepanciesResolved =
          'discrepancies_resolved' in update ? update.discrepancies_resolved : existing.discrepancies_resolved;
        if (discrepanciesResolved !== true) {
          return res.status(400).json({ error: "Résolvez l'écart constaté avant d'accepter cette commande." });
        }
      }
    }

    // Refuser une commande sans justification prive la décision de toute valeur de preuve —
    // même idiome "commentaire obligatoire sur verdict négatif" que les autres modules
    // (audits, évaluations fournisseurs, réclamations...).
    if (update.status === 'rejected') {
      const decisionComment = 'decision_comment' in update ? update.decision_comment : existing.decision_comment;
      if (!decisionComment) {
        return res.status(400).json({ error: 'Renseignez un commentaire de décision avant de refuser cette commande.' });
      }
    }

    if (update.status === 'accepted' || update.status === 'rejected') {
      // reviewed_by identifie qui a pris la décision — par défaut la personne qui clôture la
      // revue, sauf précision explicite d'une autre personne. On relit la valeur EFFECTIVE
      // (déjà en base si absente de cette requête) plutôt que juste "la clé est-elle présente" :
      // un formulaire d'édition qui envoie systématiquement `reviewed_by` (null si rien n'est
      // sélectionné) contournerait sinon silencieusement ce défaut — bug réel rencontré et
      // corrigé sur nonconforming_outputs.js#decided_by, appliqué correctement dès le départ ici.
      const reviewedBy = 'reviewed_by' in update ? update.reviewed_by : existing.reviewed_by;
      if (!reviewedBy) {
        update.reviewed_by = req.user.id;
      }
    }

    // Décision : horodatage rafraîchi à chaque changement RÉEL de décision — pas seulement à la
    // première sortie de 'pending' comme closed_at sur accidents.js/nonconforming_outputs.js :
    // ces modules n'ont qu'un seul état terminal, alors qu'ici une revue peut basculer
    // directement de 'rejected' à 'accepted' (ou l'inverse) sans repasser par 'pending' — un
    // reviewed_at qui ne bougerait pas dans ce cas figerait la date de la PREMIÈRE décision,
    // rendant la trace documentée (§8.2.3.2) fausse dès qu'une décision est révisée. On ne le
    // réécrit que si le statut change réellement (pas sur un PATCH qui répète le même statut).
    if ((update.status === 'accepted' || update.status === 'rejected') && existing.status !== update.status) {
      update.reviewed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('order_reviews')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(ORDER_REVIEW_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Revue introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/order-reviews/bulk — suppression en masse. Placée avant DELETE /:id pour ne
// pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins une revue.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('order_reviews')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/order-reviews/:id — admin/manager uniquement, sans exception créateur (même
// choix que nonconforming_outputs.js : une décision d'engagement une fois tranchée ne doit
// pas pouvoir être effacée par n'importe qui l'a initialement signalée).
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('order_reviews')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la revue.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Revue introuvable.' });
  }

  res.status(204).end();
});

export default router;
