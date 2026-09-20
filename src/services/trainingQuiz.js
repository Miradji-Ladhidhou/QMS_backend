import crypto from 'crypto';

// Lien de QCM envoyé par email : valable 48 h, une seule tentative (voir routes/publicQuiz.js).
export const QUIZ_LINK_TTL_HOURS = 48;
// Au-delà de ce nombre d'emails erronés saisis sur la page publique, le lien est verrouillé :
// sans cela, quelqu'un qui possède le lien pourrait deviner l'adresse de la personne à volonté.
export const MAX_FAILED_EMAIL_ATTEMPTS = 5;

export const MAX_QUESTIONS = 50;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
const MAX_QUESTION_LENGTH = 500;
const MAX_OPTION_LENGTH = 300;

// Jeton aléatoire de 256 bits (base64url, ~43 caractères) : impossible à deviner. Seul son hash
// SHA-256 est stocké en base — une fuite de la table ne donne aucun lien exploitable.
export function generateQuizToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashQuizToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Valide et normalise la liste de questions d'un QCM. Retourne { questions } ou { error }.
// Chaque question : un énoncé, 2 à 6 réponses proposées dont au moins une correcte (plusieurs
// bonnes réponses possibles). Les ids sont conservés s'ils sont fournis (édition d'un QCM
// existant), sinon générés — un id stable permet de retrouver la question dans un passage.
export function validateQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { error: 'Ajoutez au moins une question.' };
  }
  if (rawQuestions.length > MAX_QUESTIONS) {
    return { error: `Un QCM ne peut pas dépasser ${MAX_QUESTIONS} questions.` };
  }

  const questions = [];
  const usedQuestionIds = new Set();
  for (const [index, raw] of rawQuestions.entries()) {
    const number = index + 1;
    const text = typeof raw?.text === 'string' ? raw.text.trim() : '';
    if (!text) return { error: `Question ${number} : l'énoncé est vide.` };
    if (text.length > MAX_QUESTION_LENGTH) return { error: `Question ${number} : énoncé trop long (${MAX_QUESTION_LENGTH} caractères max).` };

    const rawOptions = Array.isArray(raw.options) ? raw.options : [];
    if (rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
      return { error: `Question ${number} : prévoyez entre ${MIN_OPTIONS} et ${MAX_OPTIONS} réponses.` };
    }

    const options = [];
    const usedOptionIds = new Set();
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      const label = typeof rawOption?.label === 'string' ? rawOption.label.trim() : '';
      if (!label) return { error: `Question ${number} : la réponse ${optionIndex + 1} est vide.` };
      if (label.length > MAX_OPTION_LENGTH) return { error: `Question ${number} : réponse ${optionIndex + 1} trop longue.` };
      options.push({ id: uniqueId(rawOption.id, usedOptionIds), label, is_correct: rawOption.is_correct === true });
    }

    if (!options.some((option) => option.is_correct)) {
      return { error: `Question ${number} : cochez au moins une bonne réponse.` };
    }

    questions.push({ id: uniqueId(raw.id, usedQuestionIds), text, options });
  }

  return { questions };
}

function sanitizeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : crypto.randomUUID();
}

// Identifiant valide ET unique dans son groupe (questions d'un QCM, réponses d'une question) : deux
// éléments au même id rendraient la correction ambiguë (cocher l'un cocherait l'autre).
function uniqueId(id, used) {
  let candidate = sanitizeId(id);
  while (used.has(candidate)) candidate = crypto.randomUUID();
  used.add(candidate);
  return candidate;
}

// Date/heure affichée dans les emails et l'export Word, dans le fuseau de l'ENTREPRISE (réglage
// Paramètres > Entreprise, tenants.timezone, UTC par défaut) — jamais celui du serveur (Render tourne
// en UTC : une échéance « 14:00 » s'afficherait sinon avec plusieurs heures d'écart pour des
// salariés en Métropole ou à La Réunion). Un fuseau invalide retombe sur UTC plutôt que de lever.
export function formatDateTimeInZone(value, timeZone, options = {}) {
  let zone = 'UTC';
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone });
    zone = timeZone || 'UTC';
  } catch {
    zone = 'UTC';
  }
  return new Date(value).toLocaleString('fr-FR', { timeZone: zone, ...options });
}

// Échéance lisible sans ambiguïté : date, heure ET fuseau (« 22 septembre 2026 à 14:03 UTC+4 »).
export function formatDeadline(value, timeZone) {
  return formatDateTimeInZone(value, timeZone, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

// Ce que voit la personne : les questions et réponses proposées, jamais les bonnes réponses.
// multiple = plusieurs bonnes réponses → cases à cocher ; sinon choix unique. Révéler cet indice
// est inévitable pour choisir le bon composant d'interface, et n'apprend pas quelle réponse est juste.
export function toPublicQuestions(questions) {
  return questions.map((question) => ({
    id: question.id,
    text: question.text,
    multiple: question.options.filter((option) => option.is_correct).length > 1,
    options: question.options.map((option) => ({ id: option.id, label: option.label })),
  }));
}

// Corrige un passage. answers : { [questionId]: [optionId, ...] }. Une question est juste
// uniquement si l'ensemble des réponses cochées est EXACTEMENT l'ensemble des bonnes réponses
// (pas de points partiels : sinon cocher toutes les cases rapporterait des points).
// Retourne les réponses normalisées (ids inconnus ignorés) avec le détail par question — c'est ce
// détail qui est conservé et exporté pour l'audit.
export function gradeQuiz(questions, answers, passThreshold) {
  const given = answers && typeof answers === 'object' ? answers : {};

  const detail = questions.map((question) => {
    const validOptionIds = new Set(question.options.map((option) => option.id));
    const rawSelected = Array.isArray(given[question.id]) ? given[question.id] : [];
    const selected = [...new Set(rawSelected.filter((id) => typeof id === 'string' && validOptionIds.has(id)))];
    const correctIds = question.options.filter((option) => option.is_correct).map((option) => option.id);
    const isCorrect = selected.length === correctIds.length && correctIds.every((id) => selected.includes(id));
    return { question_id: question.id, selected_option_ids: selected, is_correct: isCorrect };
  });

  const correctCount = detail.filter((entry) => entry.is_correct).length;
  const totalCount = questions.length;
  const scorePercent = totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 10000) / 100;

  return { detail, correctCount, totalCount, scorePercent, passed: scorePercent >= passThreshold };
}

// Un « essai » = un QCM effectivement PASSÉ (passage terminé). Un lien envoyé mais jamais utilisé,
// expiré ou remplacé n'est pas un essai : il figure dans l'historique, sans numéro.
// attempts : les passages d'UNE réalisation (une personne dans une session), dans n'importe quel
// ordre. Retourne la liste triée par date d'envoi, chaque passage terminé portant son numéro d'essai
// (1, 2, 3… dans l'ordre où ils ont été passés).
export function numberAttempts(attempts) {
  const byCompletion = attempts
    .filter((attempt) => attempt.completed_at)
    .sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at) || String(a.id).localeCompare(String(b.id)));
  const numberById = new Map(byCompletion.map((attempt, index) => [attempt.id, index + 1]));

  return [...attempts]
    .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at) || String(a.id).localeCompare(String(b.id)))
    .map((attempt) => ({ ...attempt, attempt_number: numberById.get(attempt.id) || null }));
}

// Bilan chiffré : essais passés, réussites, échecs.
export function summarizeAttempts(attempts) {
  const completed = attempts.filter((attempt) => attempt.completed_at);
  const successes = completed.filter((attempt) => attempt.passed === true).length;
  return { total: completed.length, successes, failures: completed.length - successes };
}

const plural = (count, word) => `${count} ${word}${count > 1 ? 's' : ''}`;

// « 3 essais : 1 réussite, 2 échecs »
export function describeAttemptsSummary({ total, successes, failures }) {
  if (total === 0) return 'Aucun essai passé';
  return `${plural(total, 'essai')} : ${plural(successes, 'réussite')}, ${plural(failures, 'échec')}`;
}

// Ligne ajoutée aux notes d'évaluation de la réalisation à CHAQUE essai (une ligne par essai, jamais
// remplacées : c'est la trace de tous les passages, réussis ou non).
export function quizNoteLine({ attemptNumber, correctCount, totalCount, scorePercent, passThreshold, passed }) {
  return `QCM en ligne — essai n°${attemptNumber} : ${correctCount}/${totalCount} (${scorePercent} %) — seuil ${passThreshold} % — ${passed ? 'réussi' : 'non réussi'}`;
}
