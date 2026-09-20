import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED } from './pdfTheme.js';

// GOLD reste un ornement décoratif "diplôme" (double filet, ligne de signature), pas une
// couleur de marque — le bleu marine utilisé ailleurs a en revanche été retiré au profit de
// l'encre neutre, même principe que le reste des documents (voir pdfTheme.js). Fichier séparé
// de services/certificatePdf.js, qui génère un tout autre document (certificat de signature
// électronique eIDAS d'un workflow d'approbation) — même mot "certificat", objet différent.
const GOLD = '#B08D57';

// Paysage : un certificat se lit plus naturellement à l'italienne, comme les diplômes/attestations imprimés.
const PAGE_WIDTH = 841.89; // A4 paysage
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;

const NOT_SET = 'non renseigné';

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDateTime(date) {
  return date.toLocaleString('fr-FR');
}

// Référence courte et stable dérivée de l'id de la réalisation — relie sans ambiguïté un
// certificat imprimé à son enregistrement en base.
function certificateReference(recordId) {
  return `CERT-${recordId.slice(0, 8).toUpperCase()}`;
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js. Type/durée/formateur/
// lieu/description affichent "non renseigné" quand absents plutôt que d'être omis : un
// certificat qui tait discrètement ce qu'il ne sait pas est moins fiable pour un audit qu'un
// certificat qui le dit explicitement.
export function buildTrainingCertificatePdf({
  tenantName,
  tenantLogo,
  recordId,
  personName,
  trainingTitle,
  trainingType,
  duration,
  instructor,
  location,
  description,
  completedAt,
  nextDueDate,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: [PAGE_WIDTH, PAGE_HEIGHT] });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    // Cadre décoratif double filet, façon diplôme.
    doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill('#ffffff');
    doc.lineWidth(2).strokeColor(INK).rect(MARGIN, MARGIN, PAGE_WIDTH - MARGIN * 2, PAGE_HEIGHT - MARGIN * 2).stroke();
    doc.lineWidth(0.75).strokeColor(GOLD).rect(MARGIN + 8, MARGIN + 8, PAGE_WIDTH - (MARGIN + 8) * 2, PAGE_HEIGHT - (MARGIN + 8) * 2).stroke();

    if (tenantLogo) {
      try {
        doc.image(tenantLogo, PAGE_WIDTH / 2 - 40, MARGIN + 16, { fit: [80, 80], align: 'center' });
      } catch {
        // Format non supporté par pdfkit ou fichier corrompu : certificat sans logo, pas d'erreur.
      }
    }

    // Décalés de +20 vers le bas par rapport à l'ancien logo (56pt) : le logo agrandi (80pt)
    // chevauchait sinon le nom de l'entreprise juste en dessous.
    // Tout le texte est centré sur la page. x est passé explicitement à chaque appel : pdfkit garde
    // le x du dernier text() positionné, donc un appel sans x qui suit un bloc à marge (titre,
    // description) se retrouvait décalé vers la droite au lieu d'être centré.
    const centered = (text, { color = INK, size = 12, inset = 0, y = doc.y, ...options } = {}) => {
      doc.fillColor(color).fontSize(size).text(text, MARGIN + inset, y, {
        width: PAGE_WIDTH - (MARGIN + inset) * 2,
        align: 'center',
        ...options,
      });
    };

    // Décalés de +20 vers le bas par rapport à l'ancien logo (56pt) : le logo agrandi (80pt)
    // chevauchait sinon le nom de l'entreprise juste en dessous.
    centered((tenantName || 'Entreprise').toUpperCase(), { color: MUTED, size: 11, y: MARGIN + 104, characterSpacing: 1.5 });
    centered('Certificat de réussite', { size: 30, y: MARGIN + 138 });

    doc.moveDown(1.1);
    centered('Ce certificat est décerné à');

    doc.moveDown(0.3);
    centered(personName, { size: 23, inset: 60 });

    doc.moveDown(0.5);
    centered('pour avoir suivi avec succès la formation');

    doc.moveDown(0.25);
    centered(trainingTitle, { size: 16, inset: 60 });

    doc.moveDown(0.5);
    centered(
      `Type : ${trainingType || NOT_SET}  ·  Durée : ${duration || NOT_SET}  ·  Formateur : ${instructor || NOT_SET}  ·  Lieu : ${location || NOT_SET}`,
      { color: MUTED, size: 10, inset: 20 }
    );

    if (description) {
      doc.moveDown(0.4);
      centered(description, { color: MUTED, size: 9, inset: 100 });
    }

    doc.moveDown(0.6);
    centered(
      nextDueDate
        ? `Réalisée le ${formatDate(completedAt)} — renouvellement à prévoir avant le ${formatDate(nextDueDate)}`
        : `Réalisée le ${formatDate(completedAt)}`,
      { color: MUTED, size: 11, inset: 20 }
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
    centered(tenantName || 'Entreprise', { color: MUTED, size: 9, y: signatureY + 6 });

    // Référence + date d'émission, discrètes, centrées en pied de page — traçabilité de l'audit.
    centered(`${certificateReference(recordId)}  ·  Émis le ${formatDateTime(new Date())}`, {
      color: MUTED,
      size: 7,
      y: PAGE_HEIGHT - MARGIN - 20,
    });

    doc.end();
  });
}
