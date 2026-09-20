import { INK, RULE_LIGHT, HEADER_FILL } from './pdfTheme.js';

// Éléments de mise en page communs aux PDF « fiche » en A4 (marges de 50 pt) : saut de page avant un bloc
// et tableau simple. Utilisés par trainingQuizPdf.js et riskPdf.js.
export const PAGE_MARGIN = 50;
export const PAGE_WIDTH = 595.28; // A4
export const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BOTTOM_LIMIT = 60; // au-dessus du pied de page
const CELL_PADDING = 5;

export function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - BOTTOM_LIMIT) doc.addPage();
}

// Tableau simple : colonnes { width (part de CONTENT_WIDTH), align }, lignes de cellules { text, bold, color }.
// Hauteur de ligne calculée depuis le texte réel ; une ligne n'est jamais coupée entre deux pages.
export function drawTable(doc, columns, header, rows) {
  const widths = columns.map((column) => CONTENT_WIDTH * column.width);

  function rowHeight(cells) {
    return (
      Math.max(
        ...cells.map((cell, i) => {
          doc.font(cell.bold ? 'Body-Bold' : 'Body').fontSize(9);
          return doc.heightOfString(cell.text || ' ', { width: widths[i] - CELL_PADDING * 2 });
        })
      ) +
      CELL_PADDING * 2
    );
  }

  function drawRow(cells, { fill } = {}) {
    const height = rowHeight(cells);
    ensureSpace(doc, height);
    const y = doc.y;
    let x = PAGE_MARGIN;
    if (fill) doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, height).fill(fill);
    cells.forEach((cell, i) => {
      doc
        .font(cell.bold ? 'Body-Bold' : 'Body')
        .fontSize(9)
        .fillColor(cell.color || INK)
        .text(cell.text || '', x + CELL_PADDING, y + CELL_PADDING, { width: widths[i] - CELL_PADDING * 2, align: columns[i].align || 'left' });
      x += widths[i];
    });
    doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y + height).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.y = y + height;
    doc.x = PAGE_MARGIN;
  }

  drawRow(header.map((text) => ({ text, bold: true })), { fill: HEADER_FILL });
  rows.forEach((cells) => drawRow(cells));
  doc.font('Body');
}
