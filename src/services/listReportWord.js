import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  PageNumber,
  WidthType,
  ShadingType,
  VerticalAlign,
} from 'docx';

// Même teinte que listReportPdf.js/listReportXlsx.js (navy) pour une identité visuelle cohérente
// entre les 3 formats d'un même export — dupliquée plutôt qu'importée, même convention que le
// reste des services de rapport (voir la note en tête de listReportPdf.js).
const NAVY = '1F3864';
const MUTED = '888888';
const BORDER = 'D9D9D9';

const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

function titleRow(title, columnCount) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            columnSpan: columnCount,
            shading: { type: ShadingType.CLEAR, fill: NAVY },
            margins: { top: 120, bottom: 120, left: 100, right: 100 },
            children: [new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 28, color: 'FFFFFF' })] })],
          }),
        ],
      }),
    ],
  });
}

function metaParagraph(tenantName, generatedBy) {
  const line = `${tenantName || 'Entreprise'} · Généré par ${generatedBy || 'Utilisateur inconnu'} le ${new Date().toLocaleString('fr-FR')}`;
  return new Paragraph({ spacing: { before: 120, after: 60 }, children: [new TextRun({ text: line, italics: true, color: MUTED, size: 18 })] });
}

function dataCellText(text, { header } = {}) {
  return new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: NAVY } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: CELL_BORDERS,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ children: [new TextRun({ text, bold: !!header, color: header ? 'FFFFFF' : undefined, size: 18 })] })],
  });
}

function cellDisplayValue(row, key) {
  const value = row[key];
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function dataTable(columns, rows) {
  const headerRow = new TableRow({ children: columns.map((col) => dataCellText(col.label, { header: true })) });
  const bodyRows = rows.map(
    (row) => new TableRow({ children: columns.map((col) => dataCellText(cellDisplayValue(row, col.key))) })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
}

// Générateur Word générique pour toutes les pages "liste" de l'application — même principe
// d'entrée (columns/rows déjà formatées côté appelant) que buildListReportPdf/
// buildListReportXlsx, voir routes/reports.js. Volontairement beaucoup plus simple que
// procedureWord.js (pas de système de thèmes : ici une seule identité visuelle, cohérente avec
// le PDF/Excel du même export) — et contrairement au PDF, une cellule Word s'ajuste en hauteur
// nativement, pas besoin de logique de troncature/plafond.
export async function buildListReportWord({ tenantName, title, subtitle, generatedBy, columns, rows }) {
  const body = [titleRow(title, columns.length), metaParagraph(tenantName, generatedBy)];

  if (subtitle) {
    body.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: subtitle, italics: true, color: MUTED, size: 18 })] }));
  }

  if (rows.length === 0) {
    body.push(new Paragraph({ children: [new TextRun({ text: 'Aucun enregistrement à afficher.', color: MUTED })] }));
  } else {
    body.push(dataTable(columns, rows));
  }

  const doc = new Document({
    sections: [
      {
        headers: {
          default: new Header({
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: title, size: 16, color: MUTED })] })],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: 'Page ', size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
                  new TextRun({ text: ' / ', size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
