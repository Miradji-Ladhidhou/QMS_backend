// Point-virgule comme séparateur et BOM UTF-8 : Excel FR (locale par défaut) n'interprète
// correctement les colonnes qu'avec ce séparateur, et le BOM évite les accents corrompus — port
// direct de la logique déjà éprouvée côté client (frontend/src/lib/csvExport.js), adaptée à la
// même forme columns/rows (objets) que buildListReportPdf/buildListReportXlsx plutôt que
// headers/lignes positionnelles, pour que chaque page appelante n'ait plus qu'une seule
// construction de données à faire pour les 4 formats (voir routes/reports.js).
function escapeCsvCell(value) {
  const str = value === null || value === undefined || value === '' ? '' : String(value);
  return /[";\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const BOM = '﻿';

export function buildListReportCsv({ tenantName, title, subtitle, generatedBy, columns, rows }) {
  const metaLines = title
    ? [
        [title],
        [`${tenantName || 'Entreprise'} · Généré par ${generatedBy || 'Utilisateur inconnu'} le ${new Date().toLocaleString('fr-FR')}`],
        ...(subtitle ? [[subtitle]] : []),
        [],
      ]
    : [];

  const headerLine = columns.map((col) => col.label);
  const dataLines = rows.map((row) => columns.map((col) => row[col.key]));

  const lines = [...metaLines, headerLine, ...dataLines].map((line) => line.map(escapeCsvCell).join(';'));
  return BOM + lines.join('\r\n');
}
