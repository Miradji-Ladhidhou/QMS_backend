import { describe, it, expect } from 'vitest';
import { gradeQuiz, validateQuestions, toPublicQuestions, hashQuizToken, generateQuizToken, formatDateTimeInZone, formatDeadline, numberAttempts, summarizeAttempts, describeAttemptsSummary, quizNoteLine, MAX_QUESTIONS } from './trainingQuiz.js';

const QUESTIONS = [
  { id: 'q1', text: 'Une seule', options: [{ id: 'a', label: 'A', is_correct: true }, { id: 'b', label: 'B', is_correct: false }] },
  { id: 'q2', text: 'Plusieurs', options: [{ id: 'a', label: 'A', is_correct: true }, { id: 'b', label: 'B', is_correct: true }, { id: 'c', label: 'C', is_correct: false }] },
  { id: 'q3', text: 'Troisième', options: [{ id: 'a', label: 'A', is_correct: false }, { id: 'b', label: 'B', is_correct: true }] },
];

describe('gradeQuiz', () => {
  it('tout juste = 100 %, réussi', () => {
    const graded = gradeQuiz(QUESTIONS, { q1: ['a'], q2: ['a', 'b'], q3: ['b'] }, 80);
    expect(graded).toMatchObject({ correctCount: 3, totalCount: 3, scorePercent: 100, passed: true });
  });

  it('pas de point partiel : il manque une bonne réponse, ou une mauvaise est cochée en plus → fausse', () => {
    expect(gradeQuiz(QUESTIONS, { q1: ['a'], q2: ['a'], q3: ['b'] }, 50).detail[1].is_correct).toBe(false);
    expect(gradeQuiz(QUESTIONS, { q1: ['a'], q2: ['a', 'b', 'c'], q3: ['b'] }, 50).detail[1].is_correct).toBe(false);
    // Tout cocher ne rapporte rien.
    expect(gradeQuiz(QUESTIONS, { q1: ['a', 'b'], q2: ['a', 'b', 'c'], q3: ['a', 'b'] }, 50).correctCount).toBe(0);
  });

  it('réponses absentes, mal typées, ids inconnus ou doublons : jamais d\'erreur, comptées fausses', () => {
    expect(gradeQuiz(QUESTIONS, undefined, 50).scorePercent).toBe(0);
    expect(gradeQuiz(QUESTIONS, null, 50).scorePercent).toBe(0);
    expect(gradeQuiz(QUESTIONS, 'texte', 50).scorePercent).toBe(0);
    expect(gradeQuiz(QUESTIONS, { q1: 'a', q2: { a: 1 }, q3: [42, null, 'zzz'] }, 50).scorePercent).toBe(0);
    // Un id coché deux fois compte pour un seul.
    expect(gradeQuiz(QUESTIONS, { q1: ['a', 'a'], q2: ['a', 'b'], q3: ['b', 'b'] }, 80).scorePercent).toBe(100);
    // Une question inexistante dans les réponses est ignorée.
    expect(gradeQuiz(QUESTIONS, { fantome: ['a'], q1: ['a'] }, 10).detail).toHaveLength(3);
  });

  it('arrondi à 2 décimales et seuil inclusif', () => {
    const oneOfThree = gradeQuiz(QUESTIONS, { q1: ['a'] }, 34);
    expect(oneOfThree.scorePercent).toBe(33.33);
    expect(oneOfThree.passed).toBe(false);
    expect(gradeQuiz(QUESTIONS, { q1: ['a'], q2: ['a', 'b'] }, 66.67).passed).toBe(true);
    expect(gradeQuiz(QUESTIONS, { q1: ['a'], q2: ['a', 'b'] }, 67).passed).toBe(false);
    // Seuil atteint pile.
    expect(gradeQuiz(QUESTIONS.slice(0, 2), { q1: ['a'] }, 50).passed).toBe(true);
  });
});

describe('validateQuestions', () => {
  const ok = { text: 'Question ?', options: [{ label: 'A', is_correct: true }, { label: 'B' }] };

  it('accepte un QCM valide et génère les ids manquants', () => {
    const { questions, error } = validateQuestions([ok]);
    expect(error).toBeUndefined();
    expect(questions[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(questions[0].options.map((o) => o.is_correct)).toEqual([true, false]);
  });

  it('ids dupliqués (questions ou réponses) : régénérés pour rester uniques', () => {
    const { questions } = validateQuestions([
      { id: 'x', text: 'Q1', options: [{ id: 'o', label: 'A', is_correct: true }, { id: 'o', label: 'B' }] },
      { id: 'x', text: 'Q2', options: [{ label: 'A', is_correct: true }, { label: 'B' }] },
    ]);
    expect(new Set(questions.map((q) => q.id)).size).toBe(2);
    expect(new Set(questions[0].options.map((o) => o.id)).size).toBe(2);
  });

  it('ids non conformes (caractères spéciaux, trop longs) : remplacés', () => {
    const { questions } = validateQuestions([{ id: '<script>', text: 'Q', options: [{ id: 'a'.repeat(200), label: 'A', is_correct: true }, { label: 'B' }] }]);
    expect(questions[0].id).not.toContain('<');
    expect(questions[0].options[0].id.length).toBeLessThanOrEqual(64);
  });

  it('is_correct doit être exactement true (une chaîne "true" ne compte pas)', () => {
    const { error } = validateQuestions([{ text: 'Q', options: [{ label: 'A', is_correct: 'true' }, { label: 'B', is_correct: 1 }] }]);
    expect(error).toMatch(/bonne réponse/);
  });

  it('refuse : vide, non-tableau, énoncé vide/trop long, réponses < 2 ou > 6, réponse vide, > 50 questions', () => {
    expect(validateQuestions([]).error).toBeTruthy();
    expect(validateQuestions('x').error).toBeTruthy();
    expect(validateQuestions(null).error).toBeTruthy();
    expect(validateQuestions([{ text: '  ', options: ok.options }]).error).toMatch(/énoncé/);
    expect(validateQuestions([{ text: 'x'.repeat(501), options: ok.options }]).error).toMatch(/trop long/);
    expect(validateQuestions([{ text: 'Q', options: [{ label: 'A', is_correct: true }] }]).error).toMatch(/entre 2 et 6/);
    const seven = Array.from({ length: 7 }, (_, i) => ({ label: `R${i}`, is_correct: i === 0 }));
    expect(validateQuestions([{ text: 'Q', options: seven }]).error).toMatch(/entre 2 et 6/);
    expect(validateQuestions([{ text: 'Q', options: [{ label: 'A', is_correct: true }, { label: ' ' }] }]).error).toMatch(/vide/);
    expect(validateQuestions(Array.from({ length: MAX_QUESTIONS + 1 }, () => ok)).error).toMatch(/50/);
    expect(validateQuestions([null]).error).toBeTruthy();
  });
});

describe('toPublicQuestions', () => {
  it('ne contient jamais is_correct et indique si plusieurs réponses sont attendues', () => {
    const pub = toPublicQuestions(QUESTIONS);
    expect(JSON.stringify(pub)).not.toContain('is_correct');
    expect(pub.map((q) => q.multiple)).toEqual([false, true, false]);
  });
});

describe('jetons', () => {
  it('uniques, longs, et hashés de façon stable (SHA-256 hex) sans que le hash révèle le jeton', () => {
    const a = generateQuizToken();
    const b = generateQuizToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashQuizToken(a)).toBe(hashQuizToken(a));
    expect(hashQuizToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashQuizToken(a)).not.toContain(a);
  });
});

describe('fuseau horaire de l\'entreprise', () => {
  it('affiche l\'heure dans le fuseau demandé et l\'indique (jamais celle du serveur)', () => {
    expect(formatDeadline('2026-09-22T10:03:00Z', 'Indian/Reunion')).toBe('22 septembre 2026 à 14:03 UTC+4');
    expect(formatDeadline('2026-09-22T10:03:00Z', 'Europe/Paris')).toBe('22 septembre 2026 à 12:03 UTC+2');
    expect(formatDeadline('2026-01-15T12:00:00Z', 'Europe/Paris')).toContain('13:00');
  });

  it('fuseau absent ou invalide : UTC, sans erreur', () => {
    for (const zone of [undefined, null, '', 'Nimporte/Quoi']) {
      expect(formatDeadline('2026-09-22T10:03:00Z', zone)).toBe('22 septembre 2026 à 10:03 UTC');
    }
    expect(formatDateTimeInZone('2026-09-22T10:03:00Z', 'Indian/Reunion', { hour: '2-digit', minute: '2-digit' })).toBe('14:03');
  });
});

describe('numérotation et bilan des essais', () => {
  const at = (id, sentH, doneH, passed) => ({
    id,
    sent_at: `2026-05-04T${String(sentH).padStart(2, '0')}:00:00Z`,
    completed_at: doneH === null ? null : `2026-05-04T${String(doneH).padStart(2, '0')}:30:00Z`,
    passed,
  });

  it('numérote seulement les passages TERMINÉS, dans l\'ordre où ils ont été passés', () => {
    // Envoyés dans l'ordre 1,2,3,4 ; le 2 n'a jamais été utilisé ; le 4 a été passé avant le 3.
    const numbered = numberAttempts([at('d', 4, 5, true), at('a', 1, 1, false), at('b', 2, null, null), at('c', 3, 8, false)]);
    expect(numbered.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']); // trié par envoi
    expect(Object.fromEntries(numbered.map((entry) => [entry.id, entry.attempt_number]))).toEqual({ a: 1, b: null, c: 3, d: 2 });
  });

  it('bilan : essais, réussites et échecs (un lien non utilisé n\'est pas un essai)', () => {
    const summary = summarizeAttempts([at('a', 1, 1, false), at('b', 2, null, null), at('c', 3, 4, false), at('d', 5, 6, true)]);
    expect(summary).toEqual({ total: 3, successes: 1, failures: 2 });
    expect(describeAttemptsSummary(summary)).toBe('3 essais : 1 réussite, 2 échecs');
  });

  it('accords singulier/pluriel et aucun essai', () => {
    expect(describeAttemptsSummary({ total: 1, successes: 1, failures: 0 })).toBe('1 essai : 1 réussite, 0 échec');
    expect(describeAttemptsSummary({ total: 0, successes: 0, failures: 0 })).toBe('Aucun essai passé');
    expect(describeAttemptsSummary(summarizeAttempts([]))).toBe('Aucun essai passé');
  });

  it('la ligne de note porte le numéro d\'essai', () => {
    expect(quizNoteLine({ attemptNumber: 2, correctCount: 1, totalCount: 2, scorePercent: 50, passThreshold: 80, passed: false })).toBe(
      'QCM en ligne — essai n°2 : 1/2 (50 %) — seuil 80 % — non réussi'
    );
  });
});
