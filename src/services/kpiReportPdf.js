import PDFDocument from 'pdfkit';

const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const GRID = '#e2e8f0';
const INK = '#1e293b';
const GOOD = '#10b981';
const BAD = '#ef4444';
const NEUTRAL = '#94a3b8';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function formatDateShort(dateStr) {
  return new Date(dateStr).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

// Miroir de getKpiStatus (frontend/src/lib/kpiStatus.js) : neutre si pas d'objectif ou pas
// encore de valeur, sinon atteint/non atteint selon le sens de l'objectif.
function getKpiStatus(lastValue, target, targetDirection) {
  if (lastValue === null || lastValue === undefined || target === null || target === undefined) {
    return 'neutral';
  }
  const meetsTarget = targetDirection === 'max' ? lastValue <= target : lastValue >= target;
  return meetsTarget ? 'good' : 'bad';
}

const STATUS_COLORS = { good: GOOD, bad: BAD, neutral: NEUTRAL };
const STATUS_LABELS = { good: 'Objectif atteint', bad: 'Objectif non atteint', neutral: "Pas d'objectif défini" };

// Puce de couleur pleine + libellé : plus fiable qu'un émoji ✅/⚠️/❌, dont le rendu dépend
// du support des polices du lecteur PDF — un cercle vectoriel s'affiche toujours à l'identique.
function drawStatusDot(doc, x, y, status) {
  doc.circle(x, y, 4).fillColor(STATUS_COLORS[status] || NEUTRAL).fill();
}

// Graphique de tendance minimaliste dessiné à la main (lignes/points vectoriels pdfkit) :
// pas de dépendance à un moteur de rendu externe (canvas natif, chromium...), donc pas de
// risque de build cassé sur l'environnement de déploiement.
function drawTrendChart(doc, { x, y, width, height, records, target }) {
  if (records.length < 2) {
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text('Pas assez de données pour un graphique', x, y + height / 2 - 4, { width, align: 'center' });
    return;
  }

  const values = records.map((r) => r.value);
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (target !== null && target !== undefined) {
    minValue = Math.min(minValue, target);
    maxValue = Math.max(maxValue, target);
  }
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  const margin = (maxValue - minValue) * 0.12;
  minValue -= margin;
  maxValue += margin;

  const plotLeft = x + 28;
  const plotWidth = width - 28;
  const plotTop = y + 2;
  const plotHeight = height - 16;

  const scaleX = (index) =>
    records.length === 1 ? plotLeft + plotWidth / 2 : plotLeft + (index / (records.length - 1)) * plotWidth;
  const scaleY = (value) => plotTop + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight;

  doc.strokeColor(GRID).lineWidth(0.5);
  doc
    .moveTo(plotLeft, plotTop)
    .lineTo(plotLeft, plotTop + plotHeight)
    .lineTo(plotLeft + plotWidth, plotTop + plotHeight)
    .stroke();

  doc.fontSize(6).fillColor(MUTED);
  doc.text(maxValue.toFixed(1), x, plotTop - 2, { width: 26, align: 'right' });
  doc.text(minValue.toFixed(1), x, plotTop + plotHeight - 4, { width: 26, align: 'right' });

  if (target !== null && target !== undefined) {
    const targetY = scaleY(target);
    doc.strokeColor(MUTED).lineWidth(0.5).dash(2, { space: 2 });
    doc
      .moveTo(plotLeft, targetY)
      .lineTo(plotLeft + plotWidth, targetY)
      .stroke();
    doc.undash();
  }

  doc.strokeColor(NAVY).lineWidth(1.3);
  records.forEach((record, index) => {
    const px = scaleX(index);
    const py = scaleY(record.value);
    if (index === 0) doc.moveTo(px, py);
    else doc.lineTo(px, py);
  });
  doc.stroke();

  records.forEach((record, index) => {
    doc.circle(scaleX(index), scaleY(record.value), 1.4).fillColor(NAVY).fill();
  });

  doc.fontSize(6).fillColor(MUTED);
  doc.text(formatDateShort(records[0].period_date), plotLeft - 12, plotTop + plotHeight + 3, {
    width: 44,
    align: 'left',
  });
  doc.text(formatDateShort(records[records.length - 1].period_date), plotLeft + plotWidth - 32, plotTop + plotHeight + 3, {
    width: 44,
    align: 'right',
  });
}

function drawPageHeader(doc, tenantName) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Rapport des indicateurs qualité (KPI)', PAGE_MARGIN, 26);
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;
}

function ensureSpace(doc, tenantName, requiredHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > bottom) {
    doc.addPage();
    drawPageHeader(doc, tenantName);
  }
}

const CHART_HEIGHT = 90;
const RECORD_ROWS_MAX = 12;

function drawKpiSection(doc, tenantName, kpi, detailStats) {
  const records = [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));
  const lastRecords = records.slice(-RECORD_ROWS_MAX);
  const lastRecord = records[records.length - 1];
  const targetDirection = kpi.target_direction || 'min';
  const hasTarget = kpi.target !== null && kpi.target !== undefined;
  const status = getKpiStatus(lastRecord?.value, kpi.target, targetDirection);
  const isRatio = kpi.calculation_type === 'ratio';

  // 32pt titre+objectif avant le graphique, CHART_HEIGHT pour le graphique, puis marge/
  // séparateur/mention d'audit — sous-estimer ce total est ce qui casse la mise en page
  // (une section qui déborde milieu de dessin se retrouve coupée n'importe où sur la page
  // suivante). Mieux vaut sur-estimer largement que de risquer une section tronquée.
  const requiredHeight = 32 + CHART_HEIGHT + 26 + (isRatio ? 14 : 0);
  ensureSpace(doc, tenantName, requiredHeight);

  const sectionTop = doc.y;
  doc.fontSize(12).fillColor(NAVY).text(kpi.name, PAGE_MARGIN, sectionTop, { width: CONTENT_WIDTH - 90 });

  drawStatusDot(doc, PAGE_MARGIN + CONTENT_WIDTH - 6, sectionTop + 6, status);
  doc.fontSize(8).fillColor(STATUS_COLORS[status]).text(STATUS_LABELS[status], PAGE_MARGIN, sectionTop, {
    width: CONTENT_WIDTH - 14,
    align: 'right',
  });

  const targetLine = hasTarget
    ? `Objectif : ${targetDirection === 'max' ? '<=' : '>='} ${kpi.target} ${kpi.unit || ''}`
    : 'Objectif : non défini';
  const lastValueLine = lastRecord ? `Dernière valeur : ${lastRecord.value} ${kpi.unit || ''}` : 'Aucune valeur enregistrée';

  doc.fontSize(9).fillColor('#555555').text(`${targetLine}    —    ${lastValueLine}`, PAGE_MARGIN, sectionTop + 16);

  const chartY = sectionTop + 32;
  drawTrendChart(doc, { x: PAGE_MARGIN, y: chartY, width: 230, height: CHART_HEIGHT, records: lastRecords, target: kpi.target });

  const tableX = PAGE_MARGIN + 250;
  const tableWidth = CONTENT_WIDTH - 250;
  let rowY = chartY;
  doc.fontSize(7).fillColor(MUTED);
  doc.text('Période', tableX, rowY, { width: tableWidth * 0.3 });
  doc.text('Valeur', tableX + tableWidth * 0.3, rowY, { width: tableWidth * 0.3 });
  doc.text('Source', tableX + tableWidth * 0.6, rowY, { width: tableWidth * 0.4 });
  rowY += 9;
  doc
    .moveTo(tableX, rowY)
    .lineTo(tableX + tableWidth, rowY)
    .strokeColor(GRID)
    .lineWidth(0.5)
    .stroke();
  rowY += 3;

  [...lastRecords]
    .reverse()
    .slice(0, 8)
    .forEach((record) => {
      doc.fontSize(7).fillColor(INK);
      doc.text(formatDateShort(record.period_date), tableX, rowY, { width: tableWidth * 0.3 });
      doc.text(`${record.value} ${kpi.unit || ''}`, tableX + tableWidth * 0.3, rowY, { width: tableWidth * 0.3 });
      doc.text(record.source === 'import_csv' ? 'Import CSV' : 'Manuelle', tableX + tableWidth * 0.6, rowY, {
        width: tableWidth * 0.4,
      });
      rowY += 9;
    });

  doc.y = chartY + CHART_HEIGHT + 6;

  if (isRatio) {
    const auditLine =
      detailStats && detailStats.count > 0
        ? `Source : import CSV, ${detailStats.count} ligne${detailStats.count > 1 ? 's' : ''}, dernière mise à jour le ${formatDateShort(detailStats.lastImportedAt)}`
        : 'Source : import CSV — aucun import réalisé pour l\'instant.';
    doc.fontSize(7).fillColor(MUTED).text(auditLine, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.y += 12;
  }

  doc.moveDown(0.4);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(PAGE_MARGIN + CONTENT_WIDTH, doc.y)
    .strokeColor(GRID)
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.8);
}

function drawSummaryPage(doc, tenantName, kpis) {
  doc.addPage();
  drawPageHeader(doc, tenantName);
  doc.fontSize(15).fillColor(NAVY).text('Synthèse', PAGE_MARGIN, doc.y);
  doc.moveDown(0.8);

  const columns = { name: 0.42, value: 0.2, target: 0.23, status: 0.15 };
  let rowY = doc.y;

  function drawHeaderRow() {
    doc.fontSize(8).fillColor(MUTED);
    doc.text('KPI', PAGE_MARGIN, rowY, { width: CONTENT_WIDTH * columns.name });
    doc.text('Dernière valeur', PAGE_MARGIN + CONTENT_WIDTH * columns.name, rowY, { width: CONTENT_WIDTH * columns.value });
    doc.text('Objectif', PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value), rowY, {
      width: CONTENT_WIDTH * columns.target,
    });
    doc.text('Statut', PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value + columns.target), rowY, {
      width: CONTENT_WIDTH * columns.status,
    });
    rowY += 12;
    doc
      .moveTo(PAGE_MARGIN, rowY)
      .lineTo(PAGE_MARGIN + CONTENT_WIDTH, rowY)
      .strokeColor(NAVY)
      .lineWidth(1)
      .stroke();
    rowY += 6;
  }

  drawHeaderRow();

  kpis.forEach((kpi) => {
    if (rowY > doc.page.height - doc.page.margins.bottom - 16) {
      doc.addPage();
      drawPageHeader(doc, tenantName);
      rowY = doc.y;
      drawHeaderRow();
    }

    const records = [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));
    const lastRecord = records[records.length - 1];
    const targetDirection = kpi.target_direction || 'min';
    const hasTarget = kpi.target !== null && kpi.target !== undefined;
    const status = getKpiStatus(lastRecord?.value, kpi.target, targetDirection);

    doc.fontSize(9).fillColor(INK);
    doc.text(kpi.name, PAGE_MARGIN, rowY, { width: CONTENT_WIDTH * columns.name });
    doc.text(lastRecord ? `${lastRecord.value} ${kpi.unit || ''}` : '—', PAGE_MARGIN + CONTENT_WIDTH * columns.name, rowY, {
      width: CONTENT_WIDTH * columns.value,
    });
    doc.text(
      hasTarget ? `${targetDirection === 'max' ? '<=' : '>='} ${kpi.target} ${kpi.unit || ''}` : '—',
      PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value),
      rowY,
      { width: CONTENT_WIDTH * columns.target }
    );
    drawStatusDot(doc, PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value + columns.target) + 6, rowY + 4, status);

    rowY += 16;
  });
}

// Construit le PDF en mémoire (pas de fichier temporaire) : les chunks du flux pdfkit sont
// collectés dans un buffer, résolu à l'évènement 'end' — même pattern que certificatePdf.js.
export function buildKpiReportPdf({ tenantName, kpis, detailStatsByKpi }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawPageHeader(doc, tenantName);

    if (kpis.length === 0) {
      doc.fontSize(10).fillColor(MUTED).text('Aucun KPI configuré pour ce tenant.', PAGE_MARGIN, doc.y);
    } else {
      kpis.forEach((kpi) => {
        drawKpiSection(doc, tenantName, kpi, detailStatsByKpi[kpi.id]);
      });
      drawSummaryPage(doc, tenantName, kpis);
    }

    doc.end();
  });
}
