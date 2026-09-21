import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, HEADER_FILL, drawLetterheadHeader } from './pdfTheme.js';

const PAGE_MARGIN = 36;
const PAGE_WIDTH = 841.89; // A4 paysage
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 22;

// Colonnes (part de CONTENT_WIDTH) : la ligne est remplie à la main, sur le terrain.
const COLUMNS = [
  { label: 'Date', width: 0.1 },
  { label: 'Heure', width: 0.08 },
  { label: 'Valeur relevée', width: 0.15 },
  { label: 'Conforme', width: 0.12 },
  { label: 'Action corrective (si hors limites)', width: 0.35 },
  { label: 'Visa', width: 0.2 },
];

// Fiche de relevés vierge à imprimer et remplir à la main, pour un point critique : en-tête (plan, CCP, limites,
// fréquence, responsable) puis un tableau de lignes vides. Toute dérive doit ensuite être reportée dans l'application.
export function buildHaccpRecordSheetPdf({ ccp, tenantName, tenantLogo, rows = 22 }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', layout: 'landscape', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const label = ccp.ccp_number ? `CCP ${ccp.ccp_number}` : 'Point critique';
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `Fiche de relevés — ${label}` };
    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(13).fillColor(INK).text(`${ccp.plan.title} — ${label}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body').fontSize(9).fillColor(INK).text(ccp.hazard_description, PAGE_MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
    doc.moveDown(0.4);

    const facts = [
      ['Limites critiques', ccp.limits_text ? `${ccp.critical_limits} (${ccp.limits_text})` : ccp.critical_limits],
      ['Fréquence', ccp.monitoring_frequency || '—'],
      ['Responsable', ccp.monitoring_responsible_user?.full_name || '—'],
    ];
    const colWidth = CONTENT_WIDTH / facts.length;
    const factsTop = doc.y;
    let factsBottom = factsTop;
    facts.forEach(([factLabel, value], i) => {
      const x = PAGE_MARGIN + i * colWidth;
      doc.fontSize(7).fillColor(MUTED).text(factLabel.toUpperCase(), x, factsTop, { width: colWidth - 10 });
      doc.fontSize(9).fillColor(INK).text(value, x, factsTop + 10, { width: colWidth - 10 });
      factsBottom = Math.max(factsBottom, doc.y);
    });
    doc.y = factsBottom + 8;
    doc.fontSize(8).fillColor(MUTED).text('Période : du ____ / ____ / ________  au ____ / ____ / ________        Ligne / équipement : ______________________', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.y += 14;

    const widths = COLUMNS.map((column) => column.width * CONTENT_WIDTH);
    let sheetY = doc.y;

    function drawHeader(y) {
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, HEADER_HEIGHT).fill(HEADER_FILL);
      let x = PAGE_MARGIN;
      doc.font('Body-Bold').fontSize(8).fillColor(INK);
      COLUMNS.forEach((column, i) => {
        doc.text(column.label, x + 4, y + 7, { width: widths[i] - 8 });
        x += widths[i];
      });
      doc.font('Body');
      return y + HEADER_HEIGHT;
    }

    let y = drawHeader(sheetY);
    const bottomLimit = doc.page.height - 44;
    for (let i = 0; i < rows; i += 1) {
      if (y + ROW_HEIGHT > bottomLimit) break;
      doc.moveTo(PAGE_MARGIN, y + ROW_HEIGHT).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y + ROW_HEIGHT).strokeColor(RULE_LIGHT).lineWidth(0.6).stroke();
      // Cases à cocher de la colonne « Conforme ».
      const checkX = PAGE_MARGIN + widths.slice(0, 3).reduce((sum, w) => sum + w, 0) + 10;
      doc.rect(checkX, y + 8, 8, 8).strokeColor(MUTED).lineWidth(0.6).stroke();
      doc.fontSize(8).fillColor(INK).text('Oui', checkX + 12, y + 8, { lineBreak: false });
      doc.rect(checkX + 40, y + 8, 8, 8).strokeColor(MUTED).lineWidth(0.6).stroke();
      doc.text('Non', checkX + 52, y + 8, { lineBreak: false });
      y += ROW_HEIGHT;
    }
    // Filets verticaux.
    let x = PAGE_MARGIN;
    const top = sheetY;
    [...widths, 0].forEach((w) => {
      doc.moveTo(x, top).lineTo(x, y).strokeColor(RULE_LIGHT).lineWidth(0.6).stroke();
      x += w;
    });
    doc.moveTo(PAGE_MARGIN + CONTENT_WIDTH, top).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).strokeColor(RULE_LIGHT).lineWidth(0.6).stroke();

    doc.fontSize(7.5).fillColor(MUTED).text('Toute valeur hors limites : appliquer l’action corrective, la noter ci-dessus et la reporter dans l’application (Relevés du jour).', PAGE_MARGIN, y + 8, { width: CONTENT_WIDTH });
    doc.end();
  });
}
