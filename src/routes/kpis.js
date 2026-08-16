import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const KPI_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const KPI_TARGET_DIRECTIONS = ['min', 'max'];
const KPI_CALCULATION_TYPES = ['manual', 'ratio'];
const PATCHABLE_FIELDS = ['name', 'unit', 'target', 'target_direction', 'frequency', 'calculation_type'];
const RECORD_PATCHABLE_FIELDS = ['period_date', 'value', 'comment'];
const RECORDS_SELECT =
  'id, period_date, value, comment, source, import_batch_id, recorded_by, recorded_by_user:users!kpi_records_recorded_by_fkey(id, full_name)';

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// "conforme"/"non_conforme" sont la forme attendue, mais on tolère les variantes
// courantes ("oui/non", "true/false") pour ne pas bloquer un import sur un détail
// de formulation du fichier source.
const COMPLIANT_VALUES = new Set(['conforme', 'oui', 'true', '1', 'ok']);
const NON_COMPLIANT_VALUES = new Set(['non_conforme', 'non-conforme', 'non conforme', 'non', 'false', '0']);

function parseCompliance(raw) {
  const normalized = (raw || '').trim().toLowerCase();
  if (COMPLIANT_VALUES.has(normalized)) return true;
  if (NON_COMPLIANT_VALUES.has(normalized)) return false;
  return null;
}

// Accepte "yyyy-MM-dd" tel quel, ou "yyyy-MM" ramené au 1er jour du mois.
function normalizePeriodDate(raw) {
  const trimmed = (raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  return null;
}

// Clé de regroupement pour l'agrégation : un KPI mensuel regroupe toutes les lignes du
// mois quelle que soit leur date exacte, les autres fréquences groupent jour pour jour.
function periodGroupKey(periodDate, frequency) {
  return frequency === 'monthly' ? `${periodDate.slice(0, 7)}-01` : periodDate;
}

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
      update.import_batch_id = null;
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

// POST /api/kpis/:id/detail-import — importe un CSV de détail ligne par ligne
// (conforme/non conforme), puis recalcule les valeurs agrégées des périodes touchées.
router.post('/:id/detail-import', csvUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier CSV est requis.' });
  }

  const { data: kpi, error: kpiError } = await supabase
    .from('kpis')
    .select('id, frequency, calculation_type')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (kpiError || !kpi) {
    return res.status(404).json({ error: 'KPI introuvable.' });
  }

  if (kpi.calculation_type !== 'ratio') {
    return res.status(400).json({
      error:
        'Ce KPI n\'est pas configuré en calcul par ratio. Changez d\'abord son type de calcul ("ratio") avant d\'importer un détail.',
    });
  }

  const content = req.file.buffer.toString('utf8');
  // Les exports Excel FR utilisent souvent le point-virgule : on détecte le séparateur
  // plutôt que d'imposer la virgule.
  const firstLine = content.split('\n')[0] || '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

  let rows;
  try {
    rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, delimiter, bom: true });
  } catch (parseError) {
    return res.status(400).json({ error: `Fichier CSV illisible : ${parseError.message}` });
  }

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Le fichier ne contient aucune ligne exploitable.' });
  }

  const requiredColumns = ['item_reference', 'period', 'resultat'];
  const missingColumns = requiredColumns.filter((column) => !(column in rows[0]));
  if (missingColumns.length > 0) {
    return res.status(400).json({ error: `Colonne(s) manquante(s) dans le fichier : ${missingColumns.join(', ')}.` });
  }

  const validRows = [];
  const rejected = [];

  rows.forEach((row, index) => {
    const lineNumber = index + 2; // +1 pour l'en-tête, +1 pour repasser en 1-indexé
    const itemReference = (row.item_reference || '').trim();
    const periodDate = normalizePeriodDate(row.period);
    const isCompliant = parseCompliance(row.resultat);
    const comment = (row.comment || '').trim();

    if (!itemReference) {
      rejected.push({ line: lineNumber, reason: 'item_reference manquant.' });
      return;
    }
    if (!periodDate) {
      rejected.push({ line: lineNumber, reason: `period invalide ("${row.period}").` });
      return;
    }
    if (isCompliant === null) {
      rejected.push({ line: lineNumber, reason: `resultat invalide ("${row.resultat}").` });
      return;
    }

    validRows.push({
      tenant_id: req.tenantId,
      kpi_id: kpi.id,
      period_date: periodDate,
      item_reference: itemReference,
      is_compliant: isCompliant,
      comment: comment || null,
      created_by: req.user.id,
    });
  });

  const { data: batch, error: batchError } = await supabase
    .from('kpi_import_batches')
    .insert({
      tenant_id: req.tenantId,
      kpi_id: kpi.id,
      file_name: req.file.originalname,
      imported_by: req.user.id,
      rows_total: rows.length,
      rows_valid: validRows.length,
      rows_rejected: rejected.length,
    })
    .select()
    .single();

  if (batchError) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement du batch d'import." });
  }

  if (validRows.length === 0) {
    return res.status(400).json({ error: 'Aucune ligne valide dans ce fichier.', batch, rejected });
  }

  const rowsWithBatch = validRows.map((row) => ({ ...row, import_batch_id: batch.id }));

  const { error: insertError } = await supabase.from('kpi_detail_records').insert(rowsWithBatch);

  if (insertError) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement du détail importé." });
  }

  // Recalcule à partir de TOUTES les lignes de détail des périodes touchées (pas
  // seulement celles de cet import), pour rester exact en cas d'imports complémentaires
  // successifs sur une même période.
  const affectedPeriods = new Set(rowsWithBatch.map((row) => periodGroupKey(row.period_date, kpi.frequency)));

  const { data: allDetailRows, error: detailFetchError } = await supabase
    .from('kpi_detail_records')
    .select('period_date, is_compliant')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id);

  if (detailFetchError) {
    return res.status(500).json({ error: 'Erreur lors du recalcul des valeurs agrégées.' });
  }

  const groups = new Map();
  for (const row of allDetailRows) {
    const key = periodGroupKey(row.period_date, kpi.frequency);
    if (!affectedPeriods.has(key)) continue;
    const group = groups.get(key) || { total: 0, compliant: 0 };
    group.total += 1;
    if (row.is_compliant) group.compliant += 1;
    groups.set(key, group);
  }

  const upsertRows = Array.from(groups.entries()).map(([periodDate, group]) => ({
    tenant_id: req.tenantId,
    kpi_id: kpi.id,
    period_date: periodDate,
    value: Number(((group.compliant / group.total) * 100).toFixed(2)),
    source: 'import_csv',
    import_batch_id: batch.id,
    recorded_by: req.user.id,
  }));

  const { data: records, error: upsertError } = await supabase
    .from('kpi_records')
    .upsert(upsertRows, { onConflict: 'kpi_id,period_date' })
    .select(RECORDS_SELECT);

  if (upsertError) {
    return res.status(500).json({ error: 'Erreur lors de la mise à jour des valeurs calculées.' });
  }

  res.status(201).json({ batch, rejected, records });
});

// GET /api/kpis/:id/detail?period=2026-07 — détail ligne par ligne d'une période, pour
// afficher la preuve derrière un point du graphique (period accepte yyyy-MM ou yyyy-MM-dd)
router.get(
  '/:id/detail',
  [query('period').notEmpty().withMessage('Le paramètre period est requis.')],
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

    const period = req.query.period;
    let detailQuery = supabase
      .from('kpi_detail_records')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('kpi_id', kpi.id);

    if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      detailQuery = detailQuery.eq('period_date', period);
    } else if (/^\d{4}-\d{2}$/.test(period)) {
      const [year, month] = period.split('-').map(Number);
      const start = `${period}-01`;
      const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
      detailQuery = detailQuery.gte('period_date', start).lt('period_date', end);
    } else {
      return res.status(400).json({ error: 'Format de period invalide (attendu yyyy-MM ou yyyy-MM-dd).' });
    }

    const { data, error } = await detailQuery.order('item_reference', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Impossible de récupérer le détail.' });
    }

    res.json(data);
  }
);

// GET /api/kpis/:id/import-batches — historique des imports pour ce KPI (qui, quand,
// combien de lignes, quel résultat)
router.get('/:id/import-batches', async (req, res) => {
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
    .from('kpi_import_batches')
    .select('*, imported_by_user:users!kpi_import_batches_imported_by_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('kpi_id', kpi.id)
    .order('imported_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Impossible de récupérer l'historique des imports." });
  }

  res.json(data);
});

export default router;
