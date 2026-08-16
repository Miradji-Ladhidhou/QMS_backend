import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const KPI_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];

router.use(requireAuth);

// GET /api/kpis — liste avec valeurs historiques
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('kpis')
    .select('*, records:kpi_records(id, period_date, value, recorded_by)')
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
    body('frequency').optional({ values: 'falsy' }).isIn(KPI_FREQUENCIES).withMessage('Fréquence invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, unit, target, frequency } = req.body;

    const { data, error } = await supabase
      .from('kpis')
      .insert({
        tenant_id: req.tenantId,
        name,
        unit: unit || null,
        target: target ?? null,
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

// POST /api/kpis/:id/records — saisie d'une valeur pour une période, sans double saisie
router.post(
  '/:id/records',
  [
    body('period_date').isISO8601().withMessage('Date de période invalide.'),
    body('value').isFloat().withMessage('Valeur invalide.'),
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

    const { period_date: periodDate, value } = req.body;

    const { data, error } = await supabase
      .from('kpi_records')
      .insert({
        tenant_id: req.tenantId,
        kpi_id: kpi.id,
        period_date: periodDate,
        value,
        recorded_by: req.user.id,
      })
      .select()
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

export default router;
