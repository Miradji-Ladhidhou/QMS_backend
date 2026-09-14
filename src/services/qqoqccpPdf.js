import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';

// PURPLE reste la couleur sémantique "contenu généré par IA" (même convention que le badge
// violet côté frontend, ex. AiRiskSuggestion.jsx) — pas une couleur de marque, volontairement
// non touchée par le passage à l'en-tête neutre ci-dessous.
const PURPLE = '#7c3aed';
const PURPLE_LIGHT = '#f5f3ff';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const STATUS_LABELS = { draft: 'Brouillon', ai_generated: 'Généré par IA', validated: 'Validée' };

const QUESTIONS = [
  { key: 'qui', label: 'Qui ?' },
  { key: 'quoi', label: 'Quoi ?' },
  { key: 'ou_', label: 'Où ?' },
  { key: 'quand_', label: 'Quand ?' },
  { key: 'comment_', label: 'Comment ?' },
  { key: 'combien', label: 'Combien ?' },
  { key: 'pourquoi', label: 'Pourquoi ?' },
];

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// Le PDF est construit en flux libre (doc.text sans y explicite) plutôt qu'en positions
// fixes comme kpiReportPdf.js : les réponses aux 7 questions ont une longueur imprévisible,
// contrairement aux sections KPI de hauteur bornée. pdfkit déclenche 'pageAdded' à chaque
// saut de page automatique (overflow de texte) ou manuel — on l'utilise pour redessiner le
// bandeau d'en-tête sur toutes les pages sans avoir à estimer l'espace restant nous-mêmes.
export function buildQqoqccpPdf({ tenantName, tenantLogo, analysis }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: 'Analyse QQOQCCP' };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));

    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(15).fillColor(INK).text(analysis.title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.2);
    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Statut : ${STATUS_LABELS[analysis.status] || analysis.status}    —    Créée le ${formatDateTime(analysis.created_at)}`,
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );
    doc.moveDown(1);

    QUESTIONS.forEach(({ key, label }) => {
      doc.font('Body-Bold').fontSize(11).fillColor(INK).text(label, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.font('Body');
      doc.moveDown(0.15);
      const answer = analysis[key];
      if (answer) {
        doc.fontSize(10).fillColor(INK).text(answer, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      } else {
        doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.7);
    });

    const suggestedActions = analysis.ai_suggested_actions?.suggested_actions || [];
    const rootCauses = analysis.ai_suggested_actions?.root_causes || [];

    if (analysis.ai_synthesis) {
      doc
        .moveTo(PAGE_MARGIN, doc.y)
        .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
        .strokeColor(RULE_LIGHT)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.8);

      doc.fontSize(12).fillColor(PURPLE).text('Synthèse générée par IA', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(INK).text(analysis.ai_synthesis, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.7);

      if (rootCauses.length > 0) {
        doc.font('Body-Bold').fontSize(10).fillColor(INK).text('Causes racines probables', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.font('Body');
        doc.moveDown(0.2);
        rootCauses.forEach((cause) => {
          doc.fontSize(9).fillColor(INK).text(`•  ${cause}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
          doc.moveDown(0.15);
        });
        doc.moveDown(0.5);
      }

      if (suggestedActions.length > 0) {
        doc.font('Body-Bold').fontSize(10).fillColor(INK).text('Actions suggérées', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.font('Body');
        doc.moveDown(0.3);
        suggestedActions.forEach((action) => {
          const boxTop = doc.y;
          doc.fontSize(9.5).fillColor(INK).text(action.title, PAGE_MARGIN + 8, boxTop, { width: CONTENT_WIDTH - 16 });
          if (action.description) {
            doc.moveDown(0.1);
            doc.fontSize(8.5).fillColor(MUTED).text(action.description, PAGE_MARGIN + 8, doc.y, { width: CONTENT_WIDTH - 16 });
          }
          doc.moveDown(0.4);
        });
      }
    }

    if (analysis.capa) {
      doc.moveDown(0.3);
      const boxTop = doc.y;
      doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, 24).fill(PURPLE_LIGHT);
      doc
        .fontSize(9)
        .fillColor(PURPLE)
        .text(`CAPA liée : ${analysis.capa.number} — ${analysis.capa.title}`, PAGE_MARGIN + 8, boxTop + 7, {
          width: CONTENT_WIDTH - 16,
        });
      doc.y = boxTop + 24 + 8;
    }

    // Pied de page numéroté — voir listReportPdf.js pour la même construction.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
