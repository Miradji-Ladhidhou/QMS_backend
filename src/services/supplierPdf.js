import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, drawLetterheadHeader } from './pdfTheme.js';
import { CONTENT_WIDTH, PAGE_MARGIN, PAGE_WIDTH, drawTable, ensureSpace } from './pdfSimpleTable.js';
import {
  CRITICALITY_LABELS,
  DECISION_LABELS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_STATE_LABELS,
  SUPPLIER_STATUS_LABELS,
  describeWeights,
  formatDate,
} from './supplierLabels.js';

const GOOD = '#047857';
const BAD = '#b91c1c';
const WARN = '#b45309';
const SERIES = [
  { key: 'quality_score', label: 'Qualité', color: '#94a3b8' },
  { key: 'delivery_score', label: 'Délais', color: '#cbd5e1' },
  { key: 'price_score', label: 'Prix', color: '#a5b4fc' },
  { key: 'responsiveness_score', label: 'Réactivité', color: '#fcd34d' },
];
const DECISION_COLORS = { maintained: GOOD, under_watch: WARN, to_replace: BAD };
const DOCUMENT_STATE_COLORS = { valid: GOOD, expiring: WARN, expired: BAD, no_expiry: MUTED };

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 70);
  doc.moveDown(0.6);
  doc.font('Body-Bold').fontSize(12).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

// Courbe des notes (1 à 5) évaluation après évaluation : les quatre critères en traits fins, la note globale en gras,
// les deux seuils de décision en pointillés. Points régulièrement espacés (une évaluation = un point).
function drawScoreChart(doc, evaluations, thresholds) {
  const height = 150;
  const left = PAGE_MARGIN + 26;
  const width = CONTENT_WIDTH - 36;
  ensureSpace(doc, height + 50);
  const top = doc.y + 6;
  const yOf = (score) => top + height - ((score - 1) / 4) * height;
  const xOf = (index) => (evaluations.length === 1 ? left + width / 2 : left + (index / (evaluations.length - 1)) * width);

  doc.lineWidth(0.5).strokeColor(RULE_LIGHT);
  for (let score = 1; score <= 5; score += 1) {
    doc.moveTo(left, yOf(score)).lineTo(left + width, yOf(score)).stroke();
    doc.fontSize(7).fillColor(MUTED).text(String(score), PAGE_MARGIN, yOf(score) - 3, { width: 20, align: 'right' });
  }
  for (const [value, color, label] of [[thresholds.watch, WARN, 'sous surveillance'], [thresholds.replace, BAD, 'à remplacer']]) {
    doc.save().dash(4, { space: 3 }).lineWidth(0.8).strokeColor(color).moveTo(left, yOf(value)).lineTo(left + width, yOf(value)).stroke().undash().restore();
    doc.fontSize(6.5).fillColor(color).text(`${label} < ${value}`, left + width - 92, yOf(value) - 8, { width: 92, align: 'right' });
  }

  const drawLine = (values, color, lineWidth, dotRadius) => {
    doc.lineWidth(lineWidth).strokeColor(color);
    values.forEach((value, index) => (index === 0 ? doc.moveTo(xOf(index), yOf(value)) : doc.lineTo(xOf(index), yOf(value))));
    doc.stroke();
    values.forEach((value, index) => doc.circle(xOf(index), yOf(value), dotRadius).fillColor(color).fill());
  };
  SERIES.forEach((series) => drawLine(evaluations.map((evaluation) => evaluation[series.key]), series.color, 0.8, 1.6));
  drawLine(evaluations.map((evaluation) => Number(evaluation.score)), '#1F3864', 2, 3);

  // Dates aux extrémités, puis légende.
  doc.fontSize(7).fillColor(MUTED).text(formatDate(evaluations[0].evaluation_date), left - 10, top + height + 4, { width: 90 });
  if (evaluations.length > 1) doc.text(formatDate(evaluations[evaluations.length - 1].evaluation_date), left + width - 80, top + height + 4, { width: 90, align: 'right' });
  let legendX = left;
  const legendY = top + height + 16;
  [{ label: 'Note globale', color: '#1F3864' }, ...SERIES].forEach((item) => {
    doc.rect(legendX, legendY + 2, 8, 3).fillColor(item.color).fill();
    doc.fontSize(7).fillColor(MUTED).text(item.label, legendX + 11, legendY, { lineBreak: false });
    legendX += 22 + item.label.length * 4;
  });
  doc.y = legendY + 14;
  doc.x = PAGE_MARGIN;
}

// Fiche d'un fournisseur : identité, situation d'évaluation, courbe des notes, historique des évaluations (avec les
// poids en vigueur), certificats et pièces avec leur échéance. Même contenu que supplierWord.js.
export function buildSupplierPdf({ supplier, evaluations, documents, policy, tenantName, tenantLogo }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `Fournisseur — ${supplier.name}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    const latest = evaluations[evaluations.length - 1] || null;
    doc.font('Body-Bold').fontSize(16).fillColor(INK).text(supplier.name, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body');
    doc.moveDown(0.6);

    drawTable(doc, [{ width: 0.3 }, { width: 0.7 }], ['Information', 'Valeur'], [
      ['Catégorie', supplier.category || '—'],
      ['Criticité', CRITICALITY_LABELS[supplier.criticality] || supplier.criticality],
      ['Statut', SUPPLIER_STATUS_LABELS[supplier.status] || supplier.status],
      ['Service concerné', supplier.service?.name || '—'],
      ['Responsable du suivi', supplier.owner_user?.full_name || 'Non désigné'],
      ['Contact', [supplier.contact_name, supplier.contact_email, supplier.contact_phone].filter(Boolean).join(' · ') || '—'],
      ['Dernière évaluation', latest ? `${formatDate(latest.evaluation_date)} — ${Number(latest.score).toFixed(2)}/5 — ${DECISION_LABELS[latest.decision]}` : 'Jamais évalué'],
      ['Prochaine évaluation', `${formatDate(supplier.next_evaluation_date)} (tous les ${policy.frequency_months} mois pour cette criticité)`],
    ].map(([label, value]) => [{ text: label, bold: true }, { text: value }]));

    drawSectionTitle(doc, 'Évolution des notes');
    if (evaluations.length === 0) {
      doc.fontSize(10).fillColor(MUTED).text('Aucune évaluation.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    } else {
      drawScoreChart(doc, evaluations, policy.thresholds);
      doc.fontSize(8).fillColor(MUTED).text(`Seuils : sous surveillance sous ${policy.thresholds.watch}/5, à remplacer sous ${policy.thresholds.replace}/5. Poids actuels : ${describeWeights(policy.weights)}.`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    }

    drawSectionTitle(doc, `Évaluations (${evaluations.length})`);
    if (evaluations.length === 0) {
      doc.fontSize(10).fillColor(MUTED).text('Aucune évaluation.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    } else {
      drawTable(
        doc,
        [{ width: 0.12 }, { width: 0.14 }, { width: 0.1 }, { width: 0.21 }, { width: 0.43 }],
        ['Date', 'Q / D / P / R', 'Note', 'Décision', 'Évaluateur, poids, commentaire'],
        [...evaluations].reverse().map((evaluation) => [
          { text: formatDate(evaluation.evaluation_date) },
          { text: `${evaluation.quality_score} / ${evaluation.delivery_score} / ${evaluation.price_score} / ${evaluation.responsiveness_score}` },
          { text: `${Number(evaluation.score).toFixed(2)}/5`, bold: true },
          { text: DECISION_LABELS[evaluation.decision], bold: true, color: DECISION_COLORS[evaluation.decision] },
          {
            text: [
              evaluation.evaluator?.full_name,
              evaluation.weights ? `Poids : ${describeWeights(evaluation.weights)}` : null,
              evaluation.comment,
              evaluation.linked_capa ? `CAPA ${evaluation.linked_capa.number}` : null,
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ])
      );
    }

    drawSectionTitle(doc, `Certificats et pièces (${documents.length})`);
    if (documents.length === 0) {
      doc.fontSize(10).fillColor(MUTED).text('Aucun certificat ni pièce enregistré.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    } else {
      drawTable(
        doc,
        [{ width: 0.26 }, { width: 0.2 }, { width: 0.14 }, { width: 0.16 }, { width: 0.24 }],
        ['Document', 'Type', 'Référence', 'Expire le', 'État'],
        documents.map((document) => [
          { text: `${document.title}${document.issuer ? `\n${document.issuer}` : ''}` },
          { text: DOCUMENT_KIND_LABELS[document.kind] || document.kind },
          { text: document.reference || '' },
          { text: document.expires_on ? formatDate(document.expires_on) : '—' },
          { text: DOCUMENT_STATE_LABELS[document.state], bold: true, color: DOCUMENT_STATE_COLORS[document.state] },
        ])
      );
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Fiche fournisseur  ·  Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, { width: CONTENT_WIDTH, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}
