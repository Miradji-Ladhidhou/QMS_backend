import PDFDocument from 'pdfkit';

// Mêmes teintes que les autres générateurs PDF (voir listReportPdf.js) — un peu plus de
// couleurs ici pour un rendu "diplôme" plutôt que tableau de données. Fichier séparé de
// services/certificatePdf.js, qui génère un tout autre document (certificat de signature
// électronique eIDAS d'un workflow d'approbation) — même mot "certificat", objet différent.
const NAVY = '#1F3864';
const GOLD = '#B08D57';
const MUTED = '#64748b';
const INK = '#1e293b';

// Paysage : un certificat se lit plus naturellement à l'italienne, comme les diplômes/attestations imprimés.
const PAGE_WIDTH = 841.89; // A4 paysage
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js.
export function buildTrainingCertificatePdf({ tenantName, tenantLogo, personName, trainingTitle, completedAt, nextDueDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: [PAGE_WIDTH, PAGE_HEIGHT] });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cadre décoratif double filet, façon diplôme.
    doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill('#ffffff');
    doc.lineWidth(2).strokeColor(NAVY).rect(MARGIN, MARGIN, PAGE_WIDTH - MARGIN * 2, PAGE_HEIGHT - MARGIN * 2).stroke();
    doc.lineWidth(0.75).strokeColor(GOLD).rect(MARGIN + 8, MARGIN + 8, PAGE_WIDTH - (MARGIN + 8) * 2, PAGE_HEIGHT - (MARGIN + 8) * 2).stroke();

    if (tenantLogo) {
      try {
        doc.image(tenantLogo, PAGE_WIDTH / 2 - 25, MARGIN + 30, { fit: [50, 50], align: 'center' });
      } catch {
        // Format non supporté par pdfkit ou fichier corrompu : certificat sans logo, pas d'erreur.
      }
    }

    doc.fillColor(MUTED).fontSize(11).text((tenantName || 'Entreprise').toUpperCase(), MARGIN, MARGIN + 92, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: 'center',
      characterSpacing: 1.5,
    });

    doc.fillColor(NAVY).fontSize(34).text('Certificat de réussite', MARGIN, MARGIN + 130, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: 'center',
    });

    doc.moveDown(1.5);
    doc.fillColor(INK).fontSize(13).text('Ce certificat est décerné à', {
      width: PAGE_WIDTH - MARGIN * 2,
      align: 'center',
    });

    doc.moveDown(0.4);
    doc.fillColor(NAVY).fontSize(26).text(personName, {
      width: PAGE_WIDTH - MARGIN * 2,
      align: 'center',
    });

    doc.moveDown(0.6);
    doc.fillColor(INK).fontSize(13).text('pour avoir suivi avec succès la formation', {
      width: PAGE_WIDTH - MARGIN * 2,
      align: 'center',
    });

    doc.moveDown(0.3);
    doc.fillColor(NAVY).fontSize(18).text(trainingTitle, MARGIN + 60, doc.y, {
      width: PAGE_WIDTH - (MARGIN + 60) * 2,
      align: 'center',
    });

    doc.moveDown(0.8);
    doc.fillColor(MUTED).fontSize(11).text(
      nextDueDate
        ? `Réalisée le ${formatDate(completedAt)} — renouvellement à prévoir avant le ${formatDate(nextDueDate)}`
        : `Réalisée le ${formatDate(completedAt)}`,
      { width: PAGE_WIDTH - MARGIN * 2, align: 'center' }
    );

    // Ligne de signature en bas, façon diplôme papier.
    const signatureY = PAGE_HEIGHT - MARGIN - 70;
    const signatureWidth = 200;
    doc
      .moveTo(PAGE_WIDTH / 2 - signatureWidth / 2, signatureY)
      .lineTo(PAGE_WIDTH / 2 + signatureWidth / 2, signatureY)
      .strokeColor(GOLD)
      .lineWidth(1)
      .stroke();
    doc.fillColor(MUTED).fontSize(9).text(tenantName || 'Entreprise', PAGE_WIDTH / 2 - signatureWidth / 2, signatureY + 6, {
      width: signatureWidth,
      align: 'center',
    });

    doc.end();
  });
}
