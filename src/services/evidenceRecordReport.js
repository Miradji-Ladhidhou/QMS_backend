import PDFDocument from 'pdfkit';
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  PageNumber,
  Paragraph,
  Packer,
  TextRun,
} from 'docx';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, drawLetterheadHeader } from './pdfTheme.js';
import { appendEvidenceToPdf, evidenceWordBlocks } from './evidenceExport.js';
import { logoImageRun } from './wordLogo.js';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

export function buildEvidenceRecordPdf({ tenantName, tenantLogo, title, facts, sections, evidence }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(16).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body').moveDown(0.8);
    facts.forEach(({ label, value }) => {
      doc.fontSize(8).fillColor(MUTED).text(label.toUpperCase(), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.fontSize(10).fillColor(INK).text(value || '—', PAGE_MARGIN, doc.y + 2, { width: CONTENT_WIDTH });
      doc.moveDown(0.45);
    });
    sections.forEach(({ title: sectionTitle, content }) => {
      if (doc.y > doc.page.height - 100) doc.addPage();
      doc.font('Body-Bold').fontSize(11).fillColor(INK).text(sectionTitle, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.font('Body').fontSize(10).fillColor(content ? INK : MUTED).text(content || 'Non renseigné', PAGE_MARGIN, doc.y + 3, { width: CONTENT_WIDTH });
      doc.moveDown(0.8);
    });
    appendEvidenceToPdf(doc, evidence, { marginX: PAGE_MARGIN, contentWidth: CONTENT_WIDTH });

    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      doc.switchToPage(index);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${index + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}

export async function buildEvidenceRecordWord({ tenantName, tenantLogo, title, facts, sections, evidence, generatedBy }) {
  const logo = logoImageRun(tenantLogo);
  const headerText = `${tenantName || 'Entreprise'} — ${title}`;
  const header = new Paragraph({
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: headerText, size: 16, color: MUTED })],
  });
  const body = [
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: title, bold: true, size: 32, color: INK })] }),
    ...facts.flatMap(({ label, value }) => [
      new Paragraph({ spacing: { before: 100, after: 30 }, children: [new TextRun({ text: label, bold: true, size: 20, color: MUTED })] }),
      new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: value || '—', size: 20, color: INK })] }),
    ]),
    ...sections.flatMap(({ title: sectionTitle, content }) => [
      new Paragraph({ spacing: { before: 260, after: 60 }, keepNext: true, children: [new TextRun({ text: sectionTitle, bold: true, size: 24, color: INK })] }),
      new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: content || 'Non renseigné', size: 20, color: content ? INK : MUTED })] }),
    ]),
    ...evidenceWordBlocks(evidence),
    new Paragraph({
      spacing: { before: 320 },
      children: [new TextRun({ text: `Document généré par ${generatedBy || 'Utilisateur inconnu'} le ${new Date().toLocaleString('fr-FR')}`, italics: true, size: 16, color: MUTED })],
    }),
  ];

  return Packer.toBuffer(new Document({
    sections: [{
      headers: { default: new Header({ children: [logo ? new Paragraph({ children: [logo, new TextRun({ text: `  ${headerText}`, size: 16, color: MUTED })] }) : header] }) },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 16, color: MUTED }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
              new TextRun({ text: ' / ', size: 16, color: MUTED }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
            ],
          })],
        }),
      },
      children: body,
    }],
  }));
}
