import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que certificatePdf.js/kpiReportPdf.js pour une identité visuelle cohérente
// entre tous les rapports PDF de l'application — dupliquées plutôt qu'importées, voir la note
// dans qqoqccpPdf.js sur l'absence de module de constantes partagé.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

function drawPageHeader(doc, tenantName, tenantLogo) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Politique qualité', PAGE_MARGIN, 26, { width: CONTENT_WIDTH - 72 });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Exporté le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 62, 12, { fit: [62, 62], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
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
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo));

    drawPageHeader(doc, tenantName, tenantLogo);

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
