// Check-list (QCM) d'audit : réponses possibles et bilan chiffré.
export const CHECKLIST_ANSWERS = ['conform', 'nonconform', 'na'];
export const CHECKLIST_ANSWER_LABELS = { conform: 'Conforme', nonconform: 'Non conforme', na: 'Sans objet' };
export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_QUESTION_LENGTH = 500;
export const MAX_OBSERVATION_LENGTH = 2000;

// Bilan d'une check-list. Le taux de conformité porte sur les réponses « qui comptent » : conforme
// / (conforme + non conforme) — une question « sans objet » n'est ni une réussite ni un échec, et une
// question sans réponse n'est pas encore évaluée. null tant qu'aucune réponse ne compte.
export function summarizeChecklist(items) {
  const count = (answer) => items.filter((item) => item.answer === answer).length;
  const conform = count('conform');
  const nonconform = count('nonconform');
  const na = count('na');
  const evaluated = conform + nonconform;
  return {
    total: items.length,
    answered: conform + nonconform + na,
    conform,
    nonconform,
    na,
    conformity_percent: evaluated === 0 ? null : Math.round((conform / evaluated) * 1000) / 10,
  };
}

// Nettoie une liste de questions proposées (saisie collée ou réponse de l'IA) : chaînes non vides,
// espaces et puces/numérotations de tête retirés, doublons supprimés (sans tenir compte de la casse),
// longueur bornée. `existing` : questions déjà présentes, à ne pas reproposer.
export function cleanQuestions(rawQuestions, existing = []) {
  if (!Array.isArray(rawQuestions)) return [];
  const seen = new Set(existing.map((question) => question.trim().toLowerCase()));
  const cleaned = [];
  for (const raw of rawQuestions) {
    if (typeof raw !== 'string') continue;
    const question = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!question || question.length > MAX_QUESTION_LENGTH) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(question);
  }
  return cleaned;
}
