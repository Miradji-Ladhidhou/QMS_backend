import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';

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
function getKpiStatus(value, target, targetDirection) {
  if (value === null || value === undefined || target === null || target === undefined) {
    return 'neutral';
  }
  const meetsTarget = targetDirection === 'max' ? value <= target : value >= target;
  return meetsTarget ? 'good' : 'bad';
}

const STATUS_COLORS = { good: GOOD, bad: BAD, neutral: NEUTRAL };
const STATUS_LABELS = { good: 'Objectif atteint', bad: 'Objectif non atteint', neutral: "Pas d'objectif défini" };

// Mêmes couleurs que SERIES_COLORS (frontend/src/pages/Kpis.jsx) — un KPI multi-séries doit
// se reconnaître visuellement de la même façon dans le rapport PDF que sur la carte à l'écran.
const SERIES_COLORS = ['#1F3864', '#E69F00', '#009E73', '#CC79A7', '#0072B2', '#D55E00'];

// Miroir exact de la logique showMultiSeries/labelForRecord de KpiCard (Kpis.jsx) : un KPI
// n'est "multi-séries" que si plusieurs libellés distincts apparaissent réellement dans ses
// enregistrements (séries de calcul + éventuelle saisie manuelle détachée), jamais sur la
// seule présence de plusieurs calculation_configs si une seule a des valeurs.
function buildSeriesInfo(kpi) {
  const seriesConfigs = kpi.calculation_configs || [];
  const seriesById = new Map(seriesConfigs.map((c) => [c.id, c]));
  const manualLabel = seriesConfigs.length > 1 ? 'Valeur manuelle' : 'Valeur';

  function labelForRecord(record) {
    if (record.config_id) return seriesById.get(record.config_id)?.label || 'Série';
    return manualLabel;
  }

  const configLabels = seriesConfigs.map((c) => c.label);
  const presentLabels = new Set(kpi.records.map(labelForRecord));
  const orderedLabels = [
    ...configLabels.filter((label) => presentLabels.has(label)),
    ...[...presentLabels].filter((label) => !configLabels.includes(label)),
  ];

  const seriesList = orderedLabels.map((label, i) => ({
    label,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    records: kpi.records.filter((r) => labelForRecord(r) === label).sort((a, b) => (a.period_date > b.period_date ? 1 : -1)),
  }));

  return { showMultiSeries: orderedLabels.length > 1, seriesList };
}

// Puce de couleur pleine + libellé : plus fiable qu'un émoji ✅/⚠️/❌, dont le rendu dépend
// du support des polices du lecteur PDF — un cercle vectoriel s'affiche toujours à l'identique.
function drawStatusDot(doc, x, y, status) {
  doc.circle(x, y, 4).fillColor(STATUS_COLORS[status] || NEUTRAL).fill();
}

// Une date par point plutôt que seulement la première/dernière (repère visuel plus complet
// pour un rapport imprimé — voir aussi drawMultiSeriesChart) : à plat, elles se chevaucheraient
// dès qu'il y a plus de 4-5 points sur une largeur de graphique aussi compacte, d'où une
// rotation à -40° (save/restore autour de chaque étiquette, seul moyen pdfkit de faire pivoter
// un morceau de texte sans affecter le reste du dessin).
function drawRotatedDateLabels(doc, points) {
  doc.fontSize(5.5).fillColor(MUTED);
  points.forEach(({ x: px, y: labelY, dateStr }) => {
    doc.save();
    doc.rotate(-40, { origin: [px, labelY] });
    doc.text(dateStr, px, labelY, { lineBreak: false });
    doc.restore();
  });
}

// Graphique de tendance minimaliste dessiné à la main (lignes/points vectoriels pdfkit) :
// pas de dépendance à un moteur de rendu externe (canvas natif, chromium...), donc pas de
// risque de build cassé sur l'environnement de déploiement.
function drawTrendChart(doc, { x, y, width, height, records, target, unit }) {
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

  // 34 (au lieu de 28) : marge pour "100.0 %" et autres libellés avec unité, qui débordaient
  // d'une gouttière pensée pour de simples nombres nus.
  const plotLeft = x + 34;
  const plotWidth = width - 34;
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
  doc.text(`${maxValue.toFixed(1)} ${unit || ''}`.trim(), x, plotTop - 2, { width: 32, align: 'right', lineBreak: false });
  doc.text(`${minValue.toFixed(1)} ${unit || ''}`.trim(), x, plotTop + plotHeight - 4, { width: 32, align: 'right', lineBreak: false });

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

  // Une date par point (pas seulement la première/dernière) : voir drawRotatedDateLabels.
  drawRotatedDateLabels(
    doc,
    records.map((record, index) => ({
      x: scaleX(index),
      y: plotTop + plotHeight + 4,
      dateStr: formatDateShort(record.period_date),
    }))
  );
}

// Variante multi-lignes de drawTrendChart pour un KPI à plusieurs séries : même style dessiné
// à la main, mais une échelle Y partagée entre toutes les séries (comme le graphique recharts
// de la carte à l'écran, qui trace plusieurs <Line> sur un seul axe) et un point par série
// manquant sur une période casse la ligne au lieu de l'interpoler (connectNulls={false} côté
// frontend) — d'où moveTo() plutôt que lineTo() dès qu'une période n'a pas de valeur pour
// cette série.
function drawMultiSeriesChart(doc, { x, y, width, height, seriesList, target, unit }) {
  const allRecords = seriesList.flatMap((s) => s.records);
  if (allRecords.length < 2) {
    doc
      .fontSize(8)
      .fillColor(MUTED)
      .text('Pas assez de données pour un graphique', x, y + height / 2 - 4, { width, align: 'center' });
    return;
  }

  const values = allRecords.map((r) => r.value);
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

  // Plafonné aux RECORD_ROWS_MAX dernières périodes, comme drawTrendChart (lastRecords côté
  // mono-série) : chaque point porte désormais sa propre date en pied de graphique (voir
  // drawRotatedDateLabels), un historique complet non plafonné deviendrait illisible.
  const allPeriods = [...new Set(allRecords.map((r) => r.period_date))].sort();
  const periods = allPeriods.slice(-RECORD_ROWS_MAX);

  // 34 (au lieu de 28) : marge pour "100.0 %" et autres libellés avec unité.
  const plotLeft = x + 34;
  const plotWidth = width - 34;
  const plotTop = y + 2;
  const plotHeight = height - 16;

  const scaleX = (index) => (periods.length === 1 ? plotLeft + plotWidth / 2 : plotLeft + (index / (periods.length - 1)) * plotWidth);
  const scaleY = (value) => plotTop + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight;

  doc.strokeColor(GRID).lineWidth(0.5);
  doc
    .moveTo(plotLeft, plotTop)
    .lineTo(plotLeft, plotTop + plotHeight)
    .lineTo(plotLeft + plotWidth, plotTop + plotHeight)
    .stroke();

  doc.fontSize(6).fillColor(MUTED);
  doc.text(`${maxValue.toFixed(1)} ${unit || ''}`.trim(), x, plotTop - 2, { width: 32, align: 'right', lineBreak: false });
  doc.text(`${minValue.toFixed(1)} ${unit || ''}`.trim(), x, plotTop + plotHeight - 4, { width: 32, align: 'right', lineBreak: false });

  if (target !== null && target !== undefined) {
    const targetY = scaleY(target);
    doc.strokeColor(MUTED).lineWidth(0.5).dash(2, { space: 2 });
    doc
      .moveTo(plotLeft, targetY)
      .lineTo(plotLeft + plotWidth, targetY)
      .stroke();
    doc.undash();
  }

  seriesList.forEach((series) => {
    const byPeriod = new Map(series.records.map((r) => [r.period_date, r.value]));
    doc.strokeColor(series.color).lineWidth(1.3);
    let started = false;
    periods.forEach((period, index) => {
      if (!byPeriod.has(period)) {
        started = false;
        return;
      }
      const px = scaleX(index);
      const py = scaleY(byPeriod.get(period));
      if (!started) {
        doc.moveTo(px, py);
        started = true;
      } else {
        doc.lineTo(px, py);
      }
    });
    doc.stroke();

    periods.forEach((period, index) => {
      if (!byPeriod.has(period)) return;
      doc.circle(scaleX(index), scaleY(byPeriod.get(period)), 1.4).fillColor(series.color).fill();
    });
  });

  // Une date par période (pas seulement la première/dernière) : voir drawRotatedDateLabels.
  drawRotatedDateLabels(
    doc,
    periods.map((period, index) => ({
      x: scaleX(index),
      y: plotTop + plotHeight + 4,
      dateStr: formatDateShort(period),
    }))
  );
}

// Rangée de badges (pastille couleur + libellé + moyenne), avec retour à la ligne automatique
// dès que la largeur disponible est dépassée — équivalent PDF de la rangée "(moyennes)" par
// série affichée sur la carte KpiCard. Retourne le Y de la ligne suivante pour que l'appelant
// puisse continuer la mise en page sans connaître la hauteur à l'avance (nombre de séries et
// longueur des libellés variables d'un KPI à l'autre).
function drawSeriesAverages(doc, x, y, maxWidth, seriesList, unit) {
  const lineHeight = 13;
  let cursorX = x;
  let cursorY = y;
  doc.fontSize(8);

  seriesList.forEach((series) => {
    const values = series.records.map((r) => r.value);
    const average = values.length > 0 ? Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2)) : null;
    const text = `${series.label} : ${average !== null ? `${average} ${unit || ''}` : '—'}`;
    const textWidth = doc.widthOfString(text);
    const badgeWidth = 10 + textWidth + 14;

    if (cursorX !== x && cursorX + badgeWidth > x + maxWidth) {
      cursorX = x;
      cursorY += lineHeight;
    }

    doc.circle(cursorX + 3, cursorY + 4, 3).fillColor(series.color).fill();
    doc.fillColor(INK).text(text, cursorX + 9, cursorY, { width: textWidth + 2, lineBreak: false });
    cursorX += badgeWidth;
  });

  return cursorY + lineHeight;
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js. Dans un try/catch
// séparé du reste du dessin : un logo dans un format que pdfkit ne sait pas décoder (SVG,
// WEBP...) ne doit jamais faire échouer toute la génération du rapport, juste rester absent.
function drawPageHeader(doc, tenantName, tenantLogo) {
  doc.rect(0, 0, PAGE_WIDTH, 86).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(18).text('Rapport des indicateurs qualité (KPI)', PAGE_MARGIN, 26);
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 52);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 65);
  doc.fillColor(INK);
  doc.y = 104;

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 50, 18, { fit: [50, 50], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
}

function ensureSpace(doc, tenantName, tenantLogo, requiredHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight > bottom) {
    doc.addPage();
    drawPageHeader(doc, tenantName, tenantLogo);
  }
}

const CHART_HEIGHT = 90;
const RECORD_ROWS_MAX = 12;

function drawKpiSection(doc, tenantName, tenantLogo, kpi, detailStats) {
  const records = [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));
  const lastRecords = records.slice(-RECORD_ROWS_MAX);
  const targetDirection = kpi.target_direction || 'min';
  const hasTarget = kpi.target !== null && kpi.target !== undefined;
  const isImportBased = kpi.calculation_type === 'import';
  const { showMultiSeries, seriesList } = buildSeriesInfo(kpi);

  const targetLine = hasTarget
    ? `Objectif : ${targetDirection === 'max' ? '<=' : '>='} ${kpi.target} ${kpi.unit || ''}`
    : 'Objectif : non défini';

  // KPI multi-séries : ni moyenne globale ni statut atteint/non atteint (mélangerait des
  // séries sans rapport entre elles — voir buildSeriesInfo) — même choix que KpiCard.jsx, qui
  // n'affiche de statut/StatusIcon que dans la branche mono-série. À la place, une rangée de
  // moyennes par série (drawSeriesAverages) et un graphique multi-lignes pleine largeur, sans
  // tableau période/valeur/source à côté (pas de colonne "valeur" unique qui aurait un sens).
  if (showMultiSeries) {
    // Hauteur de la rangée de moyennes inconnue à l'avance (dépend du nombre de séries et de
    // la longueur des libellés, donc du retour à la ligne) — 26pt couvre confortablement
    // jusqu'à 2 lignes, cas très largement majoritaire ; mieux vaut sur-estimer que risquer
    // une section coupée (même principe que le commentaire mono-série ci-dessous).
    const requiredHeight = 20 + 26 + CHART_HEIGHT + 26 + (isImportBased ? 14 : 0);
    ensureSpace(doc, tenantName, tenantLogo, requiredHeight);

    const sectionTop = doc.y;
    doc.fontSize(12).fillColor(NAVY).text(kpi.name, PAGE_MARGIN, sectionTop, { width: CONTENT_WIDTH });
    doc.fontSize(9).fillColor('#555555').text(targetLine, PAGE_MARGIN, sectionTop + 16);

    const averagesY = drawSeriesAverages(doc, PAGE_MARGIN, sectionTop + 30, CONTENT_WIDTH, seriesList, kpi.unit);

    const chartY = averagesY + 4;
    drawMultiSeriesChart(doc, {
      x: PAGE_MARGIN,
      y: chartY,
      width: CONTENT_WIDTH,
      height: CHART_HEIGHT,
      seriesList,
      target: kpi.target,
      unit: kpi.unit,
    });

    doc.y = chartY + CHART_HEIGHT + 6;

    if (isImportBased) {
      const auditLine =
        detailStats && detailStats.count > 0
          ? `Source : import de fichier, ${detailStats.count} ligne${detailStats.count > 1 ? 's' : ''}, dernière mise à jour le ${formatDateShort(detailStats.lastImportedAt)}`
          : "Source : import de fichier — aucun import réalisé pour l'instant.";
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
    return;
  }

  // Le statut et la valeur mise en avant reflètent la moyenne de toutes les périodes
  // enregistrées, pas seulement la dernière — cohérent avec la carte KPI du frontend.
  const averageValue = records.length > 0 ? Number((records.reduce((sum, r) => sum + r.value, 0) / records.length).toFixed(2)) : null;
  const status = getKpiStatus(averageValue, kpi.target, targetDirection);

  // 32pt titre+objectif avant le graphique, CHART_HEIGHT pour le graphique, puis marge/
  // séparateur/mention d'audit — sous-estimer ce total est ce qui casse la mise en page
  // (une section qui déborde milieu de dessin se retrouve coupée n'importe où sur la page
  // suivante). Mieux vaut sur-estimer largement que de risquer une section tronquée.
  const requiredHeight = 32 + CHART_HEIGHT + 26 + (isImportBased ? 14 : 0);
  ensureSpace(doc, tenantName, tenantLogo, requiredHeight);

  const sectionTop = doc.y;
  doc.fontSize(12).fillColor(NAVY).text(kpi.name, PAGE_MARGIN, sectionTop, { width: CONTENT_WIDTH - 90 });

  drawStatusDot(doc, PAGE_MARGIN + CONTENT_WIDTH - 6, sectionTop + 6, status);
  doc.fontSize(8).fillColor(STATUS_COLORS[status]).text(STATUS_LABELS[status], PAGE_MARGIN, sectionTop, {
    width: CONTENT_WIDTH - 14,
    align: 'right',
  });

  const averageValueLine = averageValue !== null ? `Moyenne : ${averageValue} ${kpi.unit || ''}` : 'Aucune valeur enregistrée';

  doc.fontSize(9).fillColor('#555555').text(`${targetLine}    —    ${averageValueLine}`, PAGE_MARGIN, sectionTop + 16);

  const chartY = sectionTop + 32;
  drawTrendChart(doc, {
    x: PAGE_MARGIN,
    y: chartY,
    width: 230,
    height: CHART_HEIGHT,
    records: lastRecords,
    target: kpi.target,
    unit: kpi.unit,
  });

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
      doc.text(record.source === 'import' ? 'Import' : 'Manuelle', tableX + tableWidth * 0.6, rowY, {
        width: tableWidth * 0.4,
      });
      rowY += 9;
    });

  doc.y = chartY + CHART_HEIGHT + 6;

  if (isImportBased) {
    const auditLine =
      detailStats && detailStats.count > 0
        ? `Source : import de fichier, ${detailStats.count} ligne${detailStats.count > 1 ? 's' : ''}, dernière mise à jour le ${formatDateShort(detailStats.lastImportedAt)}`
        : 'Source : import de fichier — aucun import réalisé pour l\'instant.';
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

function drawSummaryPage(doc, tenantName, tenantLogo, kpis) {
  doc.addPage();
  drawPageHeader(doc, tenantName, tenantLogo);
  doc.fontSize(15).fillColor(NAVY).text('Synthèse', PAGE_MARGIN, doc.y);
  doc.moveDown(0.8);

  const columns = { name: 0.42, value: 0.2, target: 0.23, status: 0.15 };
  let rowY = doc.y;

  function drawHeaderRow() {
    doc.fontSize(8).fillColor(MUTED);
    doc.text('KPI', PAGE_MARGIN, rowY, { width: CONTENT_WIDTH * columns.name });
    doc.text('Moyenne', PAGE_MARGIN + CONTENT_WIDTH * columns.name, rowY, { width: CONTENT_WIDTH * columns.value });
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
      drawPageHeader(doc, tenantName, tenantLogo);
      rowY = doc.y;
      drawHeaderRow();
    }

    const records = [...kpi.records].sort((a, b) => (a.period_date > b.period_date ? 1 : -1));
    const targetDirection = kpi.target_direction || 'min';
    const hasTarget = kpi.target !== null && kpi.target !== undefined;
    // Une seule "moyenne"/un seul statut n'a de sens que pour un KPI mono-série (voir
    // buildSeriesInfo / drawKpiSection) — mélanger plusieurs séries donnerait un chiffre
    // trompeur ici aussi, donc "Plusieurs séries" plutôt qu'une fausse moyenne.
    const { showMultiSeries } = buildSeriesInfo(kpi);
    const averageValue = records.length > 0 ? Number((records.reduce((sum, r) => sum + r.value, 0) / records.length).toFixed(2)) : null;
    const status = showMultiSeries ? null : getKpiStatus(averageValue, kpi.target, targetDirection);

    doc.fontSize(9).fillColor(INK);
    doc.text(kpi.name, PAGE_MARGIN, rowY, { width: CONTENT_WIDTH * columns.name });
    doc.text(
      showMultiSeries ? 'Plusieurs séries' : averageValue !== null ? `${averageValue} ${kpi.unit || ''}` : '—',
      PAGE_MARGIN + CONTENT_WIDTH * columns.name,
      rowY,
      { width: CONTENT_WIDTH * columns.value }
    );
    doc.text(
      hasTarget ? `${targetDirection === 'max' ? '<=' : '>='} ${kpi.target} ${kpi.unit || ''}` : '—',
      PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value),
      rowY,
      { width: CONTENT_WIDTH * columns.target }
    );
    if (status) {
      drawStatusDot(doc, PAGE_MARGIN + CONTENT_WIDTH * (columns.name + columns.value + columns.target) + 6, rowY + 4, status);
    }

    rowY += 16;
  });
}

// Construit le PDF en mémoire (pas de fichier temporaire) : les chunks du flux pdfkit sont
// collectés dans un buffer, résolu à l'évènement 'end' — même pattern que certificatePdf.js.
export function buildKpiReportPdf({ tenantName, tenantLogo, kpis, detailStatsByKpi, scoped }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    drawPageHeader(doc, tenantName, tenantLogo);

    if (kpis.length === 0) {
      // scoped : le rapport porte sur un dossier précis (voir GET /kpis/report ?folder_id=) —
      // "aucun KPI pour ce tenant" serait faux si d'autres dossiers en contiennent.
      const emptyMessage = scoped ? 'Aucun KPI dans ce dossier.' : 'Aucun KPI configuré pour ce tenant.';
      doc.fontSize(10).fillColor(MUTED).text(emptyMessage, PAGE_MARGIN, doc.y);
    } else {
      kpis.forEach((kpi) => {
        drawKpiSection(doc, tenantName, tenantLogo, kpi, detailStatsByKpi[kpi.id]);
      });
      drawSummaryPage(doc, tenantName, tenantLogo, kpis);
    }

    doc.end();
  });
}
