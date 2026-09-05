import ExcelJS from 'exceljs';

// Mêmes teintes que listReportPdf.js (navy) pour une identité visuelle cohérente entre le PDF
// et l'Excel d'un même export.
const NAVY_ARGB = 'FF1F3864';
const WHITE_ARGB = 'FFFFFFFF';
const MUTED_ARGB = 'FF94A3B8';
const BORDER_ARGB = 'FFE2E8F0';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };

// Noms d'onglet Excel : 31 caractères max, et \ / ? * [ ] interdits.
function sanitizeSheetName(title) {
  return (title || 'Export').replace(/[\\/?*[\]]/g, '').slice(0, 31) || 'Export';
}

function fillMergedRow(sheet, rowNumber, columnCount, text, style) {
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = text;
  if (columnCount > 1) sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
  for (let c = 1; c <= columnCount; c++) {
    Object.assign(row.getCell(c), style);
  }
  row.commit();
}

// Plafond de largeur de colonne (caractères) : une valeur exceptionnellement longue dans une
// seule cellule ne doit pas rendre toute la colonne (et donc le classeur) disproportionnée —
// la cellule reste consultable au clic, Excel proposant nativement le retour à la ligne/zoom.
const MAX_COLUMN_WIDTH_CHARS = 50;
// Échantillon de lignes utilisé pour estimer la largeur de colonne sans mesurer les 5000 lignes
// possibles (voir routes/reports.js) à chaque génération — même principe que listReportPdf.js.
const WIDTH_SAMPLE_SIZE = 200;

function estimateColumnWidth(col, rows) {
  const sample = rows.slice(0, WIDTH_SAMPLE_SIZE);
  const maxValueLength = sample.reduce((max, row) => {
    const value = row[col.key];
    if (value === null || value === undefined || value === '') return max;
    return Math.max(max, String(value).length);
  }, 0);
  return Math.min(MAX_COLUMN_WIDTH_CHARS, Math.max(12, col.label.length + 4, maxValueLength + 2));
}

// Génère un classeur Excel réel — contrairement au CSV, garde les cellules vides réellement
// vides (pas de "—") : un tableur doit rester filtrable/triable nativement par qui le reçoit.
// columns/rows : même forme que buildListReportPdf (columns: [{key,label}], rows: objets ou
// tableaux positionnels — voir routes/reports.js).
export async function buildListReportXlsx({ tenantName, title, subtitle, generatedBy, columns, rows }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sanitizeSheetName(title));

  // Largeur basée sur le contenu réel (libellé ET valeurs), pas seulement le libellé — une
  // colonne "Titre" avec des valeurs courtes ne doit pas hériter de la même largeur qu'une
  // colonne "Titre" dont les valeurs font 80 caractères.
  sheet.columns = columns.map((col) => ({ key: col.key, width: estimateColumnWidth(col, rows) }));

  fillMergedRow(sheet, 1, columns.length, title, {
    font: { bold: true, size: 14, color: { argb: WHITE_ARGB } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY_ARGB } },
  });
  sheet.getRow(1).height = 22;

  const metaLine = `${tenantName || 'Entreprise'} · Généré par ${generatedBy || 'Utilisateur inconnu'} le ${new Date().toLocaleString('fr-FR')}`;
  fillMergedRow(sheet, 2, columns.length, metaLine, { font: { italic: true, color: { argb: MUTED_ARGB } } });

  let headerRowNumber = 3;
  if (subtitle) {
    fillMergedRow(sheet, 3, columns.length, subtitle, { font: { italic: true, color: { argb: MUTED_ARGB } } });
    headerRowNumber = 4;
  }
  // Ligne vide de séparation avant l'en-tête du tableau.
  headerRowNumber += 1;

  const headerRow = sheet.getRow(headerRowNumber);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY_ARGB } };
    cell.font = { bold: true, color: { argb: WHITE_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  });
  headerRow.commit();

  rows.forEach((row) => {
    const dataRow = sheet.addRow(columns.map((col) => (row[col.key] === undefined || row[col.key] === '' ? null : row[col.key])));
    dataRow.eachCell((cell) => {
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
    });
  });

  // Les en-têtes restent visibles au défilement — ce que le CSV ne peut pas proposer.
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  // Tri/filtre natif Excel sur l'en-tête du tableau — la ligne méta/titre au-dessus reste hors
  // de la plage filtrable, seul le vrai tableau de données l'est.
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + rows.length, column: columns.length },
  };

  return workbook.xlsx.writeBuffer();
}
