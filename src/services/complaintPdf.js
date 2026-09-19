import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';

// Même couleur sémantique de retard que capaPdf.js/pdcaPdf.js (pas une couleur de marque).
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';
const AMBER = '#b45309';
const AMBER_LIGHT = '#fffbeb';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Mêmes libellés que frontend/src/lib/complaintStatus.js/capaStatus.js — dupliqués comme
// partout ailleurs dans cette convention (chaque générateur PDF porte ses propres libellés).
const STATUS_LABELS = { received: 'Reçue', investigating: 'En investigation', resolved: 'Résolue', closed: 'Clôturée' };
const SEVERITY_LABELS = { low: 'Mineure', medium: 'Modérée', high: 'Majeure', critical: 'Critique' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

// Même esprit que drawImportantBox de capaPdf.js/pdcaPdf.js — réservé à une information déjà
// affichée à l'écran (bannière client insatisfait sur ComplaintDetail.jsx), jamais un contenu
// inventé.
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
// affiché sur ComplaintDetail.jsx (voir capaPdf.js#drawFactsGrid, identique).
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

// complaint : ligne complaints jointe (assigned/service/category/linked_capa résolus, voir
// routes/complaints.js#COMPLAINT_SELECT).
export function buildComplaintPdf({ tenantName, tenantLogo, complaint }) {
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
      title: `Réclamation — ${complaint.customer_name}`,
    };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));

    drawLetterheadHeader(doc, headerArgs);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Statut : ${STATUS_LABELS[complaint.status] || complaint.status}    —    Gravité : ${
          SEVERITY_LABELS[complaint.severity] || complaint.severity
        }`,
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );
    doc.moveDown(0.8);

    const overdue = complaint.due_date && complaint.status !== 'resolved' && complaint.status !== 'closed' && complaint.due_date < new Date().toISOString().slice(0, 10);
    if (overdue) {
      drawImportantBox(doc, {
        color: RED,
        background: RED_LIGHT,
        label: 'IMPORTANT — Réclamation en retard',
        text: `L'échéance de réponse (${formatDate(complaint.due_date)}) est dépassée sans résolution.`,
      });
    } else if (complaint.customer_satisfied === false) {
      drawImportantBox(doc, {
        color: AMBER,
        background: AMBER_LIGHT,
        label: 'IMPORTANT — Client insatisfait de la résolution',
        text: "Le client s'est dit insatisfait de la résolution apportée.",
      });
    }

    doc.moveDown(0.5);
    drawFactsGrid(doc, [
      { label: 'Reçue le', value: formatDate(complaint.received_date) },
      { label: 'Échéance de réponse', value: formatDate(complaint.due_date) },
      { label: 'Contact', value: complaint.customer_contact },
      { label: 'Service concerné', value: complaint.service?.name },
      { label: 'Assigné à', value: complaint.assigned?.full_name || 'Non assigné' },
      { label: 'Catégorie', value: complaint.category?.name },
      { label: 'Date de résolution', value: formatDate(complaint.resolution_date) },
      {
        label: 'Client satisfait',
        value: complaint.customer_satisfied === null ? 'Non renseigné' : complaint.customer_satisfied ? 'Oui' : 'Non',
      },
      { label: 'CAPA liée', value: complaint.linked_capa ? `${complaint.linked_capa.number} — ${complaint.linked_capa.title}` : null },
    ]);

    doc.moveDown(0.3);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    drawSection(doc, 1, 'Description', complaint.description);
    if (complaint.product_service) {
      drawSection(doc, 2, 'Produit / service concerné', complaint.product_service);
    }
    const offset = complaint.product_service ? 2 : 1;
    drawSection(doc, offset + 1, 'Cause identifiée', complaint.root_cause);
    drawSection(doc, offset + 2, 'Résolution apportée', complaint.resolution);

    // Pied de page numéroté — même construction que capaPdf.js/pdcaPdf.js.
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
