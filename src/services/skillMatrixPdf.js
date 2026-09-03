import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que kpiReportPdf.js / qqoqccpPdf.js, dupliquées pour la même raison (pas de
// couplage utile entre ces services au-delà de la charte de couleur).
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';
const INK = '#1e293b';
const GOOD = '#059669';
const WARN = '#d97706';
const BAD = '#dc2626';
const NEVER = '#94a3b8';

const PAGE_MARGIN = 40;
// Paysage : une matrice personnel × formations est presque toujours plus large que haute.
const PAGE_WIDTH = 841.89; // A4 paysage
const PAGE_HEIGHT = 595.28;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

const PERSON_COL_WIDTH = 150;
const TRAINING_COL_WIDTH = 95;
const HEADER_ROW_HEIGHT = 34;
const ROW_HEIGHT = 20;

const STATUS_STYLES = {
  up_to_date: { color: GOOD, label: 'À jour' },
  due_soon: { color: WARN, label: 'Bientôt' },
  expired: { color: BAD, label: 'Expiré' },
  never_done: { color: NEVER, label: 'Jamais' },
};

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js et le même try/catch
// dans kpiReportPdf.js.
function drawPageHeader(doc, tenantName, tenantLogo) {
  doc.rect(0, 0, PAGE_WIDTH, 70).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(16).text('Matrice des compétences', PAGE_MARGIN, 20);
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 42);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 54);
  doc.fillColor(INK);

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 44, 13, { fit: [44, 44], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
}

function drawLegend(doc, y) {
  let x = PAGE_MARGIN;
  Object.values(STATUS_STYLES).forEach(({ color, label }) => {
    doc.circle(x + 4, y + 4, 4).fillColor(color).fill();
    doc.fontSize(8).fillColor(MUTED).text(label, x + 12, y, { width: 60 });
    x += 75;
  });
}

function drawTableHeaderRow(doc, trainingsChunk, y) {
  doc.fontSize(8).fillColor(MUTED);
  doc.text('Personnel', PAGE_MARGIN, y, { width: PERSON_COL_WIDTH - 8 });

  trainingsChunk.forEach((training, index) => {
    const x = PAGE_MARGIN + PERSON_COL_WIDTH + index * TRAINING_COL_WIDTH;
    doc.fontSize(7.5).fillColor(NAVY).text(training.title, x + 4, y, { width: TRAINING_COL_WIDTH - 8, height: HEADER_ROW_HEIGHT - 4 });
  });

  const lineY = y + HEADER_ROW_HEIGHT;
  doc
    .moveTo(PAGE_MARGIN, lineY)
    .lineTo(PAGE_MARGIN + PERSON_COL_WIDTH + trainingsChunk.length * TRAINING_COL_WIDTH, lineY)
    .strokeColor(NAVY)
    .lineWidth(1)
    .stroke();

  return lineY + 6;
}

function drawPersonRow(doc, person, trainingsChunk, findEntry, y) {
  doc.fontSize(8.5).fillColor(INK).text(person.full_name, PAGE_MARGIN, y + 4, { width: PERSON_COL_WIDTH - 60 });
  if (person.kind === 'employee') {
    doc.fontSize(6.5).fillColor(MUTED).text('Sans compte', PAGE_MARGIN + PERSON_COL_WIDTH - 55, y + 6, { width: 55 });
  }

  trainingsChunk.forEach((training, index) => {
    const entry = findEntry(training, person.id);
    const status = entry?.status || 'never_done';
    const style = STATUS_STYLES[status];
    const x = PAGE_MARGIN + PERSON_COL_WIDTH + index * TRAINING_COL_WIDTH + TRAINING_COL_WIDTH / 2;
    doc.circle(x, y + 8, 5).fillColor(style.color).fill();
  });

  doc
    .moveTo(PAGE_MARGIN, y + ROW_HEIGHT)
    .lineTo(PAGE_MARGIN + PERSON_COL_WIDTH + trainingsChunk.length * TRAINING_COL_WIDTH, y + ROW_HEIGHT)
    .strokeColor(GRID)
    .lineWidth(0.5)
    .stroke();
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Une matrice personnel × formations dépasse presque toujours une seule page dans les deux
// sens : on découpe les formations en groupes de colonnes qui tiennent en largeur (une page
// par groupe), et à l'intérieur de chaque groupe on repagine verticalement dès que les lignes
// de personnel dépassent la hauteur restante, en réaffichant l'en-tête de colonnes à chaque
// nouvelle page — même logique que la table de synthèse de kpiReportPdf.js.
export function buildSkillMatrixPdf({ tenantName, tenantLogo, matrix }) {
  return new Promise((resolve, reject) => {
    // autoFirstPage: false — sans quoi pdfkit crée une première page vide à la construction,
    // avant notre premier doc.addPage() explicite dans la boucle ci-dessous.
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', layout: 'landscape', bufferPages: true, autoFirstPage: false });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const people = matrix[0]?.people.map((entry) => entry.person) ?? [];
    const trainings = matrix.map((entry) => entry.training);

    function findEntry(training, personId) {
      const trainingEntry = matrix.find((m) => m.training.id === training.id);
      return trainingEntry?.people.find((p) => p.person.id === personId);
    }

    const trainingsPerPage = Math.max(1, Math.floor((CONTENT_WIDTH - PERSON_COL_WIDTH) / TRAINING_COL_WIDTH));
    const columnGroups = trainings.length > 0 ? chunk(trainings, trainingsPerPage) : [[]];

    columnGroups.forEach((group, groupIndex) => {
      doc.addPage();
      drawPageHeader(doc, tenantName, tenantLogo);
      if (groupIndex === 0) drawLegend(doc, 78);

      let y = groupIndex === 0 ? 96 : 90;
      y = drawTableHeaderRow(doc, group, y);

      if (people.length === 0) {
        doc.fontSize(9).fillColor(MUTED).text('Aucun personnel à afficher.', PAGE_MARGIN, y);
        return;
      }

      people.forEach((person) => {
        if (y + ROW_HEIGHT > PAGE_HEIGHT - PAGE_MARGIN) {
          doc.addPage();
          drawPageHeader(doc, tenantName, tenantLogo);
          y = drawTableHeaderRow(doc, group, 90);
        }
        drawPersonRow(doc, person, group, findEntry, y);
        y += ROW_HEIGHT;
      });
    });

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
