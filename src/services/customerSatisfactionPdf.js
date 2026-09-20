import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';

const AMBER = '#b45309';
const AMBER_LIGHT = '#fffbeb';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Mêmes libellés que frontend/src/lib/customerSatisfactionStatus.js — dupliqués comme partout
// ailleurs dans cette convention (chaque générateur PDF porte ses propres libellés).
const METHOD_LABELS = { questionnaire: 'Questionnaire', phone: 'Appel téléphonique', email: 'E-mail', in_person: 'En personne', other: 'Autre' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

// Même esprit que drawImportantBox de capaPdf.js/complaintPdf.js — réservé à une information
// déjà affichée à l'écran (score bas), jamais un contenu inventé.
function drawImportantBox(doc, { color, background, label, text }) {
  doc.moveDown(0.3);
  const boxTop = doc.y;
  const height = doc.heightOfString(text, { width: CONTENT_WIDTH - 16 }) + 30;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).fill(background);
  doc.fontSize(9).fillColor(color).text(label, PAGE_MARGIN + 8, boxTop + 8, { width: CONTENT_WIDTH - 16 });
  doc.fontSize(9).fillColor(INK).text(text, PAGE_MARGIN + 8, doc.y + 2, { width: CONTENT_WIDTH - 16 });
  doc.y = boxTop + height + 10;
}

function drawSection(doc, number, title, body) {
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text(`${number}. ${title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.2);
  if (body) {
    doc.fontSize(10).fillColor(INK).text(body, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  } else {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.7);
}

// Deux colonnes de paires libellé/valeur — même densité d'information que le bloc résumé
// affiché sur CustomerSatisfactionDetail.jsx (voir capaPdf.js#drawFactsGrid, identique).
function drawFactsGrid(doc, facts) {
  const colWidth = CONTENT_WIDTH / 2;
  const startY = doc.y;
  let maxY = startY;

  facts.forEach((fact, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = PAGE_MARGIN + col * colWidth;
    const y = startY + row * 34;

    doc.fontSize(8).fillColor(MUTED).text(fact.label.toUpperCase(), x, y, { width: colWidth - 12 });
    doc.fontSize(10).fillColor(INK).text(fact.value || '—', x, y + 11, { width: colWidth - 12 });
    maxY = Math.max(maxY, y + 30);
  });

  doc.y = maxY + 10;
}

// survey : ligne customer_satisfaction_surveys jointe (service/category/linked_capa résolus,
// voir routes/customerSatisfaction.js#SURVEY_SELECT).
export function buildCustomerSatisfactionPdf({ tenantName, tenantLogo, survey }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = {
      pageWidth: PAGE_WIDTH,
      marginX: PAGE_MARGIN,
      tenantName,
      tenantLogo,
      title: `Enquête de satisfaction — ${survey.customer_name}`,
    };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));

    drawLetterheadHeader(doc, headerArgs);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Méthode : ${METHOD_LABELS[survey.method] || survey.method}    —    Note : ${survey.score}/5`, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
      });
    doc.moveDown(0.8);

    if (survey.score <= 2) {
      drawImportantBox(doc, {
        color: AMBER,
        background: AMBER_LIGHT,
        label: 'IMPORTANT — Note basse',
        text: `Ce client a attribué une note de ${survey.score}/5 — envisager une action corrective si ce n'est pas déjà fait.`,
      });
    }

    doc.moveDown(0.5);
    drawFactsGrid(doc, [
      { label: 'Date de l’enquête', value: formatDate(survey.survey_date) },
      { label: 'Méthode', value: METHOD_LABELS[survey.method] || survey.method },
      { label: 'Note', value: `${survey.score}/5` },
      { label: 'Service concerné', value: survey.service?.name },
      { label: 'Catégorie', value: survey.category?.name },
      { label: 'CAPA liée', value: survey.linked_capa ? `${survey.linked_capa.number} — ${survey.linked_capa.title}` : null },
    ]);

    doc.moveDown(0.3);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    drawSection(doc, 1, 'Commentaires', survey.comments);

    // Pied de page numéroté — même construction que capaPdf.js/pdcaPdf.js/complaintPdf.js.
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
