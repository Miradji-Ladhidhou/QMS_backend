import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';
import { CHECKLIST_ANSWER_LABELS, summarizeChecklist } from './auditChecklist.js';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// Libellés dupliqués du frontend (lib/auditStatus.js) : chaque générateur PDF porte les siens.
const STATUS_LABELS = { planned: 'Planifié', in_progress: 'En cours', completed: 'Terminé', closed: 'Clôturé' };
const TYPE_LABELS = { process: 'Processus', product: 'Produit', system: 'Système' };
const FINDING_LABELS = { major_nc: 'Non-conformité majeure', minor_nc: 'Non-conformité mineure', observation: 'Remarque', strength: 'Point fort' };
// Couleurs sémantiques (conforme / non conforme), pas des couleurs de marque.
const ANSWER_COLORS = { conform: '#047857', nonconform: '#b91c1c', na: MUTED };
const FINDING_COLORS = { major_nc: '#b91c1c', minor_nc: '#b45309', observation: '#0369a1', strength: '#047857' };

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : '—');
const formatDateTime = (value) => (value ? new Date(value).toLocaleString('fr-FR') : '—');

function drawSectionTitle(doc, title) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.font('Body-Bold').fontSize(11).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

function drawText(doc, text) {
  doc.fontSize(10).fillColor(text ? INK : MUTED).text(text || 'Non renseigné', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.7);
}

// Deux colonnes de paires libellé/valeur, même grille que capaPdf.js : un export ne dit jamais moins
// que la fiche affichée à l'écran.
function drawFactsGrid(doc, facts) {
  const colWidth = CONTENT_WIDTH / 2;
  const startY = doc.y;
  let maxY = startY;
  facts.forEach((fact, index) => {
    const x = PAGE_MARGIN + (index % 2) * colWidth;
    const valueHeight = doc.fontSize(10).heightOfString(fact.value || '—', { width: colWidth - 12 });
    // Une valeur longue (qualification de l'auditeur) prend sa place : la grille n'a pas de hauteur fixe.
    const y = startY + Math.floor(index / 2) * 34;
    doc.fontSize(8).fillColor(MUTED).text(fact.label.toUpperCase(), x, y, { width: colWidth - 12 });
    doc.fontSize(10).fillColor(INK).text(fact.value || '—', x, y + 11, { width: colWidth - 12 });
    maxY = Math.max(maxY, y + 13 + valueHeight + 8);
  });
  doc.y = maxY + 6;
}

// audit : ligne audits jointe (lead/service/category) ; findings : constats (linked_capa résolue) ;
// checklistItems : questions et réponses ; linkedProcedures : procédures liées ;
// qualificationText : phrase de qualification de l'auditeur (voir auditorQualification.js).
export function buildAuditPdf({ tenantName, tenantLogo, audit, findings, checklistItems, linkedProcedures, qualificationText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);
    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `Audit — ${audit.title}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc
      .fontSize(9)
      .fillColor(MUTED)
      .text(`Statut : ${STATUS_LABELS[audit.status] || audit.status}    —    Type : ${TYPE_LABELS[audit.audit_type] || audit.audit_type}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);

    drawFactsGrid(doc, [
      { label: 'Date planifiée', value: formatDate(audit.planned_date) },
      { label: 'Date de réalisation', value: formatDate(audit.completed_date) },
      { label: 'Service audité', value: audit.service?.name },
      { label: 'Auditeur', value: audit.lead?.full_name || 'À désigner' },
      { label: 'Dossier', value: audit.category?.name },
    ]);
    if (audit.lead && qualificationText) {
      doc.fontSize(8).fillColor(MUTED).text('QUALIFICATION DE L\'AUDITEUR', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.fontSize(10).fillColor(INK).text(qualificationText, PAGE_MARGIN, doc.y + 2, { width: CONTENT_WIDTH });
      doc.moveDown(0.6);
    }

    doc.moveDown(0.2);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.moveDown(0.6);

    drawSectionTitle(doc, '1. Périmètre');
    drawText(doc, audit.scope);
    drawSectionTitle(doc, '2. Conclusion');
    drawText(doc, audit.conclusion);

    drawSectionTitle(doc, `3. Constats (${findings.length})`);
    if (findings.length === 0) {
      drawText(doc, '');
      doc.y -= 4;
    }
    findings.forEach((finding) => {
      if (doc.y > doc.page.height - 90) doc.addPage();
      doc.fontSize(9).fillColor(FINDING_COLORS[finding.type] || INK).text(FINDING_LABELS[finding.type] || finding.type, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.fontSize(10).fillColor(INK).text(finding.description, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      if (finding.linked_capa) {
        doc.fontSize(8).fillColor(MUTED).text(`CAPA liée : ${finding.linked_capa.number} — ${finding.linked_capa.title}`, PAGE_MARGIN, doc.y + 1, { width: CONTENT_WIDTH });
      }
      doc.moveDown(0.6);
    });
    doc.moveDown(0.2);

    const summary = summarizeChecklist(checklistItems);
    drawSectionTitle(doc, `4. Check-list d'audit (${summary.total} question${summary.total > 1 ? 's' : ''})`);
    if (summary.total === 0) {
      drawText(doc, '');
    } else {
      const rate = summary.conformity_percent === null ? 'non calculable (aucune réponse « conforme » ou « non conforme »)' : `${summary.conformity_percent} %`;
      doc
        .fontSize(9)
        .fillColor(MUTED)
        .text(
          `${summary.answered}/${summary.total} répondue${summary.answered > 1 ? 's' : ''}  —  Taux de conformité : ${rate}  —  ${summary.conform} conforme(s), ${summary.nonconform} non conforme(s), ${summary.na} sans objet`,
          PAGE_MARGIN,
          doc.y,
          { width: CONTENT_WIDTH }
        );
      doc.moveDown(0.6);

      checklistItems.forEach((item, index) => {
        if (doc.y > doc.page.height - 100) doc.addPage();
        doc.fontSize(10).fillColor(INK).text(`${index + 1}. ${item.question}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
        const answerLabel = item.answer ? CHECKLIST_ANSWER_LABELS[item.answer] : 'Non répondue';
        doc.fontSize(9).fillColor(item.answer ? ANSWER_COLORS[item.answer] : MUTED).text(answerLabel, PAGE_MARGIN + 12, doc.y + 1, { width: CONTENT_WIDTH - 12 });
        if (item.observation) {
          doc.fontSize(9).fillColor(INK).text(`Observation : ${item.observation}`, PAGE_MARGIN + 12, doc.y + 1, { width: CONTENT_WIDTH - 12 });
        }
        if (item.answered_at && item.answerer?.full_name) {
          doc.fontSize(7).fillColor(MUTED).text(`${item.answerer.full_name} — ${formatDateTime(item.answered_at)}`, PAGE_MARGIN + 12, doc.y + 1, { width: CONTENT_WIDTH - 12 });
        }
        doc.moveDown(0.6);
      });
    }

    if (linkedProcedures.length > 0) {
      drawSectionTitle(doc, '5. Procédures liées');
      linkedProcedures.forEach((procedure) => {
        doc.fontSize(10).fillColor(INK).text(`• ${procedure.number} — ${procedure.title}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      });
    }

    // Pied de page numéroté — même construction que capaPdf.js.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, { width: CONTENT_WIDTH, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
