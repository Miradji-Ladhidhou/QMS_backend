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
} from 'docx';
import { logoImageRun, dataUrlImageRun } from './wordLogo.js';
import { describeAttemptsSummary, formatDateTimeInZone, summarizeAttempts } from './trainingQuiz.js';

// Mêmes teintes neutres que les autres exports Word (voir listReportWord.js).
const INK = '1E293B';
const MUTED = '64748B';
const HEADER_FILL = 'F1F5F9';
const BORDER = 'D9D9D9';
const GOOD = '047857';
const BAD = 'B91C1C';
const HEADER_WIDTH_DXA = 9026;

const CELL_BORDER = { style: 'single', size: 2, color: BORDER };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

function formatDate(value, timeZone) {
  // Une date de session (« 2026-05-04 ») n'a pas d'heure : on la lit à midi UTC pour que le fuseau
  // n'en décale jamais le jour.
  return value ? formatDateTimeInZone(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, timeZone, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

function formatDateTime(value, timeZone) {
  return value ? formatDateTimeInZone(value, timeZone, { dateStyle: 'short', timeStyle: 'medium' }) : '—';
}

function cell(text, { header = false, bold = false, color, widthPct, align } = {}) {
  return new TableCell({
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    borders: CELL_BORDERS,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text, bold: header || bold, color: color || (header ? INK : undefined), size: 20 })],
      }),
    ],
  });
}

function identityTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      ([label, value, valueColor]) =>
        new TableRow({ children: [cell(label, { header: true, widthPct: 30 }), cell(value, { widthPct: 70, color: valueColor, bold: !!valueColor })] })
    ),
  });
}

function questionBlock(question, index, detailEntry) {
  const selected = new Set(detailEntry?.selected_option_ids || []);
  const isCorrect = detailEntry?.is_correct === true;

  const title = new Paragraph({
    spacing: { before: 280, after: 80 },
    keepNext: true,
    children: [
      new TextRun({ text: `Question ${index + 1} — ${question.text}`, bold: true, size: 22, color: INK }),
      new TextRun({ text: `   ${isCorrect ? 'Correcte' : 'Incorrecte'}`, bold: true, size: 20, color: isCorrect ? GOOD : BAD }),
    ],
  });

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          cell('Réponse proposée', { header: true, widthPct: 60 }),
          cell('Cochée par la personne', { header: true, widthPct: 20, align: AlignmentType.CENTER }),
          cell('Bonne réponse', { header: true, widthPct: 20, align: AlignmentType.CENTER }),
        ],
      }),
      ...question.options.map(
        (option) =>
          new TableRow({
            cantSplit: true,
            children: [
              cell(option.label, { widthPct: 60 }),
              cell(selected.has(option.id) ? 'Oui' : '', { widthPct: 20, align: AlignmentType.CENTER, bold: selected.has(option.id) }),
              cell(option.is_correct ? 'Oui' : '', { widthPct: 20, align: AlignmentType.CENTER, bold: option.is_correct, color: option.is_correct ? GOOD : undefined }),
            ],
          })
      ),
    ],
  });

  return [title, table];
}

function descriptionParagraphs(description) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) return [new Paragraph({ children: [new TextRun({ text: 'Non renseigné.', italics: true, color: MUTED, size: 20 })] })];
  return text.split(/\r?\n/).map((line) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: line, size: 20 })] }));
}

// Statut lisible d'un passage dans l'historique.
function attemptStatus(entry) {
  if (entry.completed_at) return entry.passed === true ? 'Réussi' : 'Non réussi';
  return new Date(entry.expires_at) > new Date() ? 'Lien envoyé, non passé' : 'Lien non utilisé (expiré ou remplacé)';
}

// Trace de tous les passages de la personne pour cette réalisation : les essais réellement passés
// portent un numéro ; les liens jamais utilisés figurent sans numéro. Le passage décrit par ce
// document est repéré (« ◄ ce document »).
function historyBlock({ history, currentId, timeZone }) {
  if (history.length === 0) return [];
  const headerCell = (text, widthPct) => cell(text, { header: true, widthPct });

  const rows = history.map((entry) => {
    const isCurrent = entry.id === currentId;
    const done = Boolean(entry.completed_at);
    const color = done ? (entry.passed === true ? GOOD : BAD) : MUTED;
    return new TableRow({
      cantSplit: true,
      children: [
        cell(entry.attempt_number ? `${entry.attempt_number}` : '—', { widthPct: 10, align: AlignmentType.CENTER, bold: isCurrent }),
        cell(formatDateTime(entry.sent_at, timeZone), { widthPct: 24, bold: isCurrent }),
        cell(done ? formatDateTime(entry.completed_at, timeZone) : '—', { widthPct: 24, bold: isCurrent }),
        cell(done ? `${entry.correct_count}/${entry.total_count} — ${entry.score_percent} %` : '—', { widthPct: 20, bold: isCurrent }),
        cell(`${attemptStatus(entry)}${isCurrent ? '  ◄ ce document' : ''}`, { widthPct: 22, bold: true, color }),
      ],
    });
  });

  return [
    new Paragraph({ spacing: { before: 320, after: 40 }, keepNext: true, children: [new TextRun({ text: 'Historique des essais', bold: true, size: 26, color: INK })] }),
    new Paragraph({
      spacing: { after: 80 },
      keepNext: true,
      children: [new TextRun({ text: describeAttemptsSummary(summarizeAttempts(history)), size: 20, color: INK })],
    }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        new TableRow({
          tableHeader: true,
          children: [headerCell('Essai n°', 10), headerCell('Envoyé le', 24), headerCell('Passé le', 24), headerCell('Score', 20), headerCell('Résultat', 22)],
        }),
        ...rows,
      ],
    }),
  ];
}

const SIGNATURE_BOX = { maxWidth: 200, maxHeight: 80 };

function signatureCell({ title, name, image, caption, emptyText }) {
  const lines = [
    new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: title, bold: true, size: 20, color: INK })] }),
    new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: name, size: 20 })] }),
  ];
  if (image) {
    lines.push(new Paragraph({ spacing: { before: 60, after: 60 }, children: [image] }));
  } else {
    // Emplacement laissé vide (pas de signature) : hauteur réservée + mention explicite.
    lines.push(new Paragraph({ spacing: { before: 200, after: 200 }, children: [new TextRun({ text: emptyText, italics: true, size: 18, color: MUTED })] }));
  }
  lines.push(new Paragraph({ children: [new TextRun({ text: caption, size: 16, color: MUTED })] }));

  return new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    borders: CELL_BORDERS,
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    children: lines,
  });
}

// Bloc final « Signatures » : le salarié (signature dessinée à l'écran), et le formateur — sa
// signature électronique n'est apposée QUE si le QCM est réussi. cantSplit + keepNext : le bloc reste
// d'un seul tenant, jamais coupé entre deux pages.
function signaturesBlock({ attempt, trainingInfo, employeeSignature, instructorSignature, timeZone }) {
  const passed = attempt.passed === true;
  const signedAt = formatDateTime(attempt.completed_at, timeZone);

  const employeeCell = signatureCell({
    title: 'Le salarié',
    name: attempt.person_name || '—',
    image: dataUrlImageRun(employeeSignature, SIGNATURE_BOX),
    emptyText: 'Signature non recueillie',
    caption: `Signature manuscrite électronique recueillie en ligne le ${signedAt}, après confirmation de l'adresse ${attempt.email}. Le salarié certifie avoir répondu personnellement.`,
  });

  const trainerName = trainingInfo?.instructor || 'Formateur';
  const trainerCell = passed
    ? signatureCell({
        title: 'Le formateur',
        name: trainerName,
        image: dataUrlImageRun(instructorSignature, SIGNATURE_BOX),
        emptyText: 'Signature du formateur non enregistrée',
        caption: `Signature électronique apposée automatiquement à la réussite du QCM (${signedAt}).`,
      })
    : signatureCell({
        title: 'Le formateur',
        name: trainerName,
        image: null,
        emptyText: 'Non signé',
        caption: 'La signature du formateur n\'est apposée qu\'en cas de réussite au QCM.',
      });

  return [
    new Paragraph({ spacing: { before: 360, after: 80 }, keepNext: true, children: [new TextRun({ text: 'Signatures', bold: true, size: 26, color: INK })] }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({ cantSplit: true, children: [employeeCell, trainerCell] })],
    }),
  ];
}

// Compte rendu d'un passage de QCM, destiné à être conservé pour les audits : le QCM tel qu'il
// était à l'envoi (quiz_snapshot), les réponses de la personne, la correction question par
// question et le taux de réussite. attempt : ligne de training_quiz_attempts terminée.
export async function buildTrainingQuizWord({
  history = [],
  tenantName,
  tenantLogo,
  tenantTimezone,
  trainingTitle,
  trainingInfo,
  sessionDate,
  employeeSignature,
  instructorSignature,
  attempt,
}) {
  const questions = attempt.quiz_snapshot || [];
  const detailByQuestion = new Map((attempt.answers || []).map((entry) => [entry.question_id, entry]));
  const passed = attempt.passed === true;
  const currentEntry = history.find((entry) => entry.id === attempt.id);
  const summary = summarizeAttempts(history);

  const logo = logoImageRun(tenantLogo);
  const headerTitle = new TextRun({ text: `${tenantName || 'Entreprise'} — QCM ${trainingTitle}`, size: 16, color: MUTED });
  const header = logo
    ? new Paragraph({
        spacing: { after: 120 },
        tabStops: [{ type: TabStopType.RIGHT, position: HEADER_WIDTH_DXA }],
        children: [logo, new TextRun({ text: '\t', size: 16 }), headerTitle],
      })
    : new Paragraph({ alignment: AlignmentType.RIGHT, children: [headerTitle] });

  const body = [
    new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: 'Évaluation de formation — QCM', bold: true, size: 32, color: INK })],
    }),
    new Paragraph({
      spacing: { after: 200 },
      children: [new TextRun({ text: trainingTitle, size: 24, color: MUTED })],
    }),
    identityTable([
      ['Personne évaluée', attempt.person_name || '—'],
      ['Email', attempt.email],
      ['Formation', trainingTitle],
      ['Formateur', trainingInfo?.instructor || 'Non renseigné'],
      ['Session', sessionDate ? formatDate(sessionDate, tenantTimezone) : '—'],
      ['QCM envoyé le', formatDateTime(attempt.sent_at, tenantTimezone)],
      ['QCM passé le', formatDateTime(attempt.completed_at, tenantTimezone)],
      ...(currentEntry?.attempt_number
        ? [
            ['Essai', `n°${currentEntry.attempt_number} sur ${summary.total}`],
            ['Bilan des essais', describeAttemptsSummary(summary)],
          ]
        : []),
      ['Résultat', `${attempt.correct_count} / ${attempt.total_count} bonnes réponses — ${attempt.score_percent} %`],
      ['Seuil de réussite', `${attempt.pass_threshold} %`],
      ['Conclusion', passed ? 'RÉUSSI' : 'NON RÉUSSI', passed ? GOOD : BAD],
    ]),
    // Objet / contenu de la formation, tel qu'à l'envoi du QCM : ce sur quoi la personne est évaluée.
    new Paragraph({ spacing: { before: 320, after: 80 }, keepNext: true, children: [new TextRun({ text: 'Objet et contenu de la formation', bold: true, size: 26, color: INK })] }),
    ...descriptionParagraphs(trainingInfo?.description),
    new Paragraph({ spacing: { before: 320, after: 40 }, children: [new TextRun({ text: 'Détail des questions', bold: true, size: 26, color: INK })] }),
    ...questions.flatMap((question, index) => questionBlock(question, index, detailByQuestion.get(question.id))),
    ...historyBlock({ history, currentId: attempt.id, timeZone: tenantTimezone }),
    ...signaturesBlock({ attempt, trainingInfo, employeeSignature, instructorSignature, timeZone: tenantTimezone }),
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
                  new TextRun({ text: `Référence QCM-${attempt.id.slice(0, 8).toUpperCase()}  ·  Page `, size: 16, color: MUTED }),
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
