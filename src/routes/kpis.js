import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { buildKpiReportPdf } from '../services/kpiReportPdf.js';

const router = Router();

const KPI_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const KPI_TARGET_DIRECTIONS = ['min', 'max'];
// Le type de calcul précis (ratio, sum, average, count, count_grouped) vit dans
// kpi_calculation_configs.calc_type — ici on distingue seulement saisie manuelle vs calculée.
const KPI_CALCULATION_TYPES = ['manual', 'import'];
const KPI_CALC_TYPES = ['ratio', 'sum', 'average', 'count', 'count_grouped'];
const PATCHABLE_FIELDS = ['name', 'unit', 'target', 'target_direction', 'frequency', 'calculation_type'];
const RECORD_PATCHABLE_FIELDS = ['period_date', 'value', 'comment'];
export const RECORDS_SELECT =
  'id, period_date, value, comment, source, source_import_id, recorded_by, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)';

router.use(requireAuth);

// GET /api/kpis — liste avec valeurs historiques
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('kpis')
    .select(`*, records:kpi_records(${RECORDS_SELECT})`)
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les KPIs.' });
  }

  res.json(data);
});

// GET /api/kpis/report — rapport PDF de synthèse (audit / revue de direction). Placée
// avant GET /:id : sinon "report" serait capturé comme un id et renverrait 404.
router.get('/report', async (req, res) => {
  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', req.tenantId).single();

  const { data: kpis, error } = await supabase
    .from('kpis')
    .select(`*, records:kpi_records(${RECORDS_SELECT})`)
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de générer le rapport.' });
  }

  // Pour les KPI calculés depuis un import, la mention "preuve d'audit" du rapport a besoin
  // du nombre total de lignes brutes jamais importées et de la date du dernier import.
  // kpi_raw_imports.row_count évite de recompter kpi_raw_rows ligne par ligne.
  const importKpiIds = kpis.filter((kpi) => kpi.calculation_type === 'import').map((kpi) => kpi.id);
  const detailStatsByKpi = {};

  if (importKpiIds.length > 0) {
    const { data: importRows } = await supabase
      .from('kpi_raw_imports')
      .select('kpi_id, imported_at, row_count')
      .eq('tenant_id', req.tenantId)
      .in('kpi_id', importKpiIds)
      .order('imported_at', { ascending: false });

    for (const importRow of importRows || []) {
      detailStatsByKpi[importRow.kpi_id] = detailStatsByKpi[importRow.kpi_id] || { count: 0, lastImportedAt: null };
      detailStatsByKpi[importRow.kpi_id].count += importRow.row_count;
      if (!detailStatsByKpi[importRow.kpi_id].lastImportedAt) {
        detailStatsByKpi[importRow.kpi_id].lastImportedAt = importRow.imported_at;
      }
    }
  }

  const pdfBuffer = await buildKpiReportPdf({ tenantName: tenant?.name, kpis, detailStatsByKpi });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="rapport-kpis-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdfBuffer);
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
    body('calculation_type')
      .optional({ values: 'falsy' })
      .isIn(KPI_CALCULATION_TYPES)
      .withMessage('Type de calcul invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      name,
      unit,
      target,
      target_direction: targetDirection,
      frequency,
      calculation_type: calculationType,
    } = req.body;

    const { data, error } = await supabase
      .from('kpis')
      .insert({
        tenant_id: req.tenantId,
        name,
        unit: unit || null,
        target: target ?? null,
        target_direction: targetDirection || undefined,
        frequency: frequency || null,
        calculation_type: calculationType || undefined,
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
    .select(`*, records:kpi_records(${RECORDS_SELECT})`)
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
    body('calculation_type')
      .optional({ values: 'falsy' })
      .isIn(KPI_CALCULATION_TYPES)
      .withMessage('Type de calcul invalide.'),
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

    // Un humain qui corrige une valeur calculée en fait, de fait, une valeur saisie
    // manuellement — elle ne doit plus être présentée comme issue de l'import.
    if ('value' in update) {
      update.source = 'manual';
      update.source_import_id = null;
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

// GET /api/kpis/:id/calculation-config — la recette actuelle du KPI, si une a déjà été
// enregistrée (404 sinon) : sert au frontend à proposer "réutiliser" plutôt que de forcer
// une reconfiguration à chaque import, et à préremplir le formulaire d'édition seule.
router.get('/:id/calculation-config', async (req, res) => {
  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  const { data, error } = await supabase
    .from('kpi_calculation_configs')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la récupération de la configuration de calcul.' });
  }
  if (!data) {
    return res.status(404).json({ error: 'Aucune configuration de calcul pour ce KPI.' });
  }

  res.json(data);
});

// POST /api/kpis/:id/calculation-config — enregistre ou met à jour la recette de calcul
// appliquée aux imports génériques de ce KPI (voir POST /api/kpi-imports/:importId/apply).
router.post(
  '/:id/calculation-config',
  [
    body('calc_type').isIn(KPI_CALC_TYPES).withMessage('Type de calcul invalide.'),
    body('source_column').optional({ values: 'falsy' }).trim(),
    body('filter_column').optional({ values: 'falsy' }).trim(),
    body('filter_value').optional({ values: 'falsy' }).trim(),
    body('group_by_column').optional({ values: 'falsy' }).trim(),
    body('period_column').optional({ values: 'falsy' }).trim(),
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

    const {
      calc_type: calcType,
      source_column: sourceColumn,
      filter_column: filterColumn,
      filter_value: filterValue,
      group_by_column: groupByColumn,
      period_column: periodColumn,
    } = req.body;

    if (calcType === 'ratio' && (!filterColumn || !filterValue)) {
      return res.status(400).json({ error: 'filter_column et filter_value sont requis pour un calcul de type ratio.' });
    }
    if ((calcType === 'sum' || calcType === 'average') && !sourceColumn) {
      return res.status(400).json({ error: `source_column est requis pour un calcul de type ${calcType}.` });
    }
    if (calcType === 'count_grouped' && !groupByColumn) {
      return res.status(400).json({ error: 'group_by_column est requis pour un calcul de type count_grouped.' });
    }

    // Avertissement non bloquant : les colonnes référencées ne figurent pas dans le
    // dernier import de ce KPI, mais un futur fichier pourrait tout de même les contenir
    // (colonnes renommées entre-temps, ou config créée avant le premier import).
    let warning = null;
    const referencedColumns = [sourceColumn, filterColumn, groupByColumn, periodColumn].filter(Boolean);
    if (referencedColumns.length > 0) {
      const { data: lastImport } = await supabase
        .from('kpi_raw_imports')
        .select('detected_columns')
        .eq('tenant_id', req.tenantId)
        .eq('kpi_id', kpi.id)
        .order('imported_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastImport) {
        const knownColumns = new Set(lastImport.detected_columns || []);
        const unknownColumns = referencedColumns.filter((column) => !knownColumns.has(column));
        if (unknownColumns.length > 0) {
          warning = `Colonne(s) absente(s) du dernier import de ce KPI : ${unknownColumns.join(', ')}. Un futur fichier pourrait néanmoins les contenir.`;
        }
      }
    }

    const { data, error } = await supabase
      .from('kpi_calculation_configs')
      .upsert(
        {
          tenant_id: req.tenantId,
          kpi_id: kpi.id,
          calc_type: calcType,
          source_column: sourceColumn || null,
          filter_column: filterColumn || null,
          filter_value: filterValue || null,
          group_by_column: groupByColumn || null,
          period_column: periodColumn || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'kpi_id' }
      )
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la configuration de calcul." });
    }

    res.status(200).json({ ...data, warning });
  }
);

export default router;
