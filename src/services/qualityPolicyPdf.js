import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, drawLetterheadHeader } from './pdfTheme.js';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// Génère le PDF en mémoire (pas de fichier temporaire), même principe que
// certificatePdf.js#buildCertificatePdf. acknowledgmentSummary est optionnel (null pour un
// appelant member — voir GET /api/quality-policy/pdf, réservé admin/manager comme le résumé
// affiché à l'écran) : la preuve de diffusion §5.2 n'a de sens qu'en pilotage, pas dans la
// version qu'on remettrait par exemple à un auditeur ou un client externe.
export function buildQualityPolicyPdf({ tenantName, tenantLogo, version, acknowledgmentSummary }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: 'Politique qualité' };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));

    drawLetterheadHeader(doc, headerArgs);

    doc.fontSize(9).fillColor(MUTED);
    doc.text(`Révisée le ${formatDateTime(version.created_at)}${version.author?.full_name ? ` par ${version.author.full_name}` : ''}`, PAGE_MARGIN, doc.y, {
      width: CONTENT_WIDTH,
    });
    if (acknowledgmentSummary) {
      doc.text(
        `${acknowledgmentSummary.acknowledged_count}/${acknowledgmentSummary.total_users} personnes ont pris connaissance de cette version.`,
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );
    }
    doc.moveDown();

    doc.fontSize(11).fillColor(INK).text(version.content, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'left' });

    // Pied de page numéroté — voir certificatePdf.js pour la même construction.
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
