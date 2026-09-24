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
  PageOrientation,
  WidthType,
  ShadingType,
  VerticalAlign,
  TabStopType,
  TableLayoutType,
} from 'docx';
import { logoImageRun } from './wordLogo.js';
import { describeLimits, numericLimitsOf } from './haccpMonitoring.js';

// Équivalent Word de haccpAuditPdf.js : mêmes rubriques (infos générales, analyse des dangers, points critiques,
// synthèse de surveillance), en paysage comme le PDF — ces tableaux sont bien plus larges que hauts.
const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const RED_FILL = 'FEF2F2';
const RED = 'B91C1C';
const BORDER = 'D9D9D9';
// A4 paysage (16838 dxa) moins deux marges de 1134 (2 cm).
const PAGE_MARGIN_DXA = 1134;
const CONTENT_DXA = 16838 - PAGE_MARGIN_DXA * 2;

const PLAN_STATUS_LABELS = { draft: 'Brouillon', active: 'Actif', under_review: 'En revue', archived: 'Archivé' };
const HAZARD_TYPE_LABELS = { biological: 'Biologique', chemical: 'Chimique', physical: 'Physique', allergen: 'Allergène' };

const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : '—');
const dxa = (percentages) => percentages.map((pct) => Math.round((pct / 100) * CONTENT_DXA));

function cell(text, { header = false, bold = false, color, fill, widthPct } = {}) {
  return new TableCell({
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : fill ? { type: ShadingType.CLEAR, fill } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: CELL_BORDERS,
    margins: { top: 50, bottom: 50, left: 80, right: 80 },
    children: String(text === null || text === undefined || text === '' ? '—' : text)
      .split('\n')
      .map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: header || bold, color: color || (header ? INK : undefined), size: 16 })] })),
  });
}

function heading(text, size = 24) {
  return new Paragraph({ spacing: { before: 280, after: 80 }, keepNext: true, children: [new TextRun({ text, bold: true, size, color: INK })] });
}

function table(columns, rows, emptyLabel) {
  if (rows.length === 0) return [new Paragraph({ children: [new TextRun({ text: emptyLabel, italics: true, color: MUTED, size: 18 })] })];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: dxa(columns.map((column) => column.width)),
      layout: TableLayoutType.FIXED,
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: columns.map((column) => cell(column.label, { header: true, widthPct: column.width })) }),
        ...rows.map(
          (row) =>
            new TableRow({
              cantSplit: true,
              children: columns.map((column) => cell(row[column.key], { widthPct: column.width, fill: row._highlight ? RED_FILL : undefined, color: row._highlight ? RED : undefined })),
            })
        ),
      ],
    }),
  ];
}

function planSection(plan, monitoringSummaryByCcpId) {
  const info = [
    ['Statut', PLAN_STATUS_LABELS[plan.status] || plan.status],
    ['Produit', plan.product_description],
    ['Service', plan.service?.name],
    ['Équipe HACCP', plan.team],
    ['Prochaine revue', formatDate(plan.review_date)],
    ['Dernière revue', plan.last_reviewed_at ? formatDate(plan.last_reviewed_at) : 'Jamais revu'],
  ];

  const hazardRows = [];
  const ccpRows = [];
  for (const step of plan.steps) {
    for (const hazard of step.hazards) {
      hazardRows.push({
        step: `${step.step_number}. ${step.name}`,
        hazard_type: HAZARD_TYPE_LABELS[hazard.hazard_type] || hazard.hazard_type,
        description: hazard.description,
        score: `P${hazard.likelihood} × G${hazard.severity} = ${hazard.risk_score}`,
        significant: hazard.is_significant ? 'Oui' : 'Non',
        existing_controls: hazard.existing_controls,
        _highlight: hazard.is_significant,
      });
      if (hazard.ccp) {
        const limits = numericLimitsOf(hazard.ccp);
        ccpRows.push({
          ccp_number: hazard.ccp.ccp_number,
          hazard: hazard.description,
          critical_limits: `${hazard.ccp.critical_limits}${limits ? ` [${describeLimits(limits)}]` : ''}`,
          monitoring: `${hazard.ccp.monitoring_procedure}${hazard.ccp.monitoring_frequency ? ` (${hazard.ccp.monitoring_frequency})` : ''}${
            hazard.ccp.monitoring_responsible_user ? ` — ${hazard.ccp.monitoring_responsible_user.full_name}` : ''
          }`,
          corrective_action: hazard.ccp.corrective_action_procedure,
          verification: `${hazard.ccp.verification_procedure || ''}${hazard.ccp.verification_frequency ? ` (${hazard.ccp.verification_frequency})` : ''}`,
          record_keeping: hazard.ccp.record_keeping_procedure,
          _ccpId: hazard.ccp.id,
        });
      }
    }
  }

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

  return [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: plan.title, bold: true, size: 32, color: INK })] }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: dxa([20, 80]),
      layout: TableLayoutType.FIXED,
      rows: info.map(([label, value]) => new TableRow({ cantSplit: true, children: [cell(label, { header: true, widthPct: 20 }), cell(value, { widthPct: 80 })] })),
    }),
    ...(plan.scope ? [heading('Périmètre'), ...plan.scope.split(/\r?\n/).filter(Boolean).map((line) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: line.replace(/^[•\-*]\s*/, ''), size: 18 })] }))] : []),
    heading('Analyse des dangers'),
    ...table(
      [
        { key: 'step', label: 'Étape', width: 13 },
        { key: 'hazard_type', label: 'Type', width: 9 },
        { key: 'description', label: 'Danger', width: 26 },
        { key: 'score', label: 'P × G', width: 12 },
        { key: 'significant', label: 'Significatif', width: 9 },
        { key: 'existing_controls', label: 'Maîtrise existante', width: 31 },
      ],
      hazardRows,
      'Aucun danger identifié pour l’instant.'
    ),
    heading('Points critiques (CCP)'),
    ...table(
      [
        { key: 'ccp_number', label: 'CCP', width: 6 },
        { key: 'hazard', label: 'Danger associé', width: 16 },
        { key: 'critical_limits', label: 'Limites critiques', width: 17 },
        { key: 'monitoring', label: 'Surveillance', width: 22 },
        { key: 'corrective_action', label: 'Actions correctives', width: 17 },
        { key: 'verification', label: 'Vérification', width: 12 },
        { key: 'record_keeping', label: 'Registres', width: 10 },
      ],
      ccpRows,
      'Aucun point critique défini pour l’instant.'
    ),
    heading('Surveillance — synthèse'),
    ...table(
      [
        { key: 'ccp_number', label: 'CCP', width: 8 },
        { key: 'hazard', label: 'Danger associé', width: 32 },
        { key: 'total', label: 'Relevés', width: 12 },
        { key: 'out_of_limits', label: 'Hors limites', width: 14 },
        { key: 'linked_capas', label: 'CAPA liées', width: 14 },
        { key: 'last_recorded_at', label: 'Dernier relevé', width: 20 },
      ],
      surveillanceRows,
      'Aucun point critique à surveiller pour l’instant.'
    ),
  ];
}

// plans : plans déjà assemblés (voir loadPlanSteps) ; monitoringSummaryByCcpId : Map ccpId -> { total, outOfLimits,
// linkedCapas, lastRecordedAt }. Un plan = une section (saut de page entre deux plans).
export async function buildHaccpAuditWord({ tenantName, tenantLogo, plans, monitoringSummaryByCcpId }) {
  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — Analyse HACCP`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({ spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_DXA }], children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle] })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const doc = new Document({
    sections: plans.map((plan) => ({
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
          margin: { top: PAGE_MARGIN_DXA, bottom: PAGE_MARGIN_DXA, left: PAGE_MARGIN_DXA, right: PAGE_MARGIN_DXA },
        },
      },
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
      children: planSection(plan, monitoringSummaryByCcpId),
    })),
  });

  return Packer.toBuffer(doc);
}
