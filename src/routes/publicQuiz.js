import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { validateSignatureImage } from '../services/signatureImage.js';
import {
  gradeQuiz,
  hashQuizToken,
  MAX_FAILED_EMAIL_ATTEMPTS,
  normalizeEmail,
  quizNoteLine,
  toPublicQuestions,
} from '../services/trainingQuiz.js';

// Pages PUBLIQUES du QCM de formation (aucune authentification) : la personne arrive depuis le
// lien reçu par email (/quiz/:token côté frontend), confirme son adresse email, lit le résumé
// puis répond au QCM. Le jeton (256 bits, seul son hash est en base) identifie le passage ; il
// est valable 48 h, pour une seule tentative, et se verrouille après trop d'emails erronés.
// Monté avec son propre limiteur de débit (voir app.js).
const router = Router();

// Jamais mis en cache (navigateur, proxy) : la réponse contient le résumé et les questions d'une
// personne précise, derrière un lien à usage unique.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const ATTEMPT_COLUMNS =
  'id, tenant_id, training_id, record_id, email, person_name, quiz_snapshot, pass_threshold, expires_at, completed_at, failed_email_attempts';

// Jeton mal formé rejeté avant toute requête base : évite de hasher/chercher n'importe quoi.
function isPlausibleToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(token);
}

async function loadAttempt(token) {
  if (!isPlausibleToken(token)) return null;
  const { data, error } = await supabase.from('training_quiz_attempts').select(ATTEMPT_COLUMNS).eq('token_hash', hashQuizToken(token)).maybeSingle();
  // Une erreur base n'est PAS « lien inconnu » : la lever (500 via le gestionnaire global) plutôt
  // que d'afficher « Lien invalide » à quelqu'un dont le lien est bon, lors d'un incident passager.
  if (error) throw new Error(`Lecture du passage de QCM impossible : ${error.message}`);
  return data;
}

function attemptStatus(attempt) {
  if (attempt.completed_at) return 'completed';
  if (new Date(attempt.expires_at) <= new Date()) return 'expired';
  if (attempt.failed_email_attempts >= MAX_FAILED_EMAIL_ATTEMPTS) return 'locked';
  return 'valid';
}

const STATUS_CODES = { completed: 409, expired: 410, locked: 403 };
const STATUS_MESSAGES = {
  completed: 'Ce QCM a déjà été passé.',
  expired: 'Ce lien a expiré (validité de 48 h). Demandez un nouveau lien à votre responsable formation.',
  locked: 'Ce lien est verrouillé après trop de tentatives. Demandez un nouveau lien à votre responsable formation.',
};

// Incrémente le compteur d'emails erronés SANS perdre de comptage quand plusieurs requêtes arrivent
// en même temps : la mise à jour n'a lieu que si la valeur lue n'a pas bougé (verrouillage
// optimiste), sinon on relit et on recommence. Un simple « lire puis écrire n+1 » laisserait un
// script lancer 100 essais en parallèle en ne faisant avancer le compteur que de 1.
async function recordFailedEmailAttempt(attempt) {
  let current = attempt.failed_email_attempts;
  for (let retry = 0; retry < 8; retry += 1) {
    const { data } = await supabase
      .from('training_quiz_attempts')
      .update({ failed_email_attempts: current + 1 })
      .eq('id', attempt.id)
      .eq('failed_email_attempts', current)
      .select('failed_email_attempts')
      .maybeSingle();
    if (data) return data.failed_email_attempts;

    const { data: fresh } = await supabase.from('training_quiz_attempts').select('failed_email_attempts').eq('id', attempt.id).single();
    current = fresh?.failed_email_attempts ?? current + 1;
  }
  return current + 1;
}

// Contrôle commun à /start et /submit : lien inconnu, terminé, expiré, verrouillé ou email erroné.
// Retourne { attempt } quand tout est bon, sinon { status, body } à renvoyer tel quel.
async function authorizeAttempt(token, email) {
  const attempt = await loadAttempt(token);
  if (!attempt) return { status: 404, body: { error: 'Lien invalide.' } };

  const state = attemptStatus(attempt);
  if (state !== 'valid') return { status: STATUS_CODES[state], body: { error: STATUS_MESSAGES[state], state } };

  if (normalizeEmail(email) !== attempt.email) {
    const failed = await recordFailedEmailAttempt(attempt);
    const remaining = MAX_FAILED_EMAIL_ATTEMPTS - failed;
    return {
      status: 403,
      body: {
        error:
          remaining > 0
            ? `Adresse email incorrecte : saisissez celle à laquelle ce lien a été envoyé (${remaining} essai${remaining > 1 ? 's' : ''} restant${remaining > 1 ? 's' : ''}).`
            : STATUS_MESSAGES.locked,
        state: remaining > 0 ? 'valid' : 'locked',
      },
    };
  }

  return { attempt };
}

// GET /api/public/quiz/:token — état du lien, sans rien révéler du contenu (le résumé et les
// questions ne sont donnés qu'après confirmation de l'email, voir /start).
router.get('/:token', async (req, res) => {
  const attempt = await loadAttempt(req.params.token);
  if (!attempt) return res.status(404).json({ error: 'Lien invalide.' });

  const [{ data: tenant }, { data: training }] = await Promise.all([
    supabase.from('tenants').select('name').eq('id', attempt.tenant_id).single(),
    supabase.from('trainings').select('title').eq('id', attempt.training_id).single(),
  ]);

  res.json({ state: attemptStatus(attempt), tenant_name: tenant?.name || '', training_title: training?.title || '' });
});

// POST /api/public/quiz/:token/start { email } — après confirmation de l'email : le résumé de la
// formation et les questions (sans les bonnes réponses).
router.post('/:token/start', async (req, res) => {
  const result = await authorizeAttempt(req.params.token, req.body?.email);
  if (!result.attempt) return res.status(result.status).json(result.body);
  const { attempt } = result;

  const [{ data: tenant }, { data: training }] = await Promise.all([
    supabase.from('tenants').select('name').eq('id', attempt.tenant_id).single(),
    supabase.from('trainings').select('title, summary').eq('id', attempt.training_id).single(),
  ]);

  res.json({
    tenant_name: tenant?.name || '',
    training_title: training?.title || '',
    summary: training?.summary || '',
    person_name: attempt.person_name,
    pass_threshold: attempt.pass_threshold,
    expires_at: attempt.expires_at,
    questions: toPublicQuestions(attempt.quiz_snapshot),
  });
});

// POST /api/public/quiz/:token/submit { email, answers } — corrige, fige le résultat sur le passage
// (une seule tentative) et met à jour l'évaluation de la réalisation (réussie ou non).
router.post('/:token/submit', async (req, res) => {
  const result = await authorizeAttempt(req.params.token, req.body?.email);
  if (!result.attempt) return res.status(result.status).json(result.body);
  const { attempt } = result;

  // Signature manuscrite obligatoire : refusée AVANT de consommer l'unique tentative du lien, pour
  // que la personne puisse signer et revalider sans perdre son passage.
  const signature = validateSignatureImage(req.body?.signature);
  if (signature.error) {
    return res.status(400).json({ error: req.body?.signature ? signature.error : 'Signez dans le cadre avant de valider vos réponses.' });
  }

  const graded = gradeQuiz(attempt.quiz_snapshot, req.body?.answers, attempt.pass_threshold);

  // Réussite : la signature du formateur est copiée sur le passage à cet instant (jamais réécrite si
  // le formateur change ensuite de signature).
  let instructorSignature = null;
  if (graded.passed) {
    const { data: trainerSignature } = await supabase
      .from('training_instructor_signatures')
      .select('image')
      .eq('training_id', attempt.training_id)
      .maybeSingle();
    instructorSignature = trainerSignature?.image || null;
  }

  // completed_at IS NULL dans le filtre : deux envois simultanés ne peuvent pas tous deux
  // enregistrer un résultat, le second ne trouve plus rien à mettre à jour.
  const { data: saved, error } = await supabase
    .from('training_quiz_attempts')
    .update({
      completed_at: new Date().toISOString(),
      answers: graded.detail,
      correct_count: graded.correctCount,
      total_count: graded.totalCount,
      score_percent: graded.scorePercent,
      passed: graded.passed,
      employee_signature: signature.dataUrl,
      instructor_signature: instructorSignature,
    })
    .eq('id', attempt.id)
    .is('completed_at', null)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: "Impossible d'enregistrer votre résultat. Réessayez." });
  if (!saved) return res.status(409).json({ error: STATUS_MESSAGES.completed, state: 'completed' });

  // Met à jour la réalisation : evaluation_result (réussi / non réussi) et une ligne de synthèse
  // dans evaluation_notes, sans écraser une note saisie à la main par le responsable.
  const { data: record } = await supabase.from('training_records').select('evaluation_notes').eq('id', attempt.record_id).maybeSingle();
  const line = quizNoteLine({ ...graded, passThreshold: attempt.pass_threshold });
  const existingNotes = (record?.evaluation_notes || '').split('\n').filter((row) => row && !row.startsWith('QCM en ligne :'));
  const { error: recordError } = await supabase
    .from('training_records')
    .update({ evaluation_result: graded.passed, evaluation_notes: [...existingNotes, line].join('\n') })
    .eq('tenant_id', attempt.tenant_id)
    .eq('id', attempt.record_id);
  // Le résultat est déjà enregistré sur le passage (source de vérité de l'audit) : on ne fait pas
  // échouer la réponse à la personne, mais on trace l'incohérence pour qu'elle soit corrigeable.
  if (recordError) console.error(`QCM ${attempt.id} : réalisation ${attempt.record_id} non mise à jour :`, recordError.message);

  res.json({
    correct_count: graded.correctCount,
    total_count: graded.totalCount,
    score_percent: graded.scorePercent,
    pass_threshold: attempt.pass_threshold,
    passed: graded.passed,
  });
});

export default router;
