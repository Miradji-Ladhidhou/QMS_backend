import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

// Génère le PDF en mémoire (pas de fichier temporaire) : on collecte les chunks du flux
// pdfkit dans un buffer, résolu à l'évènement 'end'.
export function buildCertificatePdf({ document, workflow, approvals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    doc.fontSize(18).fillColor('#1F3864').text('Certificat de signature électronique', { align: 'center' });
    doc.moveDown();

    doc.fillColor('#000000').fontSize(11);
    doc.text(`Document : ${document.number} — ${document.title}`);
    doc.text(`Version certifiée : ${document.version}`);
    doc.text(`Statut du workflow : ${workflow.status}`);
    doc.text(`Workflow ouvert le : ${new Date(workflow.created_at).toLocaleString('fr-FR')}`);
    doc.moveDown();

    doc.fontSize(13).text('Approbateurs', { underline: true });
    doc.moveDown(0.5);

    approvals.forEach((approval) => {
      doc.fontSize(11).fillColor('#000000').text(`${approval.approver?.full_name || 'Utilisateur inconnu'} — ${approval.decision}`);
      doc.fontSize(9).fillColor('#555555');
      doc.text(`Décidé le : ${approval.decided_at ? new Date(approval.decided_at).toLocaleString('fr-FR') : '—'}`);
      if (approval.signature_hash) {
        doc.text(`Hash de signature (SHA-256) : ${approval.signature_hash}`);
      }
      if (approval.ip_address) {
        doc.text(`Adresse IP : ${approval.ip_address}`);
      }
      doc.moveDown();
    });

    doc.moveDown();
    doc
      .fontSize(8)
      .fillColor('#777777')
      .text(
        "Ce certificat atteste d'une signature électronique simple au sens du règlement eIDAS (UE) n°910/2014, " +
          "adaptée à un usage interne/B2B. Elle ne constitue pas une signature électronique qualifiée.",
        { align: 'left' }
      );

    doc.end();
  });
}
