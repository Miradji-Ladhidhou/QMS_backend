import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const KPI_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const KPI_TARGET_DIRECTIONS = ['min', 'max'];
const PATCHABLE_FIELDS = ['name', 'unit', 'target', 'target_direction', 'frequency'];
const RECORD_PATCHABLE_FIELDS = ['period_date', 'value', 'comment'];

router.use(requireAuth);

// GET /api/kpis — liste avec valeurs historiques
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('kpis')
    .select(
      '*, records:kpi_records(id, period_date, value, comment, recorded_by, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name))'
    )
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les KPIs.' });
  }

  res.json(data);
});

// POST /api/kpis — création
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Le nom du KPI est requis.'),
    body('unit').optional({ values: 'falsy' }).trim(),
    body('target').optional({ values: 'falsy' }).isFloat().withMessage('Objectif invalide.'),
    body('target_direction')
      .optional({ values: 'falsy' })
      .isIn(KPI_TARGET_DIRECTIONS)
      .withMessage('Sens de l\'objectif invalide.'),
    body('frequency').optional({ values: 'falsy' }).isIn(KPI_FREQUENCIES).withMessage('Fréquence invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, unit, target, target_direction: targetDirection, frequency } = req.body;

    const { data, error } = await supabase
      .from('kpis')
      .insert({
        tenant_id: req.tenantId,
        name,
        unit: unit || null,
        target: target ?? null,
        target_direction: targetDirection || undefined,
        frequency: frequency || null,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du KPI.' });
    }

    res.status(201).json(data);
  }
);

// GET /api/kpis/:id — détail avec l'historique des valeurs, trié par période croissante
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('kpis')
    .select(
      '*, records:kpi_records(id, period_date, value, comment, recorded_by, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name))'
    )
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .order('period_date', { foreignTable: 'kpi_records', ascending: true })
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  res.json(data);
});

// PATCH /api/kpis/:id — met à jour un ou plusieurs champs (ex: sens de l'objectif)
router.patch(
  '/:id',
  [
    body('target').optional({ values: 'falsy' }).isFloat().withMessage('Objectif invalide.'),
    body('target_direction')
      .optional({ values: 'falsy' })
      .isIn(KPI_TARGET_DIRECTIONS)
      .withMessage('Sens de l\'objectif invalide.'),
    body('frequency').optional({ values: 'falsy' }).isIn(KPI_FREQUENCIES).withMessage('Fréquence invalide.'),
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

    const { data, error } = await supabase
      .from('kpis')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/kpis/:id — suppression, réservée aux rôles owner/admin/manager (les valeurs
// associées sont supprimées en cascade en base, cf. kpi_records.kpi_id dans schema.sql)
router.delete('/:id', requireRole('owner', 'admin', 'manager'), async (req, res) => {
  const { error, count } = await supabase
    .from('kpis')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du KPI.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  res.status(204).send();
});

// POST /api/kpis/:id/records — saisie d'une valeur pour une période, sans double saisie
router.post(
  '/:id/records',
  [
    body('period_date').isISO8601().withMessage('Date de période invalide.'),
    body('value').isFloat().withMessage('Valeur invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: kpi, error: kpiError } = await supabase
      .from('kpis')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (kpiError || !kpi) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    const { period_date: periodDate, value, comment } = req.body;

    const { data, error } = await supabase
      .from('kpi_records')
      .insert({
        tenant_id: req.tenantId,
        kpi_id: kpi.id,
        period_date: periodDate,
        value,
        comment: comment || null,
        recorded_by: req.user.id,
      })
      .select('*, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une valeur existe déjà pour cette période.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la valeur." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/kpis/:id/records/:recordId — corrige une valeur déjà saisie
router.patch(
  '/:id/records/:recordId',
  [
    body('period_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de période invalide.'),
    body('value').optional({ values: 'falsy' }).isFloat().withMessage('Valeur invalide.'),
    body('comment').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: kpi, error: kpiError } = await supabase
      .from('kpis')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (kpiError || !kpi) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }

    const update = {};
    for (const field of RECORD_PATCHABLE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('kpi_records')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('kpi_id', kpi.id)
      .eq('id', req.params.recordId)
      .select('*, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une valeur existe déjà pour cette période.' });
      }
      return res.status(404).json({ error: 'Valeur introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/kpis/:id/records/:recordId — supprime une valeur précise
router.delete('/:id/records/:recordId', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { error, count } = await supabase
    .from('kpi_records')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .eq('id', req.params.recordId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la valeur.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Valeur introuvable.' });
  }

  res.status(204).send();
});

export default router;
