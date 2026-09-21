import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Header,
  Footer,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  PageNumber,
  WidthType,
  ShadingType,
  VerticalAlign,
  TabStopType,
  TableLayoutType,
} from 'docx';
import { logoImageRun } from './wordLogo.js';
import {
  CRITICALITY_LABELS,
  DECISION_LABELS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_STATE_LABELS,
  SUPPLIER_STATUS_LABELS,
  describeWeights,
  formatDate,
} from './supplierLabels.js';

const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const BORDER = 'D9D9D9';
const GOOD = '047857';
const BAD = 'B91C1C';
const WARN = 'B45309';
const HEADER_WIDTH_DXA = 9026;
const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };
const DECISION_COLORS = { maintained: GOOD, under_watch: WARN, to_replace: BAD };
const DOCUMENT_STATE_COLORS = { valid: GOOD, expiring: WARN, expired: BAD, no_expiry: MUTED };

const dxa = (percentages) => percentages.map((pct) => Math.round((pct / 100) * HEADER_WIDTH_DXA));

function cell(text, { header = false, bold = false, color, widthPct } = {}) {
  return new TableCell({
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: CELL_BORDERS,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: String(text ?? '')
      .split('\n')
      .map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: header || bold, color: color || (header ? INK : undefined), size: 20 })] })),
  });
}

function heading(text) {
  return new Paragraph({ spacing: { before: 320, after: 80 }, keepNext: true, children: [new TextRun({ text, bold: true, size: 26, color: INK })] });
}

function note(text) {
  return new Paragraph({ children: [new TextRun({ text, italics: true, color: MUTED, size: 20 })] });
}

function table(columns, rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: dxa(columns.map((column) => column.width)),
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: columns.map((column) => cell(column.label, { header: true, widthPct: column.width })) }),
      ...rows.map((row) => new TableRow({ cantSplit: true, children: columns.map((column, i) => cell(row[i].text, { ...row[i], widthPct: column.width })) })),
    ],
  });
}

// Fiche Word d'un fournisseur : mêmes rubriques que supplierPdf.js (la courbe des notes n'existe que dans le PDF ; le
// tableau des évaluations porte les mêmes chiffres).
export async function buildSupplierWord({ supplier, evaluations, documents, policy, tenantName, tenantLogo }) {
  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — Fournisseur ${supplier.name}`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({ spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: HEADER_WIDTH_DXA }], children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle] })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const latest = evaluations[evaluations.length - 1] || null;
  const facts = [
    ['Catégorie', supplier.category || '—'],
    ['Criticité', CRITICALITY_LABELS[supplier.criticality] || supplier.criticality],
    ['Statut', SUPPLIER_STATUS_LABELS[supplier.status] || supplier.status],
    ['Service concerné', supplier.service?.name || '—'],
    ['Responsable du suivi', supplier.owner_user?.full_name || 'Non désigné'],
    ['Contact', [supplier.contact_name, supplier.contact_email, supplier.contact_phone].filter(Boolean).join(' · ') || '—'],
    ['Dernière évaluation', latest ? `${formatDate(latest.evaluation_date)} — ${Number(latest.score).toFixed(2)}/5 — ${DECISION_LABELS[latest.decision]}` : 'Jamais évalué'],
    ['Prochaine évaluation', `${formatDate(supplier.next_evaluation_date)} (tous les ${policy.frequency_months} mois pour cette criticité)`],
    ['Seuils de décision', `sous surveillance sous ${policy.thresholds.watch}/5, à remplacer sous ${policy.thresholds.replace}/5`],
    ['Poids des critères', describeWeights(policy.weights)],
  ];

  const body = [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Fiche fournisseur', bold: true, size: 32, color: INK })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: supplier.name, size: 24, color: MUTED })] }),
    table([{ label: 'Information', width: 30 }, { label: 'Valeur', width: 70 }], facts.map(([label, value]) => [{ text: label, bold: true }, { text: value }])),

    heading(`Évaluations (${evaluations.length})`),
    ...(evaluations.length === 0
      ? [note('Aucune évaluation.')]
      : [
          table(
            [
              { label: 'Date', width: 12 },
              { label: 'Q / D / P / R', width: 14 },
              { label: 'Note', width: 10 },
              { label: 'Décision', width: 16 },
              { label: 'Évaluateur, poids, commentaire', width: 48 },
            ],
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
          ),
        ]),

    heading(`Certificats et pièces (${documents.length})`),
    ...(documents.length === 0
      ? [note('Aucun certificat ni pièce enregistré.')]
      : [
          table(
            [
              { label: 'Document', width: 30 },
              { label: 'Type', width: 20 },
              { label: 'Référence', width: 20 },
              { label: 'Expire le', width: 14 },
              { label: 'État', width: 16 },
            ],
            documents.map((document) => [
              { text: `${document.title}${document.issuer ? `\n${document.issuer}` : ''}` },
              { text: DOCUMENT_KIND_LABELS[document.kind] || document.kind },
              { text: document.reference || '' },
              { text: document.expires_on ? formatDate(document.expires_on) : '—' },
              { text: DOCUMENT_STATE_LABELS[document.state], bold: true, color: DOCUMENT_STATE_COLORS[document.state] },
            ])
          ),
        ]),
  ];

  const doc = new Document({
    sections: [
      {
        headers: { default: new Header({ children: [header] }) },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: 'Fiche fournisseur  ·  Page ', size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
                  new TextRun({ text: ' / ', size: 16, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children: body,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
