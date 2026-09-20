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
import { logoImageRun, dataUrlImageRun } from './wordLogo.js';
import { ACTION_STATUS_LABELS, REVIEW_TEXT_SECTIONS, buildInputBlocks, describeValidation, formatReviewDate } from './managementReviewContent.js';

const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const BORDER = 'D9D9D9';
const GOOD = '047857';
const BAD = 'B91C1C';
const AMBER = 'B45309';
const SKY = '0369A1';
const HEADER_WIDTH_DXA = 9026;
const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };
const STATUS_LABELS = { draft: 'Brouillon', completed: 'Clôturée' };
const STATUS_COLORS = { open: AMBER, in_progress: SKY, done: GOOD, cancelled: MUTED };
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

const heading = (text) => new Paragraph({ spacing: { before: 320, after: 80 }, keepNext: true, children: [new TextRun({ text, bold: true, size: 26, color: INK })] });

function textBlock(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return [new Paragraph({ children: [new TextRun({ text: 'Non renseigné.', italics: true, color: MUTED, size: 20 })] })];
  return value.split(/\r?\n/).map((line) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: line, size: 20 })] }));
}

function actionsTable(actions) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: dxa([5, 39, 17, 13, 14, 12]),
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          cell('N°', { header: true, widthPct: 5 }),
          cell('Action', { header: true, widthPct: 39 }),
          cell('Responsable', { header: true, widthPct: 17 }),
          cell('Échéance', { header: true, widthPct: 13 }),
          cell('Statut', { header: true, widthPct: 14 }),
          cell('CAPA liée', { header: true, widthPct: 12 }),
        ],
      }),
      ...actions.map((action, index) => {
        const status = action.effective_status || action.status;
        return new TableRow({
          cantSplit: true,
          children: [
            cell(index + 1, { widthPct: 5 }),
            cell(action.description, { widthPct: 39 }),
            cell(action.owner_user?.full_name || '—', { widthPct: 17 }),
            cell(action.due_date ? `${formatReviewDate(action.due_date)}${action.is_overdue ? '\n(dépassée)' : ''}` : '—', { widthPct: 13, color: action.is_overdue ? BAD : undefined }),
            cell(`${ACTION_STATUS_LABELS[status] || status}${action.status_derived ? '\n(via la CAPA)' : ''}`, { widthPct: 14, bold: true, color: STATUS_COLORS[status] }),
            cell(action.linked_capa?.number || '—', { widthPct: 12 }),
          ],
        });
      }),
    ],
  });
}

// Compte rendu Word d'une revue de direction : le document présenté au certificateur.
export async function buildManagementReviewWord({ tenantName, tenantLogo, review, previousReview, generatedBy }) {
  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — Revue de direction ${review.title}`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({ spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: HEADER_WIDTH_DXA }], children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle] })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const facts = [
    ['Date de la revue', formatReviewDate(review.review_date)],
    ['Statut', STATUS_LABELS[review.status] || review.status],
    ['Période analysée', review.period_start && review.period_end ? `${formatReviewDate(review.period_start)} → ${formatReviewDate(review.period_end)}` : 'Non définie'],
    ['Participants', review.participants || '—'],
    ['Dossier', review.category?.name || '—'],
  ];

  const blocks = buildInputBlocks(review);
  let number = 1;
  const body = [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Revue de direction', bold: true, size: 32, color: INK })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: review.title, size: 24, color: MUTED })] }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: dxa([30, 70]),
      layout: TableLayoutType.FIXED,
      rows: facts.map(([label, value]) => new TableRow({ children: [cell(label, { header: true, widthPct: 30 }), cell(value, { widthPct: 70 })] })),
    }),

    heading(`${number++}. Éléments d'entrée`),
    ...(blocks.length === 0
      ? textBlock('')
      : blocks.flatMap((block) => [
          new Paragraph({ spacing: { before: 120, after: 40 }, keepNext: true, children: [new TextRun({ text: block.title, bold: true, size: 21, color: INK })] }),
          ...block.lines.map((line) => new Paragraph({ spacing: { after: 30 }, indent: { left: 240 }, children: [new TextRun({ text: `• ${line}`, size: 20 })] })),
        ])),

    heading(`${number++}. Statut des actions de la revue précédente`),
    ...(previousReview
      ? [
          new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: `Revue précédente : ${previousReview.title} (${formatReviewDate(previousReview.review_date)})`, size: 20, color: MUTED })] }),
          ...(previousReview.actions.length === 0 ? textBlock('Aucune action décidée lors de cette revue.') : [actionsTable(previousReview.actions)]),
          new Paragraph({ spacing: { after: 80 }, children: [] }),
        ]
      : []),
    ...textBlock(review.previous_actions_status),

    ...REVIEW_TEXT_SECTIONS.filter((section) => section.key !== 'previous_actions_status').flatMap(({ key, title }) => [heading(`${number++}. ${title}`), ...textBlock(review[key])]),

    heading(`${number++}. Actions décidées (${review.actions.length})`),
    ...(review.actions.length === 0 ? textBlock('') : [actionsTable(review.actions)]),

    ...(review.validation
      ? [
          heading(`${number++}. Validation de la direction`),
          ...textBlock(describeValidation(review.validation)),
          ...(dataUrlImageRun(review.validation.signature, { maxWidth: 200, maxHeight: 80 })
            ? [new Paragraph({ spacing: { before: 80, after: 80 }, children: [dataUrlImageRun(review.validation.signature, { maxWidth: 200, maxHeight: 80 })] })]
            : []),
        ]
      : []),

    new Paragraph({ spacing: { before: 320 }, children: [new TextRun({ text: `Document généré par ${generatedBy || 'Utilisateur inconnu'} le ${new Date().toLocaleString('fr-FR')}`, italics: true, size: 16, color: MUTED })] }),
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
                  new TextRun({ text: 'Page ', size: 16, color: MUTED }),
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
