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
import { CHECKLIST_ANSWER_LABELS, summarizeChecklist } from './auditChecklist.js';

// Mêmes teintes neutres que les autres exports Word (voir listReportWord.js).
const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const BORDER = 'D9D9D9';
const GOOD = '047857';
const BAD = 'B91C1C';
const AMBER = 'B45309';
const HEADER_WIDTH_DXA = 9026;

const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

const STATUS_LABELS = { planned: 'Planifié', in_progress: 'En cours', completed: 'Terminé', closed: 'Clôturé' };
const TYPE_LABELS = { process: 'Processus', product: 'Produit', system: 'Système' };
const FINDING_LABELS = { major_nc: 'Non-conformité majeure', minor_nc: 'Non-conformité mineure', observation: 'Remarque', strength: 'Point fort' };
const FINDING_COLORS = { major_nc: BAD, minor_nc: AMBER, observation: MUTED, strength: GOOD };
const ANSWER_COLORS = { conform: GOOD, nonconform: BAD, na: MUTED };

// Largeurs fixes en dxa (9026 = largeur utile A4) : Word et LibreOffice ignorent parfois les pourcentages de cellule
// et répartissent alors les colonnes à parts égales (une colonne « N° » aussi large qu'une question).
const dxa = (percentages) => percentages.map((pct) => Math.round((pct / 100) * HEADER_WIDTH_DXA));

const formatDate = (value) => (value ? new Date(value).toLocaleDateString('fr-FR') : '—');

function cell(text, { header = false, bold = false, color, widthPct, align } = {}) {
  return new TableCell({
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: CELL_BORDERS,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: String(text ?? '')
      .split('\n')
      .map((line) => new Paragraph({ alignment: align, children: [new TextRun({ text: line, bold: header || bold, color: color || (header ? INK : undefined), size: 20 })] })),
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

// Fiche Word d'un audit : faits, qualification de l'auditeur, périmètre, conclusion, constats, check-list
// (question par question, avec réponse et observation) et taux de conformité. Un vrai document vertical,
// jamais un tableau à une ligne de 15 colonnes (illisible dès que la check-list est longue).
export async function buildAuditWord({ tenantName, tenantLogo, audit, findings, checklistItems, linkedProcedures, qualificationText, generatedBy }) {
  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — Audit ${audit.title}`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({ spacing: { after: 120 }, tabStops: [{ type: TabStopType.RIGHT, position: HEADER_WIDTH_DXA }], children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle] })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const facts = [
    ['Type', TYPE_LABELS[audit.audit_type] || audit.audit_type],
    ['Statut', STATUS_LABELS[audit.status] || audit.status],
    ['Date planifiée', formatDate(audit.planned_date)],
    ['Date de réalisation', formatDate(audit.completed_date)],
    ['Service audité', audit.service?.name || '—'],
    ['Auditeur', audit.lead?.full_name || 'À désigner'],
    ...(audit.lead && qualificationText ? [["Qualification de l'auditeur", qualificationText]] : []),
    ['Dossier', audit.category?.name || '—'],
  ];

  const summary = summarizeChecklist(checklistItems);
  const rate = summary.conformity_percent === null ? 'non calculable (aucune réponse « conforme » ou « non conforme »)' : `${summary.conformity_percent} %`;

  const body = [
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Audit interne', bold: true, size: 32, color: INK })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: audit.title, size: 24, color: MUTED })] }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: dxa([30, 70]),
      layout: TableLayoutType.FIXED,
      rows: facts.map(([label, value]) => new TableRow({ children: [cell(label, { header: true, widthPct: 30 }), cell(value, { widthPct: 70 })] })),
    }),

    heading('Périmètre'),
    ...textBlock(audit.scope),
    heading('Conclusion'),
    ...textBlock(audit.conclusion),

    heading(`Constats (${findings.length})`),
    ...(findings.length === 0
      ? textBlock('')
      : [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: dxa([24, 54, 22]),
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({ tableHeader: true, children: [cell('Type', { header: true, widthPct: 24 }), cell('Constat', { header: true, widthPct: 54 }), cell('CAPA liée', { header: true, widthPct: 22 })] }),
              ...findings.map(
                (finding) =>
                  new TableRow({
                    cantSplit: true,
                    children: [
                      cell(FINDING_LABELS[finding.type] || finding.type, { widthPct: 24, bold: true, color: FINDING_COLORS[finding.type] }),
                      cell(finding.description, { widthPct: 54 }),
                      cell(finding.linked_capa ? `${finding.linked_capa.number} — ${finding.linked_capa.title}` : '—', { widthPct: 22 }),
                    ],
                  })
              ),
            ],
          }),
        ]),

    heading(`Check-list d'audit (${summary.total} question${summary.total > 1 ? 's' : ''})`),
    ...(summary.total === 0
      ? textBlock('')
      : [
          new Paragraph({
            spacing: { after: 100 },
            keepNext: true,
            children: [
              new TextRun({ text: `${summary.answered}/${summary.total} répondue${summary.answered > 1 ? 's' : ''}  ·  Taux de conformité : `, size: 20 }),
              new TextRun({ text: rate, bold: true, size: 20, color: INK }),
              new TextRun({ text: `  ·  ${summary.conform} conforme(s), ${summary.nonconform} non conforme(s), ${summary.na} sans objet`, size: 18, color: MUTED }),
            ],
          }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: dxa([6, 44, 16, 34]),
            layout: TableLayoutType.FIXED,
            rows: [
              new TableRow({
                tableHeader: true,
                children: [cell('N°', { header: true, widthPct: 6, align: AlignmentType.CENTER }), cell('Question', { header: true, widthPct: 44 }), cell('Réponse', { header: true, widthPct: 16 }), cell('Observation', { header: true, widthPct: 34 })],
              }),
              ...checklistItems.map(
                (item, index) =>
                  new TableRow({
                    cantSplit: true,
                    children: [
                      cell(`${index + 1}`, { widthPct: 6, align: AlignmentType.CENTER }),
                      cell(item.question, { widthPct: 44 }),
                      cell(item.answer ? CHECKLIST_ANSWER_LABELS[item.answer] : 'Non répondue', { widthPct: 16, bold: Boolean(item.answer), color: item.answer ? ANSWER_COLORS[item.answer] : MUTED }),
                      cell(item.observation || '', { widthPct: 34 }),
                    ],
                  })
              ),
            ],
          }),
        ]),

    ...(linkedProcedures.length > 0
      ? [heading('Procédures liées'), ...linkedProcedures.map((procedure) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: `${procedure.number} — ${procedure.title}`, size: 20 })] }))]
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
