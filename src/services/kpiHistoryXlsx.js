import ExcelJS from 'exceljs';

const INK_ARGB = 'FF1E293B';
const MUTED_ARGB = 'FF64748B';
const EXCEL_GREEN_ARGB = 'FF107C41';
const WHITE_ARGB = 'FFFFFFFF';
const SUBHEADER_FILL_ARGB = 'FFF1F5F9';
const LETTER_ROW_FILL_ARGB = 'FFE2E8F0';
const ROW_ALT_FILL_ARGB = 'FFF8FAFC';
const BORDER_ARGB = 'FFCBD5E1';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };

function formatIsoDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

const SOURCE_LABELS = {
  manual: 'Saisie manuelle',
  import: 'Import Excel',
  module: 'Calcul automatique',
};

const FREQUENCY_LABELS = {
  daily: 'Quotidien',
  weekly: 'Hebdomadaire',
  monthly: 'Mensuel',
  quarterly: 'Trimestriel',
  yearly: 'Annuel',
};

/**
 * Génère un classeur Excel respectant exactement la présentation du « Tableur historique »
 * affiché à l'écran :
 * - Bandeau titre Excel vert
 * - Métadonnées du KPI (organisation, cible, fréquence, date d'export)
 * - Ligne de repères de colonnes (#, A, B, C...)
 * - En-têtes de colonnes répliquant exactement la table web
 * - Colonne Ligne numérotée (1, 2, 3...)
 * - Données formatées (dates JJ/MM/AAAA, valeurs avec unité, source, commentaire, saisie par)
 * - Support mono-série et multi-séries (matrice par période)
 * - En-têtes figés et filtres automatiques natifs Excel
 * - Insertion du graphique d'évolution à côté du tableau si une image est fournie
 */
export async function buildKpiHistoryXlsx({ kpi, records, tenantName, exportedBy, chartImage }) {
  const workbook = new ExcelJS.Workbook();
  const sheetTitle = (kpi.name || 'Historique').replace(/[\\/?*[\]]/g, '').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetTitle);

  const seriesConfigs = kpi.calculation_configs || [];
  const showSeriesColumn = seriesConfigs.length > 1;
  const isImportBased = kpi.calculation_type === 'import';
  const labelByConfigId = Object.fromEntries(seriesConfigs.map((c) => [c.id, c.label]));

  // Récupération de l'unité
  const defaultUnit = kpi.unit || '';

  // Définition des colonnes selon mono-série vs multi-séries
  let columnsDef = [];
  if (showSeriesColumn) {
    columnsDef = [
      { key: 'line', label: 'Ligne', width: 9, align: 'center' },
      { key: 'period_date', label: 'Période', width: 14, align: 'center' },
    ];
    seriesConfigs.forEach((series) => {
      const unit = series.unit || defaultUnit;
      columnsDef.push({
        key: `val_${series.id}`,
        label: `${series.label}${unit ? ` (${unit})` : ''}`,
        width: 18,
        align: 'right',
      });
      columnsDef.push({
        key: `com_${series.id}`,
        label: `Commentaire ${series.label}`,
        width: 25,
        align: 'left',
      });
    });
  } else {
    columnsDef = [
      { key: 'line', label: 'Ligne', width: 9, align: 'center' },
      { key: 'period_date', label: 'Période', width: 14, align: 'center' },
      { key: 'value', label: `Valeur${defaultUnit ? ` (${defaultUnit})` : ''}`, width: 16, align: 'right' },
    ];
    if (isImportBased) {
      columnsDef.push({ key: 'source', label: 'Source', width: 18, align: 'left' });
    }
    columnsDef.push(
      { key: 'comment', label: 'Commentaire', width: 35, align: 'left' },
      { key: 'recorded_by', label: 'Saisi par', width: 22, align: 'left' }
    );
  }

  sheet.columns = columnsDef.map((c) => ({ width: c.width }));
  const totalCols = columnsDef.length;

  // Ligne 1 : Titre principal (Bandeau vert Excel)
  const titleRow = sheet.getRow(1);
  titleRow.getCell(1).value = `Tableur historique — ${kpi.name}`;
  sheet.mergeCells(1, 1, 1, totalCols);
  titleRow.getCell(1).font = { bold: true, size: 13, color: { argb: WHITE_ARGB } };
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_GREEN_ARGB } };
  titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleRow.height = 26;
  titleRow.commit();

  // Ligne 2 : Métadonnées
  const metaParts = [];
  if (tenantName) metaParts.push(`Entreprise : ${tenantName}`);
  if (kpi.target !== null && kpi.target !== undefined) {
    const dir = kpi.target_direction === 'max' ? '≤' : '≥';
    metaParts.push(`Objectif : ${dir} ${kpi.target} ${defaultUnit}`.trim());
  }
  if (kpi.frequency) metaParts.push(`Fréquence : ${FREQUENCY_LABELS[kpi.frequency] || kpi.frequency}`);
  metaParts.push(`${records.length} relevé${records.length > 1 ? 's' : ''}`);
  metaParts.push(`Exporté le ${new Date().toLocaleDateString('fr-FR')} par ${exportedBy || 'Utilisateur'}`);

  const metaRow = sheet.getRow(2);
  metaRow.getCell(1).value = metaParts.join('   |   ');
  sheet.mergeCells(2, 1, 2, totalCols);
  metaRow.getCell(1).font = { italic: true, size: 9.5, color: { argb: MUTED_ARGB } };
  metaRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } };
  metaRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  metaRow.height = 18;
  metaRow.commit();

  // Ligne 3 : Repère alphabétique Excel (#, A, B, C...)
  const letterRowNumber = 3;
  const letterRow = sheet.getRow(letterRowNumber);
  letterRow.getCell(1).value = '#';
  letterRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  letterRow.getCell(1).font = { size: 9, bold: true, color: { argb: MUTED_ARGB } };
  letterRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
  letterRow.getCell(1).border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

  for (let c = 2; c <= totalCols; c += 1) {
    const cell = letterRow.getCell(c);
    cell.value = String.fromCharCode(65 + c - 2);
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.font = { size: 9, bold: true, color: { argb: MUTED_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  }
  letterRow.height = 16;
  letterRow.commit();

  // Ligne 4 : En-têtes de colonnes réels
  const headerRowNumber = 4;
  const headerRow = sheet.getRow(headerRowNumber);
  columnsDef.forEach((col, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = col.label;
    cell.alignment = {
      horizontal: col.align === 'right' ? 'right' : col.align === 'center' ? 'center' : 'left',
      vertical: 'middle',
    };
    cell.font = { bold: true, size: 10, color: { argb: INK_ARGB } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  });
  headerRow.height = 22;
  headerRow.commit();

  // Lignes de données — triées par period_date desc (comme dans le tableau web)
  const sortedRecords = [...records].sort((a, b) => (a.period_date < b.period_date ? 1 : -1));

  let currentRowNumber = 5;

  if (showSeriesColumn) {
    // Regroupement par période pour le cas multi-séries
    const recordsByPeriod = new Map();
    sortedRecords.forEach((record) => {
      if (!recordsByPeriod.has(record.period_date)) recordsByPeriod.set(record.period_date, []);
      recordsByPeriod.get(record.period_date).push(record);
    });

    let rowIdx = 1;
    recordsByPeriod.forEach((periodRecords, period) => {
      const row = sheet.getRow(currentRowNumber);
      const isAlt = rowIdx % 2 === 0;
      const rowFill = isAlt
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE_ARGB } };

      // Colonne Ligne
      const lineCell = row.getCell(1);
      lineCell.value = rowIdx;
      lineCell.alignment = { horizontal: 'center', vertical: 'middle' };
      lineCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      lineCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
      lineCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Période
      const periodCell = row.getCell(2);
      periodCell.value = formatIsoDate(period);
      periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
      periodCell.font = { size: 10, color: { argb: INK_ARGB } };
      periodCell.fill = rowFill;
      periodCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonnes de chaque série
      let colIdx = 3;
      seriesConfigs.forEach((series) => {
        const item = periodRecords.find((r) => r.config_id === series.id);
        const valCell = row.getCell(colIdx);
        valCell.value = item ? item.value : null;
        valCell.alignment = { horizontal: 'right', vertical: 'middle' };
        valCell.font = { size: 10, bold: true, color: { argb: INK_ARGB } };
        valCell.fill = rowFill;
        valCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
        if (typeof item?.value === 'number') valCell.numFmt = '#,##0.00';

        const comCell = row.getCell(colIdx + 1);
        comCell.value = item?.comment || null;
        comCell.alignment = { horizontal: 'left', vertical: 'middle' };
        comCell.font = { size: 9.5, color: { argb: INK_ARGB } };
        comCell.fill = rowFill;
        comCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

        colIdx += 2;
      });

      row.height = 20;
      row.commit();
      currentRowNumber += 1;
      rowIdx += 1;
    });
  } else {
    sortedRecords.forEach((record, index) => {
      const row = sheet.getRow(currentRowNumber);
      const isAlt = (index + 1) % 2 === 0;
      const rowFill = isAlt
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE_ARGB } };

      // Colonne Ligne (#)
      const lineCell = row.getCell(1);
      lineCell.value = index + 1;
      lineCell.alignment = { horizontal: 'center', vertical: 'middle' };
      lineCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      lineCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
      lineCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Période
      const periodCell = row.getCell(2);
      periodCell.value = formatIsoDate(record.period_date);
      periodCell.alignment = { horizontal: 'center', vertical: 'middle' };
      periodCell.font = { size: 10, color: { argb: INK_ARGB } };
      periodCell.fill = rowFill;
      periodCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      // Colonne Valeur
      const valCell = row.getCell(3);
      valCell.value = record.value;
      valCell.alignment = { horizontal: 'right', vertical: 'middle' };
      valCell.font = { size: 10, bold: true, color: { argb: INK_ARGB } };
      valCell.fill = rowFill;
      valCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      if (typeof record.value === 'number') valCell.numFmt = '#,##0.00';

      let currentColIdx = 4;
      if (isImportBased) {
        const sourceCell = row.getCell(currentColIdx);
        sourceCell.value = SOURCE_LABELS[record.source] || record.source || '';
        sourceCell.alignment = { horizontal: 'left', vertical: 'middle' };
        sourceCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
        sourceCell.fill = rowFill;
        sourceCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
        currentColIdx += 1;
      }

      // Commentaire
      const commentCell = row.getCell(currentColIdx);
      commentCell.value = record.comment || null;
      commentCell.alignment = { horizontal: 'left', vertical: 'middle' };
      commentCell.font = { size: 9.5, color: { argb: INK_ARGB } };
      commentCell.fill = rowFill;
      commentCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      currentColIdx += 1;

      // Saisi par
      const recordedByCell = row.getCell(currentColIdx);
      recordedByCell.value = record.recorded_by_user?.full_name || null;
      recordedByCell.alignment = { horizontal: 'left', vertical: 'middle' };
      recordedByCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
      recordedByCell.fill = rowFill;
      recordedByCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

      row.height = 20;
      row.commit();
      currentRowNumber += 1;
    });
  }

  // Figer les lignes d'en-tête (lignes 1 à 4 figées lors du défilement)
  sheet.views = [{ state: 'frozen', ySplit: 4 }];

  // Filtres automatiques sur les colonnes du tableau
  if (currentRowNumber > 5) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: currentRowNumber - 1, column: totalCols },
    };
  }

  // Insertion du graphique à côté du tableau
  if (chartImage) {
    let imageBase64 = null;
    if (typeof chartImage === 'string' && chartImage.includes('base64,')) {
      imageBase64 = chartImage.split('base64,')[1];
    } else if (typeof chartImage === 'string' && chartImage.length > 50) {
      imageBase64 = chartImage;
    }

    if (imageBase64) {
      try {
        const imageId = workbook.addImage({
          base64: imageBase64,
          extension: 'png',
        });

        // Colonne de séparation (vide)
        const spacerCol = totalCols + 1;
        sheet.getColumn(spacerCol).width = 4;

        // Position de départ du graphique (1-indexed pour getCell, 0-indexed pour tl)
        const chartStartCol1 = totalCols + 2;
        const chartStartCol0 = totalCols + 1;

        // En-tête au-dessus du graphique
        const chartHeaderCell = sheet.getRow(3).getCell(chartStartCol1);
        chartHeaderCell.value = 'Graphique d’évolution';
        chartHeaderCell.font = { bold: true, size: 10, color: { argb: INK_ARGB } };
        chartHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL_ARGB } };
        chartHeaderCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

        // Position de l'image (0-indexed) : tl = { col: chartStartCol0, row: 3 }
        // démarre à la ligne 4 (juste sous le titre du graphique, en face des en-têtes et données)
        sheet.addImage(imageId, {
          tl: { col: chartStartCol0, row: 3 },
          ext: { width: 580, height: 300 },
        });
      } catch (imgError) {
        console.warn("Impossible d'insérer le graphique dans l'export Excel:", imgError.message);
      }
    }
  }

  return workbook.xlsx.writeBuffer();
}
