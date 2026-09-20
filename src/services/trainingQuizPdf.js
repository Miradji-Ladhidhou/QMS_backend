import PDFDocument from 'pdfkit';
import { useUnicodeFont } from './pdfFonts.js';
import { INK, MUTED, RULE_LIGHT, HEADER_FILL, drawLetterheadHeader } from './pdfTheme.js';
import { describeAttemptsSummary, formatDateTimeInZone, summarizeAttempts } from './trainingQuiz.js';

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BOTTOM_LIMIT = 60; // au-dessus du pied de page
// Couleurs sémantiques (réussi / non réussi), pas des couleurs de marque.
const GOOD = '#047857';
const BAD = '#b91c1c';
const CELL_PADDING = 5;
const SIGNATURE_BOX_HEIGHT = 180;

function formatDate(value, timeZone) {
  // Une date de session (« 2026-05-04 ») n'a pas d'heure : lue à midi UTC pour que le fuseau n'en décale jamais le jour.
  return value ? formatDateTimeInZone(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value, timeZone, { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
}

function formatDateTime(value, timeZone) {
  return value ? formatDateTimeInZone(value, timeZone, { dateStyle: 'short', timeStyle: 'medium' }) : '—';
}

function decodeDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' ? dataUrl.match(/^data:image\/png;base64,(.+)$/) : null;
  return match ? Buffer.from(match[1], 'base64') : null;
}

function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - BOTTOM_LIMIT) doc.addPage();
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 70);
  doc.moveDown(0.6);
  doc.font('Body-Bold').fontSize(12).fillColor(INK).text(title, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.font('Body');
  doc.moveDown(0.3);
}

// Tableau simple : colonnes { width (part de CONTENT_WIDTH), align }, lignes de cellules { text, bold, color }.
// Hauteur de ligne calculée depuis le texte réel ; une ligne n'est jamais coupée entre deux pages.
function drawTable(doc, columns, header, rows) {
  const widths = columns.map((column) => CONTENT_WIDTH * column.width);

  function rowHeight(cells) {
    return (
      Math.max(
        ...cells.map((cell, i) => {
          doc.font(cell.bold ? 'Body-Bold' : 'Body').fontSize(9);
          return doc.heightOfString(cell.text || ' ', { width: widths[i] - CELL_PADDING * 2 });
        })
      ) +
      CELL_PADDING * 2
    );
  }

  function drawRow(cells, { fill } = {}) {
    const height = rowHeight(cells);
    ensureSpace(doc, height);
    const y = doc.y;
    let x = PAGE_MARGIN;
    if (fill) doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, height).fill(fill);
    cells.forEach((cell, i) => {
      doc
        .font(cell.bold ? 'Body-Bold' : 'Body')
        .fontSize(9)
        .fillColor(cell.color || INK)
        .text(cell.text || '', x + CELL_PADDING, y + CELL_PADDING, { width: widths[i] - CELL_PADDING * 2, align: columns[i].align || 'left' });
      x += widths[i];
    });
    doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y + height).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
    doc.y = y + height;
    doc.x = PAGE_MARGIN;
  }

  drawRow(header.map((text) => ({ text, bold: true })), { fill: HEADER_FILL });
  rows.forEach((cells) => drawRow(cells));
  doc.font('Body');
}

// Paires libellé / valeur sur toute la largeur (une par ligne).
function drawFacts(doc, facts) {
  drawTable(
    doc,
    [{ width: 0.3 }, { width: 0.7 }],
    ['Information', 'Valeur'],
    facts.map(([label, value, color]) => [{ text: label, bold: true }, { text: value, bold: Boolean(color), color }])
  );
}

function attemptStatus(entry) {
  if (entry.completed_at) return entry.passed === true ? 'Réussi' : 'Non réussi';
  return new Date(entry.expires_at) > new Date() ? 'Lien envoyé, non passé' : 'Lien non utilisé (expiré ou remplacé)';
}

function drawQuestion(doc, question, index, detailEntry) {
  const selected = new Set(detailEntry?.selected_option_ids || []);
  const isCorrect = detailEntry?.is_correct === true;

  ensureSpace(doc, 90);
  doc.moveDown(0.5);
  doc.font('Body-Bold').fontSize(10).fillColor(INK).text(`Question ${index + 1} — ${question.text}`, PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH, continued: true });
  doc.fillColor(isCorrect ? GOOD : BAD).text(`   ${isCorrect ? 'Correcte' : 'Incorrecte'}`, { continued: false });
  doc.font('Body');
  doc.moveDown(0.25);

  drawTable(
    doc,
    [{ width: 0.6 }, { width: 0.2, align: 'center' }, { width: 0.2, align: 'center' }],
    ['Réponse proposée', 'Cochée par la personne', 'Bonne réponse'],
    question.options.map((option) => [
      { text: option.label },
      { text: selected.has(option.id) ? 'Oui' : '', bold: selected.has(option.id) },
      { text: option.is_correct ? 'Oui' : '', bold: option.is_correct, color: option.is_correct ? GOOD : undefined },
    ])
  );
}

function drawSignatureBox(doc, { x, width, title, name, image, emptyText, caption }) {
  const top = doc.y;
  doc.font('Body-Bold').fontSize(10).fillColor(INK).text(title, x + 8, top + 8, { width: width - 16 });
  doc.font('Body').fontSize(10).text(name, x + 8, doc.y + 2, { width: width - 16 });
  const imageTop = doc.y + 6;
  const buffer = decodeDataUrl(image);
  if (buffer) {
    doc.image(buffer, x + 8, imageTop, { fit: [width - 16, 70] });
  } else {
    doc.fontSize(9).fillColor(MUTED).text(emptyText, x + 8, imageTop + 24, { width: width - 16 });
  }
  doc.fontSize(7).fillColor(MUTED).text(caption, x + 8, imageTop + 78, { width: width - 16 });
  // Deux cadres de même hauteur, côte à côte.
  doc.rect(x, top, width, SIGNATURE_BOX_HEIGHT).strokeColor(RULE_LIGHT).lineWidth(0.5).stroke();
}

// Équivalent PDF de l'export Word (trainingQuizWord.js) : mêmes données, pour conserver le passage
// pour les audits sous une forme non modifiable. attempt : ligne de training_quiz_attempts terminée.
export function buildTrainingQuizPdf({
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    useUnicodeFont(doc);

    const questions = attempt.quiz_snapshot || [];
    const detailByQuestion = new Map((attempt.answers || []).map((entry) => [entry.question_id, entry]));
    const passed = attempt.passed === true;
    const currentEntry = history.find((entry) => entry.id === attempt.id);
    const summary = summarizeAttempts(history);

    const headerArgs = { pageWidth: PAGE_WIDTH, marginX: PAGE_MARGIN, tenantName, tenantLogo, title: `QCM — ${trainingTitle}` };
    doc.on('pageAdded', () => drawLetterheadHeader(doc, headerArgs));
    drawLetterheadHeader(doc, headerArgs);

    doc.font('Body-Bold').fontSize(16).fillColor(INK).text('Évaluation de formation — QCM', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
    doc.font('Body').fontSize(11).fillColor(MUTED).text(trainingTitle, PAGE_MARGIN, doc.y + 2, { width: CONTENT_WIDTH });
    doc.moveDown(0.8);

    drawFacts(doc, [
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
    ]);

    drawSectionTitle(doc, 'Objet et contenu de la formation');
    const description = typeof trainingInfo?.description === 'string' ? trainingInfo.description.trim() : '';
    doc.fontSize(10).fillColor(description ? INK : MUTED).text(description || 'Non renseigné.', PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });

    drawSectionTitle(doc, 'Détail des questions');
    questions.forEach((question, index) => drawQuestion(doc, question, index, detailByQuestion.get(question.id)));

    if (history.length > 0) {
      drawSectionTitle(doc, 'Historique des essais');
      doc.fontSize(10).fillColor(INK).text(describeAttemptsSummary(summary), PAGE_MARGIN, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.4);
      drawTable(
        doc,
        [{ width: 0.1, align: 'center' }, { width: 0.24 }, { width: 0.24 }, { width: 0.2 }, { width: 0.22 }],
        ['Essai n°', 'Envoyé le', 'Passé le', 'Score', 'Résultat'],
        history.map((entry) => {
          const isCurrent = entry.id === attempt.id;
          const done = Boolean(entry.completed_at);
          return [
            { text: entry.attempt_number ? `${entry.attempt_number}` : '—', bold: isCurrent },
            { text: formatDateTime(entry.sent_at, tenantTimezone), bold: isCurrent },
            { text: done ? formatDateTime(entry.completed_at, tenantTimezone) : '—', bold: isCurrent },
            { text: done ? `${entry.correct_count}/${entry.total_count} — ${entry.score_percent} %` : '—', bold: isCurrent },
            { text: `${attemptStatus(entry)}${isCurrent ? '  ◄ ce document' : ''}`, bold: true, color: done ? (entry.passed === true ? GOOD : BAD) : MUTED },
          ];
        })
      );
    }

    // Signatures : le salarié (dessinée à l'écran) et le formateur — la sienne n'est apposée QUE si le
    // QCM est réussi. Bloc d'un seul tenant, jamais coupé entre deux pages.
    // Titre et cadres restent ensemble : on réserve leur hauteur AVANT d'écrire le titre.
    ensureSpace(doc, SIGNATURE_BOX_HEIGHT + 60);
    drawSectionTitle(doc, 'Signatures');
    const boxWidth = (CONTENT_WIDTH - 12) / 2;
    const signedAt = formatDateTime(attempt.completed_at, tenantTimezone);
    const trainerName = trainingInfo?.instructor || 'Formateur';
    const boxTop = doc.y;
    drawSignatureBox(doc, {
      x: PAGE_MARGIN,
      width: boxWidth,
      title: 'Le salarié',
      name: attempt.person_name || '—',
      image: employeeSignature,
      emptyText: 'Signature non recueillie',
      caption: `Signature manuscrite électronique recueillie en ligne le ${signedAt}, après confirmation de l'adresse ${attempt.email}. Le salarié certifie avoir répondu personnellement.`,
    });
    doc.y = boxTop;
    drawSignatureBox(doc, {
      x: PAGE_MARGIN + boxWidth + 12,
      width: boxWidth,
      title: 'Le formateur',
      name: trainerName,
      image: passed ? instructorSignature : null,
      emptyText: passed ? 'Signature du formateur non enregistrée' : 'Non signé',
      caption: passed
        ? `Signature électronique apposée automatiquement à la réussite du QCM (${signedAt}).`
        : "La signature du formateur n'est apposée qu'en cas de réussite au QCM.",
    });
    doc.y = boxTop + SIGNATURE_BOX_HEIGHT;

    // Pied de page numéroté, avec la référence du document.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .fontSize(7)
        .fillColor(MUTED)
        .text(`Référence QCM-${attempt.id.slice(0, 8).toUpperCase()}  ·  Page ${i - range.start + 1} / ${range.count}`, PAGE_MARGIN, doc.page.height - 30, {
          width: CONTENT_WIDTH,
          align: 'center',
        });
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
