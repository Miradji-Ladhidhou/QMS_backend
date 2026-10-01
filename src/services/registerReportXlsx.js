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
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const [year, month, day] = dateStr.slice(0, 10).split('-');
    return `${day}/${month}/${year}`;
  }
  return dateStr;
}

/**
 * Génère un classeur Excel pour un registre documentaire avec mise en page tableur :
 * - Bandeau vert Excel
 * - Métadonnées du registre (nom, description, entreprise, auteur, date d'export)
 * - Ligne de repère de colonnes (#, A, B, C...)
 * - En-têtes de colonnes dynamiques définies par l'utilisateur
 * - Données avec numérotation de ligne
 * - Lignes figées et filtres automatiques
 */
export async function buildRegisterXlsx({ register, rows, tenantName, exportedBy }) {
  const workbook = new ExcelJS.Workbook();
  const sheetTitle = (register.title || 'Registre').replace(/[\\/?*[\]]/g, '').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetTitle);

  const columns = Array.isArray(register.columns) ? register.columns : [];

  // Définition des colonnes du tableau
  const colsDef = [
    { key: 'line', label: 'Ligne', width: 9, align: 'center' },
    ...columns.map((col) => {
      let width = 20;
      if (col.type === 'date') width = 16;
      else if (col.type === 'number') width = 15;
      else if (col.type === 'select') width = 18;
      else if ((col.name || '').length > 20) width = 30;
      return {
        key: col.id,
        label: col.is_planning ? `${col.name} 📅` : col.name,
        type: col.type,
        width,
        align: col.type === 'number' ? 'right' : col.type === 'date' ? 'center' : 'left',
      };
    }),
  ];

  sheet.columns = colsDef.map((c) => ({ width: c.width }));
  const totalCols = Math.max(1, colsDef.length);

  // Ligne 1 : Titre principal (Bandeau vert Excel)
  const titleRow = sheet.getRow(1);
  titleRow.getCell(1).value = `Tableur Registre — ${register.title}`;
  sheet.mergeCells(1, 1, 1, totalCols);
  titleRow.getCell(1).font = { bold: true, size: 13, color: { argb: WHITE_ARGB } };
  titleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXCEL_GREEN_ARGB } };
  titleRow.getCell(1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  titleRow.height = 26;
  titleRow.commit();

  // Ligne 2 : Métadonnées
  const metaParts = [];
  if (tenantName) metaParts.push(`Entreprise : ${tenantName}`);
  if (register.description) metaParts.push(register.description);
  metaParts.push(`${rows.length} entrée${rows.length > 1 ? 's' : ''}`);
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
  const letterRow = sheet.getRow(3);
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

  // Ligne 4 : En-têtes réels
  const headerRow = sheet.getRow(4);
  colsDef.forEach((col, idx) => {
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

  // Lignes de données
  rows.forEach((rowItem, rowIdx) => {
    const rowNumber = 5 + rowIdx;
    const row = sheet.getRow(rowNumber);
    const isAlt = (rowIdx + 1) % 2 === 0;
    const rowFill = isAlt
      ? { type: 'pattern', pattern: 'solid', fgColor: { argb: ROW_ALT_FILL_ARGB } }
      : { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE_ARGB } };

    // Colonne 1 : numéro de ligne
    const lineCell = row.getCell(1);
    lineCell.value = rowIdx + 1;
    lineCell.alignment = { horizontal: 'center', vertical: 'middle' };
    lineCell.font = { size: 9.5, color: { argb: MUTED_ARGB } };
    lineCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LETTER_ROW_FILL_ARGB } };
    lineCell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

    // Autres colonnes
    columns.forEach((col, colIdx) => {
      const cell = row.getCell(colIdx + 2);
      const rawVal = rowItem.data?.[col.id];

      if (col.type === 'date') {
        cell.value = formatIsoDate(rawVal) || null;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
      } else if (col.type === 'number') {
        const num = rawVal !== '' && rawVal !== null && rawVal !== undefined ? Number(rawVal) : null;
        cell.value = Number.isNaN(num) ? rawVal : num;
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
      } else {
        cell.value = rawVal || null;
        cell.alignment = { horizontal: 'left', vertical: 'middle' };
      }

      cell.font = { size: 9.5, color: { argb: INK_ARGB } };
      cell.fill = rowFill;
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
    });

    row.height = 20;
    row.commit();
  });

  // Figer les lignes d'en-tête (lignes 1 à 4 figées lors du défilement)
  sheet.views = [{ state: 'frozen', ySplit: 4 }];

  // Filtres automatiques sur les colonnes du tableau
  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4 + rows.length, column: totalCols },
    };
  }

  return workbook.xlsx.writeBuffer();
}
