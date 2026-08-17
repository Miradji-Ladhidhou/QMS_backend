import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { KPI_CALC_TYPES, RECORDS_SELECT } from './kpis.js';
import { groupRowsByPeriod, normalizeAnyDate, summarizeGroups, validateFilters } from '../services/kpiCalculation.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

// Les exports Excel FR utilisent souvent le point-virgule, et un copier-coller depuis Excel
// enregistré tel quel produit un fichier tabulé (onglets) — on détecte le séparateur le plus
// probable plutôt que d'imposer la virgule, en comptant les occurrences sur l'en-tête.
const CSV_DELIMITER_CANDIDATES = [',', ';', '\t'];

function detectCsvDelimiter(firstLine) {
  let best = ',';
  let bestCount = 0;
  for (const candidate of CSV_DELIMITER_CANDIDATES) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

function parseCsvBuffer(buffer) {
  const content = buffer.toString('utf8');
  const firstLine = content.split('\n')[0] || '';
  const delimiter = detectCsvDelimiter(firstLine);
  return parse(content, { columns: true, skip_empty_lines: true, trim: true, delimiter, bom: true });
}

// Convertit une cellule exceljs en valeur simple : les dates natives Excel sont ramenées à
// yyyy-MM-dd, les formules à leur résultat calculé, le texte enrichi à sa chaîne brute.
function cellToValue(cell) {
  const raw = cell.value;
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'object') {
    if ('result' in raw) return raw.result ?? null;
    if ('text' in raw) return raw.text;
    if ('richText' in raw) return raw.richText.map((part) => part.text).join('');
  }
  return raw;
}

async function parseExcelBuffer(buffer, requestedSheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (sheetNames.length === 0) {
    const error = new Error("Le fichier Excel ne contient aucun onglet.");
    error.userFacing = true;
    throw error;
  }

  const worksheet = requestedSheetName ? workbook.getWorksheet(requestedSheetName) : workbook.worksheets[0];
  if (!worksheet) {
    const error = new Error(`Onglet "${requestedSheetName}" introuvable. Onglets disponibles : ${sheetNames.join(', ')}.`);
    error.userFacing = true;
    throw error;
  }

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cellToValue(cell) ?? '').trim();
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const rowObject = {};
    let hasValue = false;
    headers.forEach((header, colNumber) => {
      if (!header) return;
      const value = cellToValue(row.getCell(colNumber));
      rowObject[header] = value;
      if (value !== null && value !== '') hasValue = true;
    });
    if (hasValue) rows.push(rowObject);
  });

  return { sheetNames, sheetUsed: worksheet.name, rows };
}

// POST /api/kpi-imports — dépose un fichier CSV/Excel de structure arbitraire. Ne calcule
// rien : détecte les colonnes et stocke chaque ligne telle quelle en JSONB (kpi_raw_rows),
// pour que la recette de calcul (kpi_calculation_configs) soit choisie ensuite, en toute
// connaissance des colonnes réellement présentes dans le fichier.
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Un fichier est requis.' });
  }

  const originalName = req.file.originalname || 'import';
  const extension = originalName.includes('.') ? originalName.split('.').pop().toLowerCase() : '';

  if (req.body.kpi_id) {
    const { data: kpi, error: kpiError } = await supabase
      .from('kpis')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.body.kpi_id)
      .single();

    if (kpiError || !kpi) {
      return res.status(404).json({ error: 'KPI introuvable.' });
    }
  }

  let rows;
  let sheetNames = [];
  let sheetUsed = null;

  if (extension === 'csv') {
    try {
      rows = parseCsvBuffer(req.file.buffer);
    } catch (parseError) {
      return res.status(400).json({ error: `Fichier CSV illisible : ${parseError.message}` });
    }
  } else if (extension === 'xlsx' || extension === 'xls') {
    try {
      const parsed = await parseExcelBuffer(req.file.buffer, (req.body.sheet_name || '').trim() || undefined);
      rows = parsed.rows;
      sheetNames = parsed.sheetNames;
      sheetUsed = parsed.sheetUsed;
    } catch (parseError) {
      return res.status(parseError.userFacing ? 400 : 500).json({ error: parseError.userFacing ? parseError.message : `Fichier Excel illisible : ${parseError.message}` });
    }
  } else {
    return res.status(400).json({ error: 'Format de fichier non supporté (attendu : .csv, .xlsx ou .xls).' });
  }

  if (!rows || rows.length === 0) {
    return res.status(400).json({ error: 'Le fichier ne contient aucune ligne exploitable.' });
  }

  // Aucune colonne n'est imposée : on accepte toute structure, c'est le principe même de
  // l'import générique. Les en-têtes détectées servent seulement à guider la configuration
  // du calcul côté frontend.
  const detectedColumns = Object.keys(rows[0]);

  const { data: importRow, error: importError } = await supabase
    .from('kpi_raw_imports')
    .insert({
      tenant_id: req.tenantId,
      kpi_id: req.body.kpi_id || null,
      file_name: originalName,
      imported_by: req.user.id,
      detected_columns: detectedColumns,
      row_count: rows.length,
    })
    .select()
    .single();

  if (importError) {
    return res.status(500).json({ error: "Erreur lors de l'enregistrement de l'import." });
  }

  const rawRows = rows.map((row, index) => ({
    tenant_id: req.tenantId,
    import_id: importRow.id,
    row_index: index + 1,
    row_data: row,
  }));

  const { error: rowsError } = await supabase.from('kpi_raw_rows').insert(rawRows);

  if (rowsError) {
    // L'import n'a aucune ligne exploitable : on retire l'entête créée plutôt que de
    // laisser un import fantôme sans lignes derrière lui.
    await supabase.from('kpi_raw_imports').delete().eq('id', importRow.id);
    return res.status(500).json({ error: "Erreur lors de l'enregistrement des lignes importées." });
  }

  res.status(201).json({
    import: importRow,
    columns: detectedColumns,
    row_count: rows.length,
    sample: rows.slice(0, 5),
    ...(sheetNames.length > 1 ? { available_sheets: sheetNames, sheet_used: sheetUsed } : {}),
  });
});

// POST /api/kpi-imports/:importId/apply — applique la recette de calcul enregistrée du KPI
// cible aux lignes brutes de cet import, et met à jour kpi_records (upsert par période).
router.post(
  '/:importId/apply',
  [
    body('kpi_id').optional({ values: 'falsy' }).isUUID().withMessage('kpi_id invalide.'),
    body('period_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de période invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    // Mode aperçu : calcule exactement comme un import réel (mêmes lectures, mêmes
    // rejets), mais n'écrit rien dans kpi_records — utile pour valider une recette
    // avant de l'appliquer pour de bon.
    const dryRun = req.body.dry_run === true || req.body.dry_run === 'true';

    const { data: importRow, error: importError } = await supabase
      .from('kpi_raw_imports')
      .select('id, kpi_id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.importId)
      .single();

    if (importError || !importRow) {
      return res.status(404).json({ error: 'Import introuvable.' });
    }

    const targetKpiId = req.body.kpi_id || importRow.kpi_id;
    if (!targetKpiId) {
      return res.status(400).json({ error: 'Aucun KPI cible : précisez kpi_id pour rattacher cet import à un KPI.' });
    }

    if (req.body.kpi_id && req.body.kpi_id !== importRow.kpi_id) {
      const { data: kpiCheck, error: kpiCheckError } = await supabase
        .from('kpis')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('id', targetKpiId)
        .single();

      if (kpiCheckError || !kpiCheck) {
        return res.status(404).json({ error: 'KPI introuvable.' });
      }

      // Un aperçu (dry_run) ne doit avoir aucun effet de bord, y compris le rattachement.
      if (!dryRun) {
        await supabase.from('kpi_raw_imports').update({ kpi_id: targetKpiId }).eq('id', importRow.id);
      }
    }

    const { data: config, error: configError } = await supabase
      .from('kpi_calculation_configs')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('kpi_id', targetKpiId)
      .maybeSingle();

    if (configError) {
      return res.status(500).json({ error: 'Erreur lors de la récupération de la configuration de calcul.' });
    }
    if (!config) {
      return res.status(400).json({
        error:
          "Aucune configuration de calcul enregistrée pour ce KPI. Créez-la via POST /api/kpis/:id/calculation-config avant d'appliquer un import.",
      });
    }

    const { data: rawRows, error: rowsError } = await supabase
      .from('kpi_raw_rows')
      .select('row_index, row_data')
      .eq('tenant_id', req.tenantId)
      .eq('import_id', importRow.id)
      .order('row_index', { ascending: true });

    if (rowsError) {
      return res.status(500).json({ error: 'Erreur lors de la récupération des lignes importées.' });
    }
    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ error: 'Cet import ne contient aucune ligne.' });
    }

    let manualPeriodDate = null;
    if (!config.period_column) {
      manualPeriodDate = normalizeAnyDate(req.body.period_date);
      if (!manualPeriodDate) {
        return res.status(400).json({
          error: "Ce KPI n'a pas de colonne de période dans sa recette : indiquez period_date (yyyy-MM-dd) dans la requête.",
        });
      }
    }

    const groups = groupRowsByPeriod(rawRows, config.period_column, manualPeriodDate);
    const { periods, rowsProcessed, rowsRejected } = summarizeGroups(config, groups);

    const upsertRows = periods
      .filter((period) => period.persisted)
      .map((period) => ({
        tenant_id: req.tenantId,
        kpi_id: targetKpiId,
        period_date: period.period_date,
        value: period.value,
        source: 'import',
        source_import_id: importRow.id,
        recorded_by: req.user.id,
      }));

    let records = [];
    if (!dryRun && upsertRows.length > 0) {
      const { data: upserted, error: upsertError } = await supabase
        .from('kpi_records')
        .upsert(upsertRows, { onConflict: 'kpi_id,period_date' })
        .select(RECORDS_SELECT);

      if (upsertError) {
        return res.status(500).json({ error: 'Erreur lors de la mise à jour des valeurs calculées.' });
      }
      records = upserted;
    }

    res.status(200).json({
      import_id: importRow.id,
      kpi_id: targetKpiId,
      calc_type: config.calc_type,
      dry_run: dryRun,
      rows_total: rawRows.length,
      rows_processed: rowsProcessed,
      rows_rejected: rowsRejected,
      periods,
      records,
    });
  }
);

// POST /api/kpi-imports/:importId/evaluate — aperçu live d'une recette EN COURS DE
// CONSTRUCTION : reçoit une config ad hoc dans le corps de la requête (jamais lue ni écrite
// dans kpi_calculation_configs) et retourne le même format que l'apply en dry_run. Permet au
// wizard de recalculer à chaque changement de champ sans exiger d'enregistrer une recette
// pour "essayer" — contrairement à POST .../apply, qui lit toujours la recette sauvegardée.
router.post(
  '/:importId/evaluate',
  [
    body('calc_type').isIn(KPI_CALC_TYPES).withMessage('Type de calcul invalide.'),
    body('source_column').optional({ values: 'falsy' }).trim(),
    body('filters').optional().isArray().withMessage('filters doit être un tableau.'),
    body('filter_logic').optional({ values: 'falsy' }).isIn(['all', 'any']).withMessage('filter_logic invalide.'),
    body('group_by_column').optional({ values: 'falsy' }).trim(),
    body('period_column').optional({ values: 'falsy' }).trim(),
    body('period_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date de période invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      calc_type: calcType,
      source_column: sourceColumn,
      filters = [],
      filter_logic: filterLogic = 'all',
      group_by_column: groupByColumn,
      period_column: periodColumn,
      period_date: periodDateInput,
    } = req.body;

    const filtersError = validateFilters(filters);
    if (filtersError) {
      return res.status(400).json({ error: filtersError });
    }
    if (calcType === 'ratio' && filters.length === 0) {
      return res.status(400).json({ error: 'Au moins une condition (filters) est requise pour un calcul de type ratio.' });
    }
    if ((calcType === 'sum' || calcType === 'average' || calcType === 'min' || calcType === 'max') && !sourceColumn) {
      return res.status(400).json({ error: `source_column est requis pour un calcul de type ${calcType}.` });
    }
    if (calcType === 'count_grouped' && !groupByColumn) {
      return res.status(400).json({ error: 'group_by_column est requis pour un calcul de type count_grouped.' });
    }

    const { data: importRow, error: importError } = await supabase
      .from('kpi_raw_imports')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.importId)
      .single();

    if (importError || !importRow) {
      return res.status(404).json({ error: 'Import introuvable.' });
    }

    const { data: rawRows, error: rowsError } = await supabase
      .from('kpi_raw_rows')
      .select('row_index, row_data')
      .eq('tenant_id', req.tenantId)
      .eq('import_id', importRow.id)
      .order('row_index', { ascending: true });

    if (rowsError) {
      return res.status(500).json({ error: 'Erreur lors de la récupération des lignes importées.' });
    }
    if (!rawRows || rawRows.length === 0) {
      return res.status(400).json({ error: 'Cet import ne contient aucune ligne.' });
    }

    let manualPeriodDate = null;
    if (!periodColumn) {
      manualPeriodDate = normalizeAnyDate(periodDateInput);
      if (!manualPeriodDate) {
        return res.status(400).json({
          error: "Aucune colonne de période sélectionnée : indiquez period_date (yyyy-MM-dd) pour l'aperçu.",
        });
      }
    }

    const config = {
      calc_type: calcType,
      source_column: sourceColumn || null,
      filters,
      filter_logic: filterLogic,
      group_by_column: groupByColumn || null,
      period_column: periodColumn || null,
    };
    const groups = groupRowsByPeriod(rawRows, config.period_column, manualPeriodDate);
    const { periods, rowsProcessed, rowsRejected } = summarizeGroups(config, groups);

    res.status(200).json({
      import_id: importRow.id,
      calc_type: calcType,
      rows_total: rawRows.length,
      rows_processed: rowsProcessed,
      rows_rejected: rowsRejected,
      periods,
    });
  }
);

export default router;
