import ExcelJS from 'exceljs';
import { CHECKLIST_ANSWER_LABELS, summarizeChecklist } from './auditChecklist.js';

// Mêmes teintes que listReportXlsx.js/kpiReportXlsx.js.
const INK_ARGB = 'FF1E293B';
const MUTED_ARGB = 'FF64748B';
const HEADER_FILL_ARGB = 'FFF1F5F9';
const BORDER_ARGB = 'FFE2E8F0';
const ANSWER_ARGB = { conform: 'FF047857', nonconform: 'FFB91C1C', na: MUTED_ARGB };
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };

const STATUS_LABELS = { planned: 'Planifié', in_progress: 'En cours', completed: 'Terminé', closed: 'Clôturé' };
const TYPE_LABELS = { process: 'Processus', product: 'Produit', system: 'Système' };
const FINDING_LABELS = { major_nc: 'Non-conformité majeure', minor_nc: 'Non-conformité mineure', observation: 'Remarque', strength: 'Point fort' };
const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : '');

function style(cell, { header = false } = {}) {
  cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  cell.alignment = { vertical: 'top', wrapText: true };
  if (header) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
    cell.font = { bold: true, color: { argb: INK_ARGB } };
  }
}

function addTable(sheet, headers, rows, widths) {
  sheet.columns = widths.map((width) => ({ width }));
  const headerRow = sheet.addRow(headers);
  headerRow.eachCell((cell) => style(cell, { header: true }));
  rows.forEach((values) => sheet.addRow(values).eachCell((cell) => style(cell)));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + rows.length, column: headers.length } };
}

// Classeur d'un audit : onglet « Audit » (faits, qualification, taux de conformité), « Constats » et
// « Check-list » (une ligne par question, filtrable/triable) — jamais tout dans une seule ligne.
export async function buildAuditXlsx({ audit, findings, checklistItems, linkedProcedures, qualificationText }) {
  const workbook = new ExcelJS.Workbook();
  const summary = summarizeChecklist(checklistItems);

  const facts = [
    ['Titre', audit.title],
    ['Type', TYPE_LABELS[audit.audit_type] || audit.audit_type],
    ['Statut', STATUS_LABELS[audit.status] || audit.status],
    ['Date planifiée', formatDate(audit.planned_date)],
    ['Date de réalisation', formatDate(audit.completed_date)],
    ['Service audité', audit.service?.name || ''],
    ['Auditeur', audit.lead?.full_name || 'À désigner'],
    ["Qualification de l'auditeur", audit.lead ? qualificationText || '' : ''],
    ['Dossier', audit.category?.name || ''],
    ['Périmètre', audit.scope || ''],
    ['Conclusion', audit.conclusion || ''],
    ['Procédures liées', linkedProcedures.map((procedure) => `${procedure.number} — ${procedure.title}`).join('\n')],
    ['Constats', findings.length],
    ['Questions de la check-list', summary.total],
    ['Questions répondues', summary.answered],
    ['Conformes', summary.conform],
    ['Non conformes', summary.nonconform],
    ['Sans objet', summary.na],
    ['Taux de conformité (%)', summary.conformity_percent === null ? '' : summary.conformity_percent],
  ];
  const auditSheet = workbook.addWorksheet('Audit');
  addTable(auditSheet, ['Champ', 'Valeur'], facts, [30, 80]);
  auditSheet.eachRow((row, index) => index > 1 && (row.getCell(1).font = { bold: true, color: { argb: INK_ARGB } }));

  addTable(
    workbook.addWorksheet('Constats'),
    ['Type', 'Constat', 'CAPA liée'],
    findings.map((finding) => [FINDING_LABELS[finding.type] || finding.type, finding.description, finding.linked_capa ? `${finding.linked_capa.number} — ${finding.linked_capa.title}` : '']),
    [26, 80, 40]
  );

  const checklistSheet = workbook.addWorksheet('Check-list');
  addTable(
    checklistSheet,
    ['N°', 'Question', 'Réponse', 'Observation', 'Répondu par', 'Répondu le', 'Source'],
    checklistItems.map((item, index) => [
      index + 1,
      item.question,
      item.answer ? CHECKLIST_ANSWER_LABELS[item.answer] : 'Non répondue',
      item.observation || '',
      item.answerer?.full_name || '',
      item.answered_at ? new Date(item.answered_at).toLocaleString('fr-FR') : '',
      item.source === 'ai' ? 'IA' : 'Manuelle',
    ]),
    [6, 70, 16, 50, 22, 20, 12]
  );
  checklistItems.forEach((item, index) => {
    if (item.answer) checklistSheet.getRow(index + 2).getCell(3).font = { bold: true, color: { argb: ANSWER_ARGB[item.answer] } };
  });

  return workbook.xlsx.writeBuffer();
}
