import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';

const router = Router();

const CALIBRATION_RESULTS = ['conform', 'non_conform'];
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans suppliers.js/risks.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('measuring-equipment'));

const EQUIPMENT_SELECT =
  '*, service:services(id, name), category:categories(id, name, color, is_restricted, owner_user_id)';

// GET /api/measuring-equipment — liste tenant-wide, tous les rôles (comme suppliers.js : le
// registre des équipements de mesure concerne le SMQ dans son ensemble). Filtrable par statut
// actif/inactif.
router.get('/', async (req, res) => {
  let query = supabase.from('measuring_equipment').select(EQUIPMENT_SELECT).eq('tenant_id', req.tenantId).order('name', {
    ascending: true,
  });

  if (req.query.is_active !== undefined) query = query.eq('is_active', req.query.is_active === 'true');

  const { data, error } = await query;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les équipements de mesure.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/measuring-equipment/:id — détail avec l'historique de ses étalonnages, CAPA liée
// résolue pour chacun.
router.get('/:id', async (req, res) => {
  const { data: equipment, error } = await supabase
    .from('measuring_equipment')
    .select(EQUIPMENT_SELECT)
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !equipment) {
    return res.status(404).json({ error: 'Équipement de mesure introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: equipment.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Équipement de mesure introuvable.' });
  }

  const { data: calibrations, error: calibrationsError } = await supabase
    .from('equipment_calibrations')
    .select(
      '*, recorder:users!equipment_calibrations_recorded_by_fkey(id, full_name), linked_capa:capas!equipment_calibrations_linked_capa_id_fkey(id, number, title, status)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('equipment_id', equipment.id)
    .order('calibration_date', { ascending: false });

  if (calibrationsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les étalonnages de cet équipement.' });
  }

  res.json({ ...equipment, calibrations, is_private_to_me: equipment.category?.owner_user_id === req.user.id });
});

// POST /api/measuring-equipment — admin/manager uniquement : déclarer un équipement de mesure
// est une activité de pilotage, comme pour les fournisseurs.
router.post(
  '/',
  requireRole('admin', 'manager'),
  [
    body('name').trim().notEmpty().withMessage("Le nom de l'équipement est requis."),
    body('identifier').optional({ values: 'falsy' }).trim(),
    body('category').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('next_calibration_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('measuring_equipment'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      name,
      identifier,
      category,
      service_id: serviceId,
      next_calibration_date: nextCalibrationDate,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('measuring_equipment')
      .insert({
        tenant_id: req.tenantId,
        name,
        identifier: identifier || null,
        category: category || null,
        service_id: serviceId || null,
        next_calibration_date: nextCalibrationDate || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(EQUIPMENT_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'équipement." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/measuring-equipment/bulk-category — déplace plusieurs équipements d'un coup vers
// une catégorie. Placée avant PATCH /:id pour ne pas être capturée comme un id.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un équipement.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('measuring_equipment'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('measuring_equipment')
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

// PATCH /api/measuring-equipment/:id — admin/manager uniquement.
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('name').optional().trim().notEmpty().withMessage('Le nom ne peut pas être vide.'),
    body('identifier').optional({ nullable: true, values: 'falsy' }).trim(),
    body('category').optional({ nullable: true, values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
    body('next_calibration_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('measuring_equipment'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['name', 'identifier', 'category', 'next_calibration_date']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;
    if ('is_active' in req.body) update.is_active = req.body.is_active;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('measuring_equipment')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(EQUIPMENT_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Équipement de mesure introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/measuring-equipment/bulk — suppression en masse. Placée avant DELETE /:id pour
// ne pas être capturée comme un id, même convention que /bulk-category.
router.delete(
  '/bulk',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un équipement.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { error, count } = await supabase
      .from('measuring_equipment')
      .delete({ count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids);

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

// DELETE /api/measuring-equipment/:id — admin/manager uniquement. Contrairement à
// suppliers.js (qui cascade sur les évaluations), on BLOQUE ici si des étalonnages existent —
// la traçabilité des étalonnages est explicitement exigée par la norme (§7.1.5), donc plus
// protectrice que pour une évaluation fournisseur ; même principe que le garde-fou posé sur
// employees.js/services.js.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { data: equipment, error: equipmentError } = await supabase
    .from('measuring_equipment')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (equipmentError || !equipment) {
    return res.status(404).json({ error: 'Équipement de mesure introuvable.' });
  }

  const { count, error: countError } = await supabase
    .from('equipment_calibrations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', req.tenantId)
    .eq('equipment_id', req.params.id);

  if (countError) {
    return res.status(500).json({ error: 'Impossible de vérifier les étalonnages rattachés.' });
  }

  if (count > 0) {
    return res.status(409).json({
      error: `${count} étalonnage(s) sont rattachés à cet équipement. Désactivez-le plutôt que de le supprimer.`,
    });
  }

  const { error: deleteError } = await supabase.from('measuring_equipment').delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (deleteError) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'équipement." });
  }

  res.status(204).end();
});

async function resolveEquipment(req, res) {
  const { data: equipment, error } = await supabase
    .from('measuring_equipment')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.equipmentId)
    .single();

  if (error || !equipment) {
    res.status(404).json({ error: 'Équipement de mesure introuvable.' });
    return null;
  }
  return equipment;
}

const CALIBRATION_SELECT =
  '*, recorder:users!equipment_calibrations_recorded_by_fkey(id, full_name), linked_capa:capas!equipment_calibrations_linked_capa_id_fkey(id, number, title, status)';

// POST /api/measuring-equipment/:equipmentId/calibrations — admin/manager uniquement. Pas de
// PATCH/PUT : un étalonnage est un relevé daté (comme une évaluation fournisseur ou une
// réalisation de formation), on en ajoute un nouveau plutôt que de réécrire l'historique.
router.post(
  '/:equipmentId/calibrations',
  requireRole('admin', 'manager'),
  [
    body('calibration_date').isISO8601().withMessage("Date d'étalonnage invalide."),
    body('result').optional({ values: 'falsy' }).isIn(CALIBRATION_RESULTS).withMessage('Résultat invalide.'),
    body('performed_by').optional({ values: 'falsy' }).trim(),
    body('certificate_reference').optional({ values: 'falsy' }).trim(),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const equipment = await resolveEquipment(req, res);
    if (!equipment) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      calibration_date: calibrationDate,
      result,
      performed_by: performedBy,
      certificate_reference: certificateReference,
      comment,
    } = req.body;

    // Un étalonnage non conforme doit être expliqué : §7.1.5 demande d'évaluer l'impact sur
    // les mesures déjà faites avec cet équipement depuis son dernier étalonnage valide — sans
    // commentaire, cet enregistrement n'a aucune valeur de preuve. Même famille que le couple
    // decision/comment sur les évaluations fournisseur.
    if (result === 'non_conform' && !comment) {
      return res.status(400).json({ error: 'Justifiez ce résultat non conforme par un commentaire.' });
    }

    const { data, error } = await supabase
      .from('equipment_calibrations')
      .insert({
        tenant_id: req.tenantId,
        equipment_id: equipment.id,
        calibration_date: calibrationDate,
        result: result || undefined,
        performed_by: performedBy || null,
        certificate_reference: certificateReference || null,
        comment: comment || null,
        recorded_by: req.user.id,
      })
      .select(CALIBRATION_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'étalonnage." });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/measuring-equipment/:equipmentId/calibrations/:id — admin/manager uniquement.
router.delete('/:equipmentId/calibrations/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('equipment_calibrations')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('equipment_id', req.params.equipmentId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'étalonnage." });
  }
  if (!count) {
    return res.status(404).json({ error: 'Étalonnage introuvable.' });
  }

  res.status(204).end();
});

// POST /api/measuring-equipment/:equipmentId/calibrations/:id/create-capa — crée une CAPA à
// partir d'un étalonnage (typiquement non conforme) et lie les deux dans les deux sens. Même
// mécanique que POST /suppliers/:supplierId/evaluations/:id/create-capa.
router.post(
  '/:equipmentId/calibrations/:id/create-capa',
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
    const { data: calibration, error: fetchError } = await supabase
      .from('equipment_calibrations')
      .select('id, calibration_date, result, equipment:measuring_equipment(name)')
      .eq('tenant_id', req.tenantId)
      .eq('equipment_id', req.params.equipmentId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !calibration) {
      return res.status(404).json({ error: 'Étalonnage introuvable.' });
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
        origin: `Étalonnage — ${calibration.equipment?.name || ''} (${calibration.calibration_date}, ${
          calibration.result === 'non_conform' ? 'non conforme' : 'conforme'
        })`,
        service_id: serviceId || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        equipment_calibration_id: calibration.id,
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
      .from('equipment_calibrations')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', calibration.id);

    if (linkError) {
      console.error("Échec de la mise à jour de l'étalonnage après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
