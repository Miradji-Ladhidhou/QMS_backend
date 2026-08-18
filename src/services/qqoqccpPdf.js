import PDFDocument from 'pdfkit';

// Mêmes teintes que kpiReportPdf.js pour une identité visuelle cohérente entre les rapports
// PDF de l'application — dupliquées plutôt qu'importées, ces deux services n'ont pas d'autre
// couplage et n'ont pas besoin d'un module de constantes partagé pour si peu.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';
const INK = '#1e293b';
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

function drawPageHeader(doc, tenantName) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Analyse QQOQCCP', PAGE_MARGIN, 26);
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;
}

// Le PDF est construit en flux libre (doc.text sans y explicite) plutôt qu'en positions
// fixes comme kpiReportPdf.js : les réponses aux 7 questions ont une longueur imprévisible,
// contrairement aux sections KPI de hauteur bornée. pdfkit déclenche 'pageAdded' à chaque
// saut de page automatique (overflow de texte) ou manuel — on l'utilise pour redessiner le
// bandeau d'en-tête sur toutes les pages sans avoir à estimer l'espace restant nous-mêmes.
export function buildQqoqccpPdf({ tenantName, analysis }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName));

    drawPageHeader(doc, tenantName);

    doc.fontSize(15).fillColor(NAVY).text(analysis.title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
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
      doc.fontSize(11).fillColor(NAVY).text(label, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
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
        .strokeColor(GRID)
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.8);

      doc.fontSize(12).fillColor(PURPLE).text('Synthèse générée par IA', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.3);
      doc.fontSize(10).fillColor(INK).text(analysis.ai_synthesis, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.7);

      if (rootCauses.length > 0) {
        doc.fontSize(10).fillColor(NAVY).text('Causes racines probables', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.moveDown(0.2);
        rootCauses.forEach((cause) => {
          doc.fontSize(9).fillColor(INK).text(`•  ${cause}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
          doc.moveDown(0.15);
        });
        doc.moveDown(0.5);
      }

      if (suggestedActions.length > 0) {
        doc.fontSize(10).fillColor(NAVY).text('Actions suggérées', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
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

    doc.end();
  });
}
