import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que procedurePdf.js/qqoqccpPdf.js/kpiReportPdf.js pour une identité visuelle
// cohérente entre les rapports PDF de l'application — dupliquées plutôt qu'importées, ces
// services n'ont pas d'autre couplage.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';
const INK = '#1e293b';
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';
const AMBER = '#b45309';
const AMBER_LIGHT = '#fffbeb';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Mêmes libellés que frontend/src/lib/capaStatus.js — dupliqués (comme le reste de cette
// convention dans l'app : chaque générateur PDF porte ses propres libellés plutôt que
// partager un module avec le frontend, qui tourne dans un autre runtime).
const STATUS_LABELS = { open: 'Ouverte', in_progress: 'En cours', pending_verification: 'En vérification', closed: 'Clôturée', overdue: 'En retard' };
const PRIORITY_LABELS = { low: 'Mineure', medium: 'Modérée', high: 'Majeure', critical: 'Critique' };
const EFFECTIVENESS_LABELS = { null: 'Non vérifiée', true: 'Efficace', false: 'Non efficace' };

function formatDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('fr-FR') : '—';
}

function formatDateTime(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleString('fr-FR') : '—';
}

function drawPageHeader(doc, tenantName, tenantLogo, capa) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc
    .fillColor('#ffffff')
    .fontSize(16)
    .text(`${capa.number ? `${capa.number} — ` : ''}${capa.title}`, PAGE_MARGIN, 22, { width: CONTENT_WIDTH - 60 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 50, 18, { fit: [50, 50], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
}

// Même esprit que drawImportantBox de procedurePdf.js — réservé à une information déjà
// affichée à l'écran (bannière "En retard" sur CapaDetail.jsx), jamais un contenu inventé.
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
  doc.fontSize(11).fillColor(NAVY).text(`${number}. ${title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.2);
  if (body) {
    doc.fontSize(10).fillColor(INK).text(body, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  } else {
    doc.fontSize(10).fillColor(MUTED).text('Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.7);
}

// Deux colonnes de paires libellé/valeur — même densité d'information que le bloc <dl> affiché
// sur CapaDetail.jsx, pour qu'un export PDF ne dise jamais moins que ce que l'écran montre déjà.
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

// capa : ligne capas jointe (assigned/service/category résolus, voir routes/capas.js#CAPA_SELECT).
export function buildCapaPdf({ tenantName, tenantLogo, capa }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo, capa));

    drawPageHeader(doc, tenantName, tenantLogo, capa);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Statut : ${STATUS_LABELS[capa.status] || capa.status}    —    Priorité : ${PRIORITY_LABELS[capa.priority] || capa.priority}`,
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );
    doc.moveDown(0.8);

    if (capa.status === 'overdue') {
      drawImportantBox(doc, {
        color: RED,
        background: RED_LIGHT,
        label: 'IMPORTANT — CAPA en retard',
        text: `L'échéance (${formatDate(capa.due_date)}) est dépassée sans clôture.`,
      });
    } else if (capa.effectiveness_verified === false) {
      drawImportantBox(doc, {
        color: AMBER,
        background: AMBER_LIGHT,
        label: 'IMPORTANT — Efficacité non vérifiée concluante',
        text: "L'action mise en place a été jugée non efficace lors de la vérification.",
      });
    }

    doc.moveDown(0.5);
    drawFactsGrid(doc, [
      { label: 'Date de création', value: formatDate(capa.created_at) },
      { label: 'Origine', value: capa.origin },
      { label: 'Responsable assigné', value: capa.assigned?.full_name || 'Non assigné' },
      { label: 'Service', value: capa.service?.name },
      { label: 'Catégorie', value: capa.category?.name },
      { label: 'Échéance', value: formatDate(capa.due_date) },
      { label: 'Clôturée le', value: formatDate(capa.closed_at) },
      { label: 'Efficacité', value: EFFECTIVENESS_LABELS[String(capa.effectiveness_verified)] },
    ]);

    doc.moveDown(0.3);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(GRID).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    drawSection(doc, 1, 'Description de la non-conformité', capa.description);
    drawSection(doc, 2, 'Cause identifiée', capa.root_cause);
    drawSection(doc, 3, 'Action corrective', capa.corrective_action);
    drawSection(doc, 4, 'Action préventive', capa.preventive_action);
    if (capa.effectiveness_notes) {
      drawSection(doc, 5, "Notes de vérification d'efficacité", capa.effectiveness_notes);
    }
    if (capa.comment) {
      drawSection(doc, capa.effectiveness_notes ? 6 : 5, 'Commentaire', capa.comment);
    }

    // Pied de page numéroté — même construction que procedurePdf.js/qqoqccpPdf.js.
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
