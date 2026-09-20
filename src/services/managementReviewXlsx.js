import ExcelJS from 'exceljs';
import { ACTION_STATUS_LABELS, REVIEW_TEXT_SECTIONS, buildInputBlocks, describeValidation, formatReviewDate } from './managementReviewContent.js';

const INK_ARGB = 'FF1E293B';
const HEADER_FILL_ARGB = 'FFF1F5F9';
const BORDER_ARGB = 'FFE2E8F0';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };
const STATUS_LABELS = { draft: 'Brouillon', completed: 'Clôturée' };
const SOURCE_LABELS = { manual: 'Manuelle', ai: 'IA' };

function style(cell, header = false) {
  cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  cell.alignment = { vertical: 'top', wrapText: true };
  if (header) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
    cell.font = { bold: true, color: { argb: INK_ARGB } };
  }
}

function addTable(sheet, headers, rows, widths) {
  sheet.columns = widths.map((width) => ({ width }));
  sheet.addRow(headers).eachCell((cell) => style(cell, true));
  rows.forEach((values) => sheet.addRow(values).eachCell((cell) => style(cell)));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: headers.length } };
}

const actionRow = (action, index) => [
  index + 1,
  action.description,
  action.owner_user?.full_name || '',
  action.due_date ? formatReviewDate(action.due_date) : '',
  ACTION_STATUS_LABELS[action.effective_status || action.status] || action.status,
  action.is_overdue ? 'Oui' : '',
  action.linked_capa ? `${action.linked_capa.number} — ${action.linked_capa.title}` : '',
  action.completed_at ? new Date(action.completed_at).toLocaleDateString('fr-FR') : '',
  SOURCE_LABELS[action.source] || '',
];
const ACTION_HEADERS = ['N°', 'Action', 'Responsable', 'Échéance', 'Statut', 'En retard', 'CAPA liée', 'Réalisée le', 'Source'];
const ACTION_WIDTHS = [6, 60, 24, 14, 14, 10, 40, 14, 10];

// Classeur d'une revue : onglets Revue (faits + rubriques), Entrées, Actions et Revue précédente.
export async function buildManagementReviewXlsx({ review, previousReview }) {
  const workbook = new ExcelJS.Workbook();

  const facts = [
    ['Titre', review.title],
    ['Date de la revue', formatReviewDate(review.review_date)],
    ['Statut', STATUS_LABELS[review.status] || review.status],
    ['Période analysée', review.period_start && review.period_end ? `${formatReviewDate(review.period_start)} → ${formatReviewDate(review.period_end)}` : ''],
    ['Participants', review.participants || ''],
    ['Dossier', review.category?.name || ''],
    ...REVIEW_TEXT_SECTIONS.map(({ key, title }) => [title, review[key] || '']),
    ['Actions décidées', review.actions.length],
    ['Validation de la direction', describeValidation(review.validation) || 'Non validée'],
  ];
  const reviewSheet = workbook.addWorksheet('Revue');
  addTable(reviewSheet, ['Champ', 'Contenu'], facts, [40, 100]);
  reviewSheet.eachRow((row, index) => index > 1 && (row.getCell(1).font = { bold: true, color: { argb: INK_ARGB } }));

  addTable(
    workbook.addWorksheet('Entrées'),
    ['Rubrique', 'Détail'],
    buildInputBlocks(review).flatMap((block) => (block.lines.length === 0 ? [[block.title, '']] : block.lines.map((line) => [block.title, line]))),
    [50, 90]
  );
  addTable(workbook.addWorksheet('Actions'), ACTION_HEADERS, review.actions.map(actionRow), ACTION_WIDTHS);
  addTable(
    workbook.addWorksheet('Revue précédente'),
    ACTION_HEADERS,
    previousReview ? previousReview.actions.map(actionRow) : [],
    ACTION_WIDTHS
  );
  if (previousReview) workbook.getWorksheet('Revue précédente').getCell('K1').value = `${previousReview.title} (${formatReviewDate(previousReview.review_date)})`;

  return workbook.xlsx.writeBuffer();
}
