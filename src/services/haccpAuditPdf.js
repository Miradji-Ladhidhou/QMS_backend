import PDFDocument from 'pdfkit';

// Mêmes teintes que les autres rapports PDF de l'application (voir qqoqccpPdf.js pour la note
// sur l'absence de module de constantes partagé).
const NAVY = '#1F3864';
const NAVY_LIGHT = '#D5DCE8';
const MUTED = '#94a3b8';
const INK = '#1e293b';
const RED = '#dc2626';
const RED_LIGHT = '#fef2f2';
const ROW_ALT = '#f8fafc';

const PAGE_MARGIN = 40;
// Paysage : les tableaux HACCP (limites critiques, procédures de surveillance...) sont
// presque toujours plus larges que hauts, comme la matrice de compétences (skillMatrixPdf.js).
const PAGE_WIDTH = 841.89; // A4 paysage
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CELL_PADDING = 4;
const TABLE_HEADER_HEIGHT = 20;

const PLAN_STATUS_LABELS = { draft: 'Brouillon', active: 'Actif', under_review: 'En revue', archived: 'Archivé' };
const HAZARD_TYPE_LABELS = { biological: 'Biologique', chemical: 'Chimique', physical: 'Physique', allergen: 'Allergène' };

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('fr-FR');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('fr-FR');
}

// La police standard de pdfkit (Helvetica, encodage WinAnsi) ne couvre pas les symboles
// mathématiques ≥/≤ — un critical_limits typique ("≥ 85°C") ressortait en mojibake ("e 85°C").
// Plutôt que d'embarquer une police Unicode complète pour ces deux caractères, on les
// translittère : bug réel repéré en relisant un export généré avec des données de test.
const PDF_CHAR_REPLACEMENTS = { '≥': '>=', '≤': '<=' };
function sanitizeForPdf(value) {
  if (value === null || value === undefined) return value;
  let result = String(value);
  for (const [from, to] of Object.entries(PDF_CHAR_REPLACEMENTS)) {
    result = result.split(from).join(to);
  }
  return result;
}

// tenantLogo : Buffer (PNG/JPEG) ou null — voir services/tenantLogo.js, même try/catch que les
// autres rapports (un format que pdfkit ne sait pas décoder ne doit jamais faire échouer toute
// la génération).
function drawPageHeader(doc, tenantName, tenantLogo) {
  doc.rect(0, 0, PAGE_WIDTH, 70).fill(NAVY);
  doc.fillColor('#ffffff').fontSize(16).text('Analyse HACCP', PAGE_MARGIN, 20);
  doc.fontSize(9).fillColor(NAVY_LIGHT);
  doc.text(tenantName || 'Entreprise', PAGE_MARGIN, 42);
  doc.text(`Généré le ${formatDateTime(new Date().toISOString())}`, PAGE_MARGIN, 54);
  doc.fillColor(INK);
  doc.y = 86;

  if (tenantLogo) {
    try {
      doc.image(tenantLogo, PAGE_WIDTH - PAGE_MARGIN - 44, 13, { fit: [44, 44], align: 'right', valign: 'center' });
    } catch {
      // Format non supporté par pdfkit ou fichier corrompu : en-tête sans logo, pas d'erreur.
    }
  }
}

// columns : [{ key, label, width }] (width en fraction de CONTENT_WIDTH). rows : tableau
// d'objets déjà formatés en chaînes. Table-drawer générique réutilisé pour les 3 tableaux d'un
// plan (dangers, CCP, surveillance) — même logique de saut de page/ré-affichage d'en-tête que
// listReportPdf.js, mais paramétrable pour être appelée plusieurs fois dans le même document.
function drawTable(doc, { sectionTitle, columns, rows, emptyLabel }) {
  doc.fontSize(11).fillColor(NAVY).text(sectionTitle, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.3);

  const widths = columns.map((col) => col.width * CONTENT_WIDTH);
  const positions = [];
  let x = PAGE_MARGIN;
  widths.forEach((w) => {
    positions.push(x);
    x += w;
  });

  function drawTableHeader() {
    const headerY = doc.y;
    doc.rect(PAGE_MARGIN, headerY, CONTENT_WIDTH, TABLE_HEADER_HEIGHT).fill(NAVY);
    doc.fontSize(7.5).fillColor('#ffffff');
    columns.forEach((col, i) => {
      doc.text(col.label, positions[i] + CELL_PADDING, headerY + 6, { width: widths[i] - CELL_PADDING * 2 });
    });
    doc.y = headerY + TABLE_HEADER_HEIGHT;
    doc.fillColor(INK);
  }

  drawTableHeader();

  if (rows.length === 0) {
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor(MUTED).text(emptyLabel, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);
    return;
  }

  rows.forEach((row, rowIndex) => {
    doc.fontSize(7.5);
    const cellValues = columns.map((col) => sanitizeForPdf(row[col.key]));
    const cellHeights = columns.map((col, i) =>
      doc.heightOfString(cellValues[i] === null || cellValues[i] === undefined || cellValues[i] === '' ? '—' : cellValues[i], {
        width: widths[i] - CELL_PADDING * 2,
      })
    );
    const rowHeight = Math.max(16, ...cellHeights.map((h) => h + CELL_PADDING * 2));

    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + rowHeight > bottom) {
      doc.addPage();
      drawTableHeader();
    }

    const rowY = doc.y;
    if (row._highlight) {
      doc.rect(PAGE_MARGIN, rowY, CONTENT_WIDTH, rowHeight).fill(RED_LIGHT);
    } else if (rowIndex % 2 === 1) {
      doc.rect(PAGE_MARGIN, rowY, CONTENT_WIDTH, rowHeight).fill(ROW_ALT);
    }
    doc.fillColor(row._highlight ? RED : INK).fontSize(7.5);
    columns.forEach((col, i) => {
      const value = cellValues[i];
      doc.text(value === null || value === undefined || value === '' ? '—' : String(value), positions[i] + CELL_PADDING, rowY + CELL_PADDING, {
        width: widths[i] - CELL_PADDING * 2,
      });
    });
    doc.fillColor(INK);
    doc.y = rowY + rowHeight;
  });

  doc.moveDown(0.8);
}

// Un plan par section : titre + infos générales, puis 3 tableaux (analyse des dangers, points
// critiques, synthèse de la surveillance). monitoringSummaryByCcpId : Map ccpId -> { total,
// outOfLimits, linkedCapas, lastRecordedAt } — calculée par l'appelant (voir routes/haccp.js),
// pas ici : ce module ne fait aucun accès base de données.
function drawPlanSection(doc, plan, monitoringSummaryByCcpId) {
  doc.fontSize(14).fillColor(NAVY).text(sanitizeForPdf(plan.title), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.15);
  doc
    .fontSize(8.5)
    .fillColor(MUTED)
    .text(
      `Statut : ${PLAN_STATUS_LABELS[plan.status] || plan.status}` +
        (plan.product_description ? `    —    Produit : ${sanitizeForPdf(plan.product_description)}` : '') +
        (plan.service?.name ? `    —    Service : ${sanitizeForPdf(plan.service.name)}` : '') +
        (plan.team ? `    —    Équipe : ${sanitizeForPdf(plan.team)}` : ''),
      PAGE_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH }
    );
  if (plan.scope) {
    doc.moveDown(0.1);
    doc.fontSize(8.5).fillColor(MUTED).text(`Périmètre : ${sanitizeForPdf(plan.scope)}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  }
  doc.moveDown(0.6);

  const hazardRows = [];
  const ccpRows = [];
  for (const step of plan.steps) {
    for (const hazard of step.hazards) {
      hazardRows.push({
        step: step.name,
        hazard_type: HAZARD_TYPE_LABELS[hazard.hazard_type] || hazard.hazard_type,
        description: hazard.description,
        score: `P${hazard.likelihood} × G${hazard.severity} = ${hazard.risk_score}`,
        significant: hazard.is_significant ? 'Oui' : 'Non',
        existing_controls: hazard.existing_controls || '',
        _highlight: hazard.is_significant,
      });

      if (hazard.ccp) {
        ccpRows.push({
          ccp_number: hazard.ccp.ccp_number || '—',
          hazard: hazard.description,
          critical_limits: hazard.ccp.critical_limits,
          monitoring: `${hazard.ccp.monitoring_procedure}${hazard.ccp.monitoring_frequency ? ` (${hazard.ccp.monitoring_frequency})` : ''}${
            hazard.ccp.monitoring_responsible_user ? ` — ${hazard.ccp.monitoring_responsible_user.full_name}` : ''
          }`,
          corrective_action: hazard.ccp.corrective_action_procedure || '',
          verification: `${hazard.ccp.verification_procedure || ''}${hazard.ccp.verification_frequency ? ` (${hazard.ccp.verification_frequency})` : ''}`,
          record_keeping: hazard.ccp.record_keeping_procedure || '',
          _ccpId: hazard.ccp.id,
        });
      }
    }
  }

  drawTable(doc, {
    sectionTitle: 'Analyse des dangers',
    columns: [
      { key: 'step', label: 'Étape', width: 0.12 },
      { key: 'hazard_type', label: 'Type', width: 0.09 },
      { key: 'description', label: 'Danger', width: 0.27 },
      { key: 'score', label: 'P × G', width: 0.12 },
      { key: 'significant', label: 'Significatif', width: 0.1 },
      { key: 'existing_controls', label: 'Maîtrise existante', width: 0.3 },
    ],
    rows: hazardRows,
    emptyLabel: 'Aucun danger identifié pour l’instant.',
  });

  const surveillanceRows = ccpRows.map((row) => {
    const summary = monitoringSummaryByCcpId.get(row._ccpId) || { total: 0, outOfLimits: 0, linkedCapas: 0, lastRecordedAt: null };
    return {
      ccp_number: row.ccp_number,
      hazard: row.hazard,
      total: String(summary.total),
      out_of_limits: String(summary.outOfLimits),
      linked_capas: String(summary.linkedCapas),
      last_recorded_at: summary.lastRecordedAt ? formatDate(summary.lastRecordedAt) : '—',
      _highlight: summary.outOfLimits > 0 && summary.linkedCapas < summary.outOfLimits,
    };
  });

  drawTable(doc, {
    sectionTitle: 'Points critiques (CCP)',
    columns: [
      { key: 'ccp_number', label: 'CCP', width: 0.06 },
      { key: 'hazard', label: 'Danger associé', width: 0.18 },
      { key: 'critical_limits', label: 'Limites critiques', width: 0.17 },
      { key: 'monitoring', label: 'Surveillance', width: 0.22 },
      { key: 'corrective_action', label: 'Actions correctives', width: 0.17 },
      { key: 'verification', label: 'Vérification', width: 0.12 },
      { key: 'record_keeping', label: 'Registres', width: 0.08 },
    ],
    rows: ccpRows,
    emptyLabel: 'Aucun point critique défini pour l’instant.',
  });

  drawTable(doc, {
    sectionTitle: 'Surveillance — synthèse',
    columns: [
      { key: 'ccp_number', label: 'CCP', width: 0.08 },
      { key: 'hazard', label: 'Danger associé', width: 0.32 },
      { key: 'total', label: 'Relevés', width: 0.12 },
      { key: 'out_of_limits', label: 'Hors limites', width: 0.14 },
      { key: 'linked_capas', label: 'CAPA liées', width: 0.14 },
      { key: 'last_recorded_at', label: 'Dernier relevé', width: 0.2 },
    ],
    rows: surveillanceRows,
    emptyLabel: 'Aucun point critique à surveiller pour l’instant.',
  });
}

// plans : tableau de plans déjà assemblés (steps -> hazards -> ccp, voir loadPlanSteps dans
// routes/haccp.js) — un seul élément pour l'export d'un plan précis, plusieurs pour un export
// combiné ("analyses complètes"). Une page par plan.
export function buildHaccpAuditPdf({ tenantName, tenantLogo, plans, monitoringSummaryByCcpId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', layout: 'landscape', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.on('pageAdded', () => drawPageHeader(doc, tenantName, tenantLogo));

    drawPageHeader(doc, tenantName, tenantLogo);

    plans.forEach((plan, index) => {
      if (index > 0) doc.addPage();
      drawPlanSection(doc, plan, monitoringSummaryByCcpId);
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(MUTED).text(`Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 24, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
