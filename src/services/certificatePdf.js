import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Mêmes teintes que listReportPdf.js/qqoqccpPdf.js/kpiReportPdf.js pour une identité visuelle
// cohérente entre tous les rapports PDF de l'application — dupliquées plutôt qu'importées, voir
// la note dans qqoqccpPdf.js sur l'absence de module de constantes partagé.
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Un certificat n'a que 3 issues possibles pour un workflow/une décision : jamais un statut
// anglais brut affiché sur un document destiné à être imprimé/transmis à un tiers.
const WORKFLOW_STATUS_LABELS_FR = { pending: 'En cours', approved: 'Approuvé', rejected: 'Rejeté' };
const DECISION_LABELS_FR = { pending: 'En attente', approved: 'Approuvé', rejected: 'Rejeté' };

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

function drawPageHeader(doc, tenantName, tenantLogo) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Certificat de signature électronique', PAGE_MARGIN, 26, {
    width: CONTENT_WIDTH - 72,
  });
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Émis le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
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

// Génère le PDF en mémoire (pas de fichier temporaire) : on collecte les chunks du flux
// pdfkit dans un buffer, résolu à l'évènement 'end'.
export function buildCertificatePdf({ tenantName, tenantLogo, document, workflow, approvals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo));

    drawPageHeader(doc, tenantName, tenantLogo);

    doc.fontSize(9).fillColor(MUTED).text(`Référence : CERT-${document.number}-${document.version}`, PAGE_MARGIN, doc.y);
    doc.moveDown(0.8);

    doc.fillColor(INK).fontSize(11);
    doc.text(`Document : ${document.number} — ${document.title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.text(`Version certifiée : ${document.version}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.text(`Statut du workflow : ${WORKFLOW_STATUS_LABELS_FR[workflow.status] || workflow.status}`, PAGE_MARGIN, doc.y, {
      width: CONTENT_WIDTH,
    });
    doc.text(`Workflow ouvert le : ${formatDateTime(workflow.created_at)}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown();

    doc.fontSize(13).fillColor(NAVY).text('Approbateurs', PAGE_MARGIN, doc.y, { underline: true });
    doc.moveDown(0.5);

    approvals.forEach((approval) => {
      doc
        .fontSize(11)
        .fillColor(INK)
        .text(`${approval.approver?.full_name || 'Utilisateur inconnu'} — ${DECISION_LABELS_FR[approval.decision] || approval.decision}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.fontSize(9).fillColor(MUTED);
      doc.text(`Décidé le : ${approval.decided_at ? formatDateTime(approval.decided_at) : '—'}`, PAGE_MARGIN, doc.y, {
        width: CONTENT_WIDTH,
      });
      if (approval.signature_hash) {
        doc.text(`Hash de signature (SHA-256) : ${approval.signature_hash}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      }
      if (approval.ip_address) {
        doc.text(`Adresse IP : ${approval.ip_address}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      }
      doc.fillColor(INK).moveDown();
    });

    doc.moveDown();
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        "Ce certificat atteste d'une signature électronique simple au sens du règlement eIDAS (UE) n°910/2014, " +
          "adaptée à un usage interne/B2B. Elle ne constitue pas une signature électronique qualifiée.",
        PAGE_MARGIN,
        doc.y,
        { width: CONTENT_WIDTH }
      );

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
