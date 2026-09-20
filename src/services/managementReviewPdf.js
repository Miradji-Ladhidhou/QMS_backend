import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';
import { ACTION_STATUS_LABELS, REVIEW_TEXT_SECTIONS, buildInputBlocks, formatReviewDate } from './managementReviewContent.js';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const STATUS_LABELS = { draft: 'Brouillon', completed: 'Clôturée' };
// Couleurs sémantiques (état d'une action), pas des couleurs de marque.
const STATUS_COLORS = { open: '#b45309', in_progress: '#0369a1', done: '#047857', cancelled: MUTED };
const OVERDUE = '#b91c1c';

function ensureSpace(doc, height) {
  if (doc.y > doc.page.height - PAGE_MARGIN - height) doc.addPage();
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 70);
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

function paragraph(doc, text) {
  doc.fontSize(10).fillColor(text ? INK : MUTED).text(text || 'Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.7);
}

function factsGrid(doc, facts) {
  const colWidth = CONTENT_WIDTH / 2;
  const startY = doc.y;
  let maxY = startY;
  facts.forEach((fact, index) => {
    const x = PAGE_MARGIN + (index % 2) * colWidth;
    const y = startY + Math.floor(index / 2) * 34;
    const valueHeight = doc.fontSize(10).heightOfString(fact.value || '—', { width: colWidth - 12 });
    doc.fontSize(8).fillColor(MUTED).text(fact.label.toUpperCase(), x, y, { width: colWidth - 12 });
    doc.fontSize(10).fillColor(INK).text(fact.value || '—', x, y + 11, { width: colWidth - 12 });
    maxY = Math.max(maxY, y + 13 + valueHeight + 8);
  });
  doc.y = maxY + 6;
}

// Liste d'actions (décidées ou de la revue précédente) : description, puis statut coloré, responsable,
// échéance et CAPA liée sur une ligne.
function drawActions(doc, actions) {
  actions.forEach((action, index) => {
    ensureSpace(doc, 60);
    doc.fontSize(10).fillColor(INK).text(`${index + 1}. ${action.description}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    const status = action.effective_status || action.status;
    const details = [
      action.owner_user?.full_name ? `Responsable : ${action.owner_user.full_name}` : 'Sans responsable',
      action.due_date ? `Échéance : ${formatReviewDate(action.due_date)}` : null,
      action.linked_capa ? `CAPA ${action.linked_capa.number}` : null,
      action.status_derived ? 'clôturée via la CAPA liée' : null,
    ].filter(Boolean);
    doc.fontSize(9).fillColor(STATUS_COLORS[status] || MUTED).text(ACTION_STATUS_LABELS[status] || status, PAGE_MARGIN + 12, doc.y + 1, { continued: true });
    if (action.is_overdue) doc.fillColor(OVERDUE).text('  — échéance dépassée', { continued: true });
    doc.fillColor(MUTED).text(`   ·   ${details.join('   ·   ')}`, { width: CONTENT_WIDTH - 12 });
    doc.moveDown(0.6);
  });
}

// review : revue avec actions enrichies (owner_user, linked_capa, effective_status…), category ;
// previousReview : revue clôturée précédente et ses actions, ou null.
export function buildManagementReviewPdf({ tenantName, tenantLogo, review, previousReview }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `Revue de direction — ${review.title}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc.fontSize(9).fillColor(MUTED).text(`Statut : ${STATUS_LABELS[review.status] || review.status}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);
    factsGrid(doc, [
      { label: 'Date de la revue', value: formatReviewDate(review.review_date) },
      { label: 'Période analysée', value: review.period_start && review.period_end ? `${formatReviewDate(review.period_start)} → ${formatReviewDate(review.period_end)}` : 'Non définie' },
      { label: 'Participants', value: review.participants },
      { label: 'Dossier', value: review.category?.name },
    ]);
    doc.moveDown(0.2);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    let number = 1;
    sectionTitle(doc, `${number}. Éléments d'entrée`);
    number += 1;
    const blocks = buildInputBlocks(review);
    if (blocks.length === 0) {
      paragraph(doc, '');
    } else {
      blocks.forEach((block) => {
        ensureSpace(doc, 50);
        doc.font('Body-Bold').fontSize(9.5).fillColor(INK).text(block.title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        doc.font('Body');
        block.lines.forEach((line) => doc.fontSize(9.5).fillColor(INK).text(`• ${line}`, PAGE_MARGIN + 8, doc.y, { width: CONTENT_WIDTH - 8 }));
        doc.moveDown(0.5);
      });
      doc.moveDown(0.2);
    }

    // Actions de la revue précédente (suivi automatique) puis le texte de suivi saisi.
    sectionTitle(doc, `${number}. Statut des actions de la revue précédente`);
    number += 1;
    if (previousReview) {
      doc.fontSize(9).fillColor(MUTED).text(`Revue précédente : ${previousReview.title} (${formatReviewDate(previousReview.review_date)})`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);
      if (previousReview.actions.length === 0) paragraph(doc, 'Aucune action décidée lors de cette revue.');
      else drawActions(doc, previousReview.actions);
    }
    paragraph(doc, review.previous_actions_status);

    for (const { key, title } of REVIEW_TEXT_SECTIONS.filter((section) => section.key !== 'previous_actions_status')) {
      sectionTitle(doc, `${number}. ${title}`);
      number += 1;
      paragraph(doc, review[key]);
    }

    sectionTitle(doc, `${number}. Actions décidées (${review.actions.length})`);
    if (review.actions.length === 0) paragraph(doc, '');
    else drawActions(doc, review.actions);

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, { width: CONTENT_WIDTH, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}
