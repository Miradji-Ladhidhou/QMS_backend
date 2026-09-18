import ExcelJS from 'exceljs';
import { buildSeriesInfo, computeRecentAverage, getKpiStatus } from './kpiReportPdf.js';

// Mêmes teintes que listReportXlsx.js/pdfTheme.js — identité visuelle cohérente entre le PDF et
// l'Excel d'un même rapport.
const INK_ARGB = 'FF1E293B';
const MUTED_ARGB = 'FF64748B';
const HEADER_FILL_ARGB = 'FFF1F5F9';
const BORDER_ARGB = 'FFE2E8F0';
const GOOD_ARGB = 'FF10B981';
const BAD_ARGB = 'FFEF4444';
const THIN_BORDER = { style: 'thin', color: { argb: BORDER_ARGB } };
const STATUS_LABELS = { good: 'Objectif atteint', bad: 'Objectif non atteint', neutral: "Pas d'objectif défini" };
const STATUS_ARGB = { good: GOOD_ARGB, bad: BAD_ARGB, neutral: MUTED_ARGB };

function headerRow(sheet, rowNumber, labels) {
  const row = sheet.getRow(rowNumber);
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = label;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
    cell.font = { bold: true, color: { argb: INK_ARGB } };
    cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  });
  row.commit();
}

function titleRow(sheet, rowNumber, columnCount, text) {
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = text;
  if (columnCount > 1) sheet.mergeCells(rowNumber, 1, rowNumber, columnCount);
  row.getCell(1).font = { bold: true, size: 14, color: { argb: INK_ARGB } };
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
  row.height = 22;
  row.commit();
}

// Feuille "Synthèse" — même contenu que la page de synthèse du PDF (drawSummaryPage,
// kpiReportPdf.js) : une ligne par KPI, moyenne des dernières périodes (voir
// computeRecentAverage/KPI_RECENT_WINDOW) et statut par rapport à l'objectif. "Plusieurs
// séries" plutôt qu'une fausse moyenne pour un KPI multi-séries — même choix que le PDF, une
// moyenne unique mélangerait des séries sans rapport entre elles (voir buildSeriesInfo).
function addSummarySheet(workbook, kpis) {
  const sheet = workbook.addWorksheet('Synthèse');
  sheet.columns = [{ width: 40 }, { width: 18 }, { width: 18 }, { width: 22 }];
  titleRow(sheet, 1, 4, 'Synthèse des indicateurs qualité (KPI)');
  headerRow(sheet, 2, ['KPI', 'Moyenne', 'Objectif', 'Statut']);

  kpis.forEach((kpi, i) => {
    const rowNumber = 3 + i;
    const records = [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));
    const targetDirection = kpi.target_direction || 'min';
    const hasTarget = kpi.target !== null && kpi.target !== undefined;
    const { showMultiSeries } = buildSeriesInfo(kpi);
    const averageValue = computeRecentAverage(records);
    const status = showMultiSeries ? null : getKpiStatus(averageValue, kpi.target, targetDirection);

    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = kpi.name;
    row.getCell(2).value = showMultiSeries ? 'Plusieurs séries' : averageValue !== null ? `${averageValue} ${kpi.unit || ''}`.trim() : null;
    row.getCell(3).value = hasTarget ? `${targetDirection === 'max' ? '<=' : '>='} ${kpi.target} ${kpi.unit || ''}`.trim() : null;
    row.getCell(4).value = status ? STATUS_LABELS[status] : null;
    if (status) row.getCell(4).font = { color: { argb: STATUS_ARGB[status] }, bold: true };
    row.eachCell((cell) => {
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
    });
    row.commit();
  });

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2 + kpis.length, column: 4 } };
}

// Feuille "Détail" — une ligne par relevé, tous KPI confondus (contrairement au PDF, qui ne
// montre qu'une fenêtre récente par souci de place à l'impression) : c'est tout l'intérêt d'un
// classeur par rapport à un PDF, l'historique complet reste consultable/filtrable/triable.
// Colonne Série vide pour un KPI mono-série (pas de libellé de série à afficher).
function addDetailSheet(workbook, kpis) {
  const sheet = workbook.addWorksheet('Détail');
  sheet.columns = [{ width: 32 }, { width: 20 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 50 }];
  titleRow(sheet, 1, 6, 'Détail des relevés');
  headerRow(sheet, 2, ['KPI', 'Série', 'Période', 'Valeur', 'Source', 'Commentaire']);

  let rowNumber = 3;
  kpis.forEach((kpi) => {
    const { showMultiSeries, seriesList } = buildSeriesInfo(kpi);
    const entries = showMultiSeries
      ? seriesList.flatMap((series) => series.records.map((record) => ({ record, seriesLabel: series.label })))
      : [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1)).map((record) => ({ record, seriesLabel: null }));

    entries.forEach(({ record, seriesLabel }) => {
      const row = sheet.getRow(rowNumber);
      row.getCell(1).value = kpi.name;
      row.getCell(2).value = seriesLabel;
      row.getCell(3).value = record.period_date;
      row.getCell(4).value = record.value;
      row.getCell(5).value = record.source === 'import' ? 'Import' : 'Manuelle';
      row.getCell(6).value = record.comment || null;
      row.eachCell((cell) => {
        cell.border = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
      });
      row.commit();
      rowNumber += 1;
    });
  });

  sheet.views = [{ state: 'frozen', ySplit: 2 }];
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: rowNumber - 1, column: 6 } };
}

export async function buildKpiReportXlsx({ kpis }) {
  const workbook = new ExcelJS.Workbook();
  addSummarySheet(workbook, kpis);
  addDetailSheet(workbook, kpis);
  return workbook.xlsx.writeBuffer();
}
