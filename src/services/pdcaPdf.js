import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';

// Même couleur sémantique de retard que capaPdf.js (pas une couleur de marque).
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Mêmes libellés que frontend/src/lib/pdcaStatus.js — dupliqués comme partout ailleurs dans
// cette convention (chaque générateur PDF porte ses propres libellés, runtime séparé du front).
const STATUS_LABELS = { plan: 'Plan', do: 'Do', check: 'Check', act: 'Act', closed: 'Clôturé' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

// Même esprit que drawImportantBox de capaPdf.js — réservé à une information déjà affichée à
// l'écran (bannière "En retard" sur PdcaDetail.jsx), jamais un contenu inventé.
function drawImportantBox(doc, { color, background, label, text }) {
  doc.moveDown(0.3);
  const boxTop = doc.y;
  const height = doc.heightOfString(text, { width: CONTENT_WIDTH - 16 }) + 30;
  doc.rect(PAGE_MARGIN, boxTop, CONTENT_WIDTH, height).fill(background);
  doc.fontSize(9).fillColor(color).text(label, PAGE_MARGIN + 8, boxTop + 8, { width: CONTENT_WIDTH - 16 });
  doc.fontSize(9).fillColor(INK).text(text, PAGE_MARGIN + 8, doc.y + 2, { width: CONTENT_WIDTH - 16 });
  doc.y = boxTop + height + 10;
}

function drawSection(doc, number, title, body, completedAt) {
  const heading = completedAt ? `${number}. ${title} (terminé le ${formatDate(completedAt)})` : `${number}. ${title}`;
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text(heading, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
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
// affiché sur PdcaDetail.jsx, pour qu'un export PDF ne dise jamais moins que ce que l'écran
// montre déjà (voir capaPdf.js#drawFactsGrid, identique).
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

// pdca : ligne pdca_projects jointe (service/owner_user/category/linked_capa résolus, voir
// routes/pdca.js#PDCA_SELECT).
export function buildPdcaPdf({ tenantName, tenantLogo, pdca }) {
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
      title: `Projet PDCA — ${pdca.title}`,
    };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));

    drawLetterheadHeader(doc, headerArgs);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Statut : ${STATUS_LABELS[pdca.status] || pdca.status}    —    Échéance : ${formatDate(pdca.target_date)}`, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
      });
    doc.moveDown(0.8);

    const overdue = pdca.target_date && pdca.status !== 'closed' && pdca.target_date < new Date().toISOString().slice(0, 10);
    if (overdue) {
      drawImportantBox(doc, {
        color: RED,
        background: RED_LIGHT,
        label: 'IMPORTANT — Projet PDCA en retard',
        text: `L'échéance (${formatDate(pdca.target_date)}) est dépassée sans clôture.`,
      });
    }

    doc.moveDown(0.5);
    drawFactsGrid(doc, [
      { label: 'Date de création', value: formatDate(pdca.created_at) },
      { label: 'Service', value: pdca.service?.name },
      { label: 'Responsable', value: pdca.owner_user?.full_name },
      { label: 'Catégorie', value: pdca.category?.name },
      { label: 'Échéance', value: formatDate(pdca.target_date) },
      { label: 'Clôturé le', value: formatDate(pdca.closed_at) },
      { label: 'CAPA liée', value: pdca.linked_capa ? `${pdca.linked_capa.number} — ${pdca.linked_capa.title}` : null },
    ]);

    doc.moveDown(0.3);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    if (pdca.description) {
      drawSection(doc, 1, 'Description', pdca.description);
    }
    const offset = pdca.description ? 1 : 0;
    drawSection(doc, offset + 1, 'Plan', pdca.plan_content, pdca.plan_completed_at);
    drawSection(doc, offset + 2, 'Do', pdca.do_content, pdca.do_completed_at);
    drawSection(doc, offset + 3, 'Check', pdca.check_content, pdca.check_completed_at);
    drawSection(doc, offset + 4, 'Act', pdca.act_content, pdca.act_completed_at);

    // Pied de page numéroté — même construction que capaPdf.js/procedurePdf.js.
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
