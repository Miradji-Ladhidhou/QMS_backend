import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { RECORDS_SELECT } from './kpis.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

function parseCsvBuffer(buffer) {
  const content = buffer.toString('utf8');
  // Les exports Excel FR utilisent souvent le point-virgule : on détecte le séparateur
  // plutôt que d'imposer la virgule.
  const firstLine = content.split('\n')[0] || '';
  const delimiter = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
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

// Tente de convertir une valeur de colonne "période" en date yyyy-MM-dd : ISO tel quel,
// yyyy-MM ramené au 1er du mois, jj/mm/aaaa (format FR courant dans les exports Excel), ou
// tout ce que Date.parse sait lire nativement. Retourne null si rien ne correspond — la
// ligne est alors groupée par sa valeur brute plutôt que rejetée (cf. computeGroup ci-dessous).
function normalizeAnyDate(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{4}-\d{2}$/.test(str)) return `${str}-01`;
  const dmy = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

// Tolère la virgule décimale FR ("12,5") tant qu'il n'y a pas déjà de point.
function toNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  let str = String(raw).trim();
  if (!str) return NaN;
  if (str.includes(',') && !str.includes('.')) str = str.replace(',', '.');
  return Number(str);
}

// Applique la recette de calcul (kpi_calculation_configs) à un groupe de lignes brutes
// (déjà réparties par période). Les 4 premiers types produisent une valeur unique
// destinée à kpi_records ; count_grouped produit une répartition, gardée à part.
function computeGroup(config, rows) {
  const rowsTotal = rows.length;

  switch (config.calc_type) {
    case 'ratio': {
      const matching = rows.filter(({ rowData }) => {
        const value = rowData[config.filter_column];
        return String(value ?? '').trim().toLowerCase() === String(config.filter_value).trim().toLowerCase();
      }).length;
      return {
        value: rowsTotal > 0 ? Number(((matching / rowsTotal) * 100).toFixed(2)) : null,
        rowsValid: rowsTotal,
        rejectedDetails: [],
      };
    }
    case 'sum':
    case 'average': {
      const numbers = [];
      const rejectedDetails = [];
      rows.forEach(({ rowIndex, rowData }) => {
        const num = toNumber(rowData[config.source_column]);
        if (Number.isNaN(num)) {
          rejectedDetails.push({
            row_index: rowIndex,
            reason: `Valeur non numérique dans "${config.source_column}" ("${rowData[config.source_column]}").`,
          });
        } else {
          numbers.push(num);
        }
      });
      const value =
        numbers.length === 0
          ? null
          : config.calc_type === 'sum'
          ? Number(numbers.reduce((a, b) => a + b, 0).toFixed(2))
          : Number((numbers.reduce((a, b) => a + b, 0) / numbers.length).toFixed(2));
      return { value, rowsValid: numbers.length, rejectedDetails };
    }
    case 'count': {
      return { value: rowsTotal, rowsValid: rowsTotal, rejectedDetails: [] };
    }
    case 'count_grouped': {
      const groupedCounts = {};
      rows.forEach(({ rowData }) => {
        const key = String(rowData[config.group_by_column] ?? '').trim() || '(vide)';
        groupedCounts[key] = (groupedCounts[key] || 0) + 1;
      });
      return { groupedCounts, rowsValid: rowsTotal, rejectedDetails: [] };
    }
    default:
      return { value: null, rowsValid: 0, rejectedDetails: [] };
  }
}

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

    // Groupe les lignes par période : par valeur (normalisée en date si possible) de
    // period_column, ou par la période unique fournie manuellement si le fichier ne porte
    // pas lui-même de colonne de date.
    const groups = new Map();
    for (const { row_index: rowIndex, row_data: rowData } of rawRows) {
      let key;
      if (config.period_column) {
        const raw = rowData[config.period_column];
        const normalized = normalizeAnyDate(raw);
        key = normalized || `__raw__:${String(raw ?? '').trim() || '(vide)'}`;
      } else {
        key = manualPeriodDate;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ rowIndex, rowData });
    }

    const periods = [];
    const upsertRows = [];
    let rowsProcessed = 0;
    let rowsRejected = 0;

    for (const [periodKey, groupRows] of groups.entries()) {
      const isRawFallback = periodKey.startsWith('__raw__:');
      const periodDate = isRawFallback ? null : periodKey;
      const periodLabel = isRawFallback ? periodKey.slice('__raw__:'.length) : periodKey;

      const result = computeGroup(config, groupRows);
      rowsProcessed += groupRows.length;
      rowsRejected += result.rejectedDetails?.length || 0;

      if (config.calc_type === 'count_grouped') {
        periods.push({
          period_label: periodLabel,
          period_date: periodDate,
          persisted: false,
          grouped_counts: result.groupedCounts,
          rows_total: groupRows.length,
        });
        continue;
      }

      const persisted = periodDate !== null && result.value !== null;
      periods.push({
        period_label: periodLabel,
        period_date: periodDate,
        persisted,
        value: result.value,
        rows_total: groupRows.length,
        rows_valid: result.rowsValid,
        rows_rejected: result.rejectedDetails.length,
        rejected_details: result.rejectedDetails,
        ...(persisted
          ? {}
          : {
              skip_reason:
                periodDate === null
                  ? "Valeur de période non convertible en date : résultat calculé mais non enregistré dans l'historique."
                  : 'Aucune valeur numérique valide dans ce groupe.',
            }),
      });

      if (persisted) {
        upsertRows.push({
          tenant_id: req.tenantId,
          kpi_id: targetKpiId,
          period_date: periodDate,
          value: result.value,
          source: 'import',
          source_import_id: importRow.id,
          recorded_by: req.user.id,
        });
      }
    }

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

export default router;
