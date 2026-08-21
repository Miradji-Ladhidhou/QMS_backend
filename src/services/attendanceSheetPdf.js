import PDFDocument from 'pdfkit';

// Mêmes teintes que listReportPdf.js/skillMatrixPdf.js, dupliquées pour la même raison (pas
// de module de constantes partagé entre les générateurs PDF, voir la note dans listReportPdf.js).
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';
const GRID = '#cbd5e1';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
// Une ligne de fiche de présence doit rester haute : c'est un espace de signature manuscrite,
// pas une cellule de tableau de données (voir ROW_HEIGHT plus compact dans listReportPdf.js).
const ROW_HEIGHT = 34;
const HEADER_ROW_HEIGHT = 22;
const NAME_COL_WIDTH = CONTENT_WIDTH * 0.32;
const JOB_TITLE_COL_WIDTH = CONTENT_WIDTH * 0.24;

const NOT_SET = 'Non renseigné';

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDateTime(date) {
  return date.toLocaleString('fr-FR');
}

// Référence courte et stable dérivée de l'id de formation — permet de relier sans ambiguïté
// une fiche imprimée à la formation en base, même sans système de numérotation dédié.
function attendanceSheetReference(trainingId, date) {
  return `FP-${trainingId.slice(0, 8).toUpperCase()}-${date}`;
}

function drawPageHeader(doc, tenantName, tenantLogo, trainingTitle) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Fiche de participation', PAGE_MARGIN, 26, { width: CONTENT_WIDTH - 60 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(trainingTitle, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 50, 18, { fit: [50, 50], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
  doc.y = 104;
}

// rows : [{ name, jobTitle }] — jobTitle peut être vide (personne sans fonction renseignée).
// Type/durée/formateur/lieu/description sont toujours affichés (avec un repli "Non renseigné")
// plutôt que masqués quand absents : pour un audit, un champ manquant doit se voir, pas
// disparaître silencieusement.
export function buildAttendanceSheetPdf({
  tenantName,
  tenantLogo,
  trainingId,
  trainingTitle,
  trainingType,
  description,
  location,
  instructor,
  duration,
  date,
  rows,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo, trainingTitle));

    drawPageHeader(doc, tenantName, tenantLogo, trainingTitle);

    doc.fontSize(8).fillColor(MUTED);
    doc.text(`Réf. ${attendanceSheetReference(trainingId, date)}`, PAGE_MARGIN, doc.y);
    doc.text(`Document généré le ${formatDateTime(new Date())}`, PAGE_MARGIN, doc.y);
    doc.moveDown(0.6);

    const sessionInfo = [
      `Date de la session : ${formatDate(date)}`,
      `Type : ${trainingType || NOT_SET}`,
      `Durée : ${duration || NOT_SET}`,
      `Formateur / intervenant : ${instructor || NOT_SET}`,
      `Lieu : ${location || NOT_SET}`,
    ];

    doc.fontSize(10).fillColor(INK);
    sessionInfo.forEach((line) => {
      doc.text(line, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.25);
    });

    doc.moveDown(0.15);
    doc.fontSize(9).fillColor(MUTED).text('Objet de la formation :', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.fillColor(INK).fontSize(10).text(description || NOT_SET, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.75);

    const signatureColX = PAGE_MARGIN + NAME_COL_WIDTH + JOB_TITLE_COL_WIDTH;
    const signatureColWidth = CONTENT_WIDTH - NAME_COL_WIDTH - JOB_TITLE_COL_WIDTH;

    function drawTableHeader() {
      const headerY = doc.y;
      doc.rect(PAGE_MARGIN, headerY, CONTENT_WIDTH, HEADER_ROW_HEIGHT).fill(NAVY);
      doc.fontSize(9).fillColor('#ffffff');
      doc.text('Nom', PAGE_MARGIN + 6, headerY + 6, { width: NAME_COL_WIDTH - 12 });
      doc.text('Fonction', PAGE_MARGIN + NAME_COL_WIDTH + 6, headerY + 6, { width: JOB_TITLE_COL_WIDTH - 12 });
      doc.text('Signature', signatureColX + 6, headerY + 6, { width: signatureColWidth - 12 });
      doc.y = headerY + HEADER_ROW_HEIGHT;
      doc.fillColor(INK);
    }

    drawTableHeader();

    if (rows.length === 0) {
      doc.moveDown(0.6);
      doc.fontSize(10).fillColor(MUTED).text('Aucun participant sélectionné.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    }

    rows.forEach((row) => {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (doc.y + ROW_HEIGHT > bottom) {
        doc.addPage();
        drawTableHeader();
      }

      const rowY = doc.y;
      doc.fontSize(9).fillColor(INK);
      doc.text(row.name, PAGE_MARGIN + 6, rowY + 11, { width: NAME_COL_WIDTH - 12 });
      doc.fillColor(MUTED).text(row.jobTitle || '—', PAGE_MARGIN + NAME_COL_WIDTH + 6, rowY + 11, { width: JOB_TITLE_COL_WIDTH - 12 });

      doc
        .moveTo(PAGE_MARGIN, rowY + ROW_HEIGHT)
        .lineTo(PAGE_MARGIN + CONTENT_WIDTH, rowY + ROW_HEIGHT)
        .strokeColor(GRID)
        .lineWidth(0.5)
        .stroke();
      doc
        .moveTo(signatureColX, rowY)
        .lineTo(signatureColX, rowY + ROW_HEIGHT)
        .strokeColor(GRID)
        .stroke();
      doc
        .moveTo(PAGE_MARGIN + NAME_COL_WIDTH, rowY)
        .lineTo(PAGE_MARGIN + NAME_COL_WIDTH, rowY + ROW_HEIGHT)
        .strokeColor(GRID)
        .stroke();

      doc.fillColor(INK);
      doc.y = rowY + ROW_HEIGHT;
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    }

    doc.end();
  });
}
