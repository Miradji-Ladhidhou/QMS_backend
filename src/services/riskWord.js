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
import { CAPA_STATUS_LABELS, RISK_STATUS_LABELS, RISK_TYPE_LABELS, acceptabilityText, describeScore, formatRiskDate, formatRiskDateTime } from './riskLabels.js';

const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const BORDER = 'D9D9D9';
const GOOD = '047857';
const BAD = 'B91C1C';
const HEADER_WIDTH_DXA = 9026;

const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

// Largeurs fixes en dxa : voir auditWord.js (les pourcentages de cellule sont parfois ignorés).
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

function textBlock(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return [new Paragraph({ children: [new TextRun({ text: 'Non renseigné.', italics: true, color: MUTED, size: 20 })] })];
  return value.split(/\r?\n/).map((line) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: line, size: 20 })] }));
}

function factsTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: dxa([30, 70]),
    layout: TableLayoutType.FIXED,
    rows: rows.map(([label, value, color]) => new TableRow({ cantSplit: true, children: [cell(label, { header: true, widthPct: 30 }), cell(value, { widthPct: 70, color, bold: Boolean(color) })] })),
  });
}

// Fiche Word d'un seul risque : mêmes rubriques que riskPdf.js.
export async function buildRiskWord({ risk, assessments, links, threshold, tenantName, tenantLogo, tenantTimezone }) {
  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — ${RISK_TYPE_LABELS[risk.type] || 'Risque'} ${risk.title}`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({ spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: HEADER_WIDTH_DXA }], children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle] })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const verdictColor = risk.type === 'risk' ? (risk.is_unacceptable ? BAD : GOOD) : undefined;

  const body = [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `Fiche ${risk.type === 'opportunity' ? 'opportunité' : 'risque'}`, bold: true, size: 32, color: INK })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: risk.title, size: 24, color: MUTED })] }),
    factsTable([
      ['Type', RISK_TYPE_LABELS[risk.type] || risk.type],
      ['Statut', RISK_STATUS_LABELS[risk.status] || risk.status],
      ['Catégorie', risk.category || '—'],
      ['Service', risk.service?.name || '—'],
      ['Responsable', risk.owner_user?.full_name || 'Non assigné'],
      ['Prochaine revue', formatRiskDate(risk.review_date, tenantTimezone)],
      ['Dernière revue', risk.last_reviewed_at ? `${formatRiskDate(risk.last_reviewed_at, tenantTimezone)}${risk.last_reviewed_by_name ? ` — ${risk.last_reviewed_by_name}` : ''}` : 'Jamais revu'],
    ]),

    heading('Cotation'),
    factsTable([
      ['Cotation brute', describeScore(risk.likelihood, risk.impact)],
      ['Cotation résiduelle', describeScore(risk.residual_likelihood, risk.residual_impact)],
      ['Acceptabilité', acceptabilityText(risk, threshold), verdictColor],
    ]),

    heading('Description'),
    ...textBlock(risk.description),
    heading('Mesures de maîtrise actuelles'),
    ...textBlock(risk.current_controls),
    heading('Plan de traitement'),
    ...textBlock(risk.treatment_plan),
    heading('CAPA liée'),
    ...textBlock(risk.linked_capa ? `${risk.linked_capa.number} — ${risk.linked_capa.title} (statut : ${CAPA_STATUS_LABELS[risk.linked_capa.status] || risk.linked_capa.status})` : 'Aucune CAPA liée.'),

    heading('Éléments liés'),
    ...(links.length === 0
      ? textBlock('Aucun élément lié.')
      : [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: dxa([25, 75]),
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({ tableHeader: true, cantSplit: true, children: [cell('Type', { header: true, widthPct: 25 }), cell('Élément', { header: true, widthPct: 75 })] }),
              ...links.map((link) => new TableRow({ cantSplit: true, children: [cell(link.kind_label, { widthPct: 25 }), cell(link.title, { widthPct: 75 })] })),
            ],
          }),
        ]),

    heading(`Historique de cotation (${assessments.length})`),
    ...(assessments.length === 0
      ? textBlock('Aucun historique.')
      : [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: dxa([16, 20, 20, 14, 30]),
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({
                tableHeader: true,
                cantSplit: true,
                children: [
                  cell('Date', { header: true, widthPct: 16 }),
                  cell('Cotation brute', { header: true, widthPct: 20 }),
                  cell('Résiduelle', { header: true, widthPct: 20 }),
                  cell('Statut', { header: true, widthPct: 14 }),
                  cell('Motif / par', { header: true, widthPct: 30 }),
                ],
              }),
              ...assessments.map(
                (entry) =>
                  new TableRow({
                    cantSplit: true,
                    children: [
                      cell(formatRiskDateTime(entry.assessed_at, tenantTimezone), { widthPct: 16 }),
                      cell(describeScore(entry.likelihood, entry.impact), { widthPct: 20 }),
                      cell(describeScore(entry.residual_likelihood, entry.residual_impact), { widthPct: 20 }),
                      cell(RISK_STATUS_LABELS[entry.status] || entry.status, { widthPct: 14 }),
                      cell([entry.reason, entry.assessed_by_user?.full_name].filter(Boolean).join(' — ') || '—', { widthPct: 30 }),
                    ],
                  })
              ),
            ],
          }),
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
                  new TextRun({ text: 'Fiche risque  ·  Page ', size: 16, color: MUTED }),
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
