import ExcelJS from 'exceljs';

// Certains exports ajoutent une ou plusieurs lignes de titre/préambule avant les vraies
// colonnes (ex : "Tableau 1", date d'export...) — postuler que la ligne 1 est toujours
// l'en-tête casse ces fichiers (une seule colonne détectée, aucune valeur).
const MAX_HEADER_SCAN_LINES = 10;

// Convertit une cellule exceljs en valeur simple : les dates natives Excel sont ramenées à
// yyyy-MM-dd, les formules à leur résultat calculé, le texte enrichi à sa chaîne brute.
export function cellToValue(cell) {
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

// Repère, parmi les premières lignes du classeur, celle qui a le plus de cellules remplies —
// une ligne de titre au-dessus des vraies colonnes n'occupe presque toujours qu'une seule
// cellule, la vraie ligne d'en-têtes en occupe plusieurs.
function findExcelHeaderRowNumber(worksheet) {
  const scanLimit = Math.min(worksheet.rowCount || MAX_HEADER_SCAN_LINES, MAX_HEADER_SCAN_LINES);
  let bestRow = 1;
  let bestCount = -1;
  for (let rowNumber = 1; rowNumber <= scanLimit; rowNumber++) {
    let count = 0;
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, () => {
      count += 1;
    });
    if (count > bestCount) {
      bestCount = count;
      bestRow = rowNumber;
    }
  }
  return bestRow;
}

// Partagé par tous les imports Excel de l'application (KPI, documents...) : détecte la ligne
// d'en-tête, puis renvoie chaque ligne suivante comme un objet { en-tête: valeur }.
export async function parseExcelBuffer(buffer, requestedSheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  if (sheetNames.length === 0) {
    const error = new Error('Le fichier Excel ne contient aucun onglet.');
    error.userFacing = true;
    throw error;
  }

  const worksheet = requestedSheetName ? workbook.getWorksheet(requestedSheetName) : workbook.worksheets[0];
  if (!worksheet) {
    const error = new Error(`Onglet "${requestedSheetName}" introuvable. Onglets disponibles : ${sheetNames.join(', ')}.`);
    error.userFacing = true;
    throw error;
  }

  const headerRowNumber = findExcelHeaderRowNumber(worksheet);

  const headers = [];
  worksheet.getRow(headerRowNumber).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = String(cellToValue(cell) ?? '').trim();
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
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
