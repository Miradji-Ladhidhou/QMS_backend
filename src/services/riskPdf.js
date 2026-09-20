import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, drawLetterheadHeader } from './pdfTheme.js';
import { CONTENT_WIDTH, PAGE_MARGIN, PAGE_WIDTH, drawTable, ensureSpace } from './pdfSimpleTable.js';
import {
  CAPA_STATUS_LABELS,
  RISK_STATUS_LABELS,
  RISK_TYPE_LABELS,
  acceptabilityText,
  describeScore,
  formatRiskDate,
  formatRiskDateTime,
} from './riskLabels.js';

const GOOD = '#047857';
const BAD = '#b91c1c';

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 70);
  doc.moveDown(0.6);
  doc.font('Body-Bold').fontSize(12).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

function drawParagraph(doc, text) {
  doc.fontSize(10).fillColor(text ? INK : MUTED).text(text || 'Non renseigné.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
}

// Fiche imprimable d'un seul risque : identité, cotation brute et résiduelle, verdict d'acceptabilité,
// mesures, CAPA liée, liens et historique de cotation. Même contenu que riskWord.js.
export function buildRiskPdf({ risk, assessments, links, threshold, tenantName, tenantLogo, tenantTimezone }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `${RISK_TYPE_LABELS[risk.type] || 'Risque'} — ${risk.title}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(16).fillColor(INK).text(risk.title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.6);

    drawTable(doc, [{ width: 0.3 }, { width: 0.7 }], ['Information', 'Valeur'], [
      ['Type', RISK_TYPE_LABELS[risk.type] || risk.type],
      ['Statut', RISK_STATUS_LABELS[risk.status] || risk.status],
      ['Catégorie', risk.category || '—'],
      ['Service', risk.service?.name || '—'],
      ['Responsable', risk.owner_user?.full_name || 'Non assigné'],
      ['Prochaine revue', formatRiskDate(risk.review_date, tenantTimezone)],
      [
        'Dernière revue',
        risk.last_reviewed_at ? `${formatRiskDate(risk.last_reviewed_at, tenantTimezone)}${risk.last_reviewed_by_name ? ` — ${risk.last_reviewed_by_name}` : ''}` : 'Jamais revu',
      ],
    ].map(([label, value]) => [{ text: label, bold: true }, { text: value }]));

    drawSectionTitle(doc, 'Cotation');
    drawTable(doc, [{ width: 0.3 }, { width: 0.7 }], ['Évaluation', 'Probabilité × gravité = score'], [
      [{ text: 'Cotation brute', bold: true }, { text: describeScore(risk.likelihood, risk.impact) }],
      [{ text: 'Cotation résiduelle', bold: true }, { text: describeScore(risk.residual_likelihood, risk.residual_impact) }],
      [
        { text: 'Acceptabilité', bold: true },
        { text: acceptabilityText(risk, threshold), bold: risk.type === 'risk', color: risk.is_unacceptable ? BAD : risk.type === 'risk' ? GOOD : undefined },
      ],
    ]);

    drawSectionTitle(doc, 'Description');
    drawParagraph(doc, risk.description);
    drawSectionTitle(doc, 'Mesures de maîtrise actuelles');
    drawParagraph(doc, risk.current_controls);
    drawSectionTitle(doc, 'Plan de traitement');
    drawParagraph(doc, risk.treatment_plan);

    drawSectionTitle(doc, 'CAPA liée');
    drawParagraph(doc, risk.linked_capa ? `${risk.linked_capa.number} — ${risk.linked_capa.title} (statut : ${CAPA_STATUS_LABELS[risk.linked_capa.status] || risk.linked_capa.status})` : 'Aucune CAPA liée.');

    drawSectionTitle(doc, 'Éléments liés');
    if (links.length === 0) {
      drawParagraph(doc, 'Aucun élément lié.');
    } else {
      drawTable(doc, [{ width: 0.25 }, { width: 0.75 }], ['Type', 'Élément'], links.map((link) => [{ text: link.kind_label }, { text: link.title }]));
    }

    drawSectionTitle(doc, `Historique de cotation (${assessments.length})`);
    if (assessments.length === 0) {
      drawParagraph(doc, 'Aucun historique.');
    } else {
      drawTable(
        doc,
        [{ width: 0.16 }, { width: 0.2 }, { width: 0.2 }, { width: 0.14 }, { width: 0.3 }],
        ['Date', 'Cotation brute', 'Résiduelle', 'Statut', 'Motif / par'],
        assessments.map((entry) => [
          { text: formatRiskDateTime(entry.assessed_at, tenantTimezone) },
          { text: describeScore(entry.likelihood, entry.impact) },
          { text: describeScore(entry.residual_likelihood, entry.residual_impact) },
          { text: RISK_STATUS_LABELS[entry.status] || entry.status },
          { text: [entry.reason, entry.assessed_by_user?.full_name].filter(Boolean).join(' — ') || '—' },
        ])
      );
    }

    // Pied de page numéroté avec la date d'édition.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Fiche risque  ·  Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, { width: CONTENT_WIDTH, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
