import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { sendEmail } from '../services/email.js';
import { renderTemplate } from '../services/renderTemplate.js';
import { getUserEmail } from '../services/notificationHelpers.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';
import { buildTrainingQuizWord } from '../services/trainingQuizWord.js';
import { generateQuizToken, hashQuizToken, normalizeEmail, validateQuestions, QUIZ_LINK_TTL_HOURS } from '../services/trainingQuiz.js';

// Monté sur /api/trainings à côté de routes/trainings.js (voir app.js) : le QCM d'une formation,
// l'envoi des liens de passage et l'export d'audit. La page publique que la personne ouvre depuis
// son email est dans routes/publicQuiz.js.
const router = Router();

// Garde appliquée route par route (jamais router.use) : ce routeur partage le préfixe
// /api/trainings avec routes/trainings.js, et un router.use ici s'appliquerait à TOUTES les
// requêtes /api/trainings/* — y compris la liste des formations, que voient aussi les membres.
// Le QCM contient les bonnes réponses : jamais visible d'un simple membre, et envoyer des liens
// engage l'évaluation des salariés — même périmètre que l'enregistrement des réalisations.
const guards = [requireAuth, requireMenuVisible('trainings'), requireRole('admin', 'manager')];

const MAX_INVITES_PER_CALL = 200;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function findTraining(tenantId, trainingId) {
  const { data } = await supabase.from('trainings').select('id, title').eq('tenant_id', tenantId).eq('id', trainingId).maybeSingle();
  return data;
}

// GET /api/trainings/:id/quiz — le QCM (avec les bonnes réponses) ou null s'il n'existe pas encore.
router.get('/:id/quiz', guards, async (req, res) => {
  const training = await findTraining(req.tenantId, req.params.id);
  if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

  const { data, error } = await supabase
    .from('training_quizzes')
    .select('id, training_id, pass_threshold, questions, updated_at')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', training.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: 'Impossible de récupérer le QCM.' });
  res.json(data);
});

// PUT /api/trainings/:id/quiz — crée ou remplace le QCM de la formation. Les passages déjà faits ou
// envoyés gardent leur propre copie (quiz_snapshot) : modifier le QCM n'a d'effet que sur les
// prochains envois.
router.put(
  '/:id/quiz',
  guards,
  [body('pass_threshold').isInt({ min: 1, max: 100 }).withMessage('Le seuil de réussite doit être compris entre 1 et 100 %.').toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }

    const training = await findTraining(req.tenantId, req.params.id);
    if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

    const parsed = validateQuestions(req.body.questions);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { data, error } = await supabase
      .from('training_quizzes')
      .upsert(
        {
          tenant_id: req.tenantId,
          training_id: training.id,
          pass_threshold: req.body.pass_threshold,
          questions: parsed.questions,
          updated_by: req.user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'training_id' }
      )
      .select('id, training_id, pass_threshold, questions, updated_at')
      .single();

    if (error) return res.status(500).json({ error: "Erreur lors de l'enregistrement du QCM." });
    res.json(data);
  }
);

// GET /api/trainings/:id/quiz/attempts — tous les passages (envoyés, en attente, terminés) de
// cette formation, sans le contenu du QCM ni les réponses (voir l'export Word pour le détail).
router.get('/:id/quiz/attempts', guards, async (req, res) => {
  const { data, error } = await supabase
    .from('training_quiz_attempts')
    .select('id, record_id, email, sent_at, expires_at, completed_at, correct_count, total_count, score_percent, passed, pass_threshold')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', req.params.id)
    .order('sent_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'Impossible de récupérer les passages du QCM.' });
  res.json(data);
});

// POST /api/trainings/:id/quiz/invites — envoie à chaque personne (une réalisation = une personne
// dans une session) un lien email valable 48 h. items : [{ record_id, email? }]. Pour un salarié
// sans compte, email est l'adresse saisie à l'envoi (enregistrée sur sa fiche) ; pour un compte,
// c'est toujours l'adresse du compte. Un renvoi invalide les liens en attente de la même
// réalisation. Réponse : un résultat par réalisation (sent / no_email / failed / not_found).
router.post(
  '/:id/quiz/invites',
  guards,
  [
    body('items').isArray({ min: 1, max: MAX_INVITES_PER_CALL }).withMessage(`Sélectionnez entre 1 et ${MAX_INVITES_PER_CALL} personnes.`),
    body('items.*.record_id').isUUID().withMessage('Identifiant de réalisation invalide.'),
    body('items.*.email').optional({ nullable: true, values: 'falsy' }).trim().matches(EMAIL_PATTERN).withMessage('Adresse email invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg, details: errors.array() });
    }

    const training = await findTraining(req.tenantId, req.params.id);
    if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

    const { data: quiz } = await supabase
      .from('training_quizzes')
      .select('pass_threshold, questions')
      .eq('tenant_id', req.tenantId)
      .eq('training_id', training.id)
      .maybeSingle();
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(400).json({ error: "Créez d'abord le QCM de cette formation (au moins une question)." });
    }

    const items = req.body.items;
    const recordIds = [...new Set(items.map((item) => item.record_id))];
    const [{ data: records }, { data: tenant }] = await Promise.all([
      supabase
        .from('training_records')
        .select('id, user_id, employee_id, user:users(id, full_name), employee:employees(id, full_name, email)')
        .eq('tenant_id', req.tenantId)
        .eq('training_id', training.id)
        .in('id', recordIds),
      supabase.from('tenants').select('name').eq('id', req.tenantId).single(),
    ]);
    const recordById = new Map((records || []).map((record) => [record.id, record]));

    const expiresAt = new Date(Date.now() + QUIZ_LINK_TTL_HOURS * 60 * 60 * 1000);
    const results = [];

    for (const item of items) {
      const record = recordById.get(item.record_id);
      if (!record) {
        results.push({ record_id: item.record_id, status: 'not_found' });
        continue;
      }

      const personName = record.user?.full_name || record.employee?.full_name || 'Participant';
      let email;
      if (record.user_id) {
        email = await getUserEmail(record.user_id);
      } else {
        email = item.email || record.employee?.email || null;
        // L'adresse saisie à l'envoi est mémorisée sur la fiche du salarié : inutile de la
        // ressaisir aux prochaines sessions.
        if (email && item.email && item.email !== record.employee?.email) {
          await supabase.from('employees').update({ email: item.email }).eq('tenant_id', req.tenantId).eq('id', record.employee_id);
        }
      }

      if (!email) {
        results.push({ record_id: record.id, status: 'no_email', person_name: personName });
        continue;
      }

      // Un seul lien actif par réalisation : renvoyer invalide le précédent (jamais supprimé —
      // un passage envoyé reste conservé).
      await supabase
        .from('training_quiz_attempts')
        .update({ expires_at: new Date().toISOString() })
        .eq('tenant_id', req.tenantId)
        .eq('record_id', record.id)
        .is('completed_at', null)
        .gt('expires_at', new Date().toISOString());

      const token = generateQuizToken();
      const { data: attempt, error: insertError } = await supabase
        .from('training_quiz_attempts')
        .insert({
          tenant_id: req.tenantId,
          training_id: training.id,
          record_id: record.id,
          token_hash: hashQuizToken(token),
          email: normalizeEmail(email),
          person_name: personName,
          quiz_snapshot: quiz.questions,
          pass_threshold: quiz.pass_threshold,
          sent_by: req.user.id,
          expires_at: expiresAt.toISOString(),
        })
        .select('id')
        .single();

      if (insertError || !attempt) {
        results.push({ record_id: record.id, status: 'failed', person_name: personName });
        continue;
      }

      try {
        const html = renderTemplate('trainingQuizInvite', {
          fullName: escapeHtml(personName),
          trainingTitle: escapeHtml(training.title),
          tenantName: escapeHtml(tenant?.name || 'QMS SaaS'),
          email: escapeHtml(normalizeEmail(email)),
          quizUrl: `${process.env.FRONTEND_URL}/quiz/${token}`,
          expiresAt: escapeHtml(expiresAt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })),
        });
        await sendEmail(email, `QCM de la formation « ${training.title} »`, html);
        results.push({ record_id: record.id, status: 'sent', person_name: personName, email: normalizeEmail(email), attempt_id: attempt.id });
      } catch {
        // Email non parti : on retire le passage pour ne pas laisser un lien valide que personne
        // n'a reçu.
        await supabase.from('training_quiz_attempts').delete().eq('id', attempt.id);
        results.push({ record_id: record.id, status: 'failed', person_name: personName });
      }
    }

    res.json({ results, expires_at: expiresAt.toISOString() });
  }
);

// GET /api/trainings/:id/quiz/attempts/:attemptId/word — compte rendu d'audit d'un passage terminé :
// questions, réponses de la personne, bonnes réponses, taux de réussite.
router.get('/:id/quiz/attempts/:attemptId/word', guards, async (req, res) => {
  const { data: attempt, error } = await supabase
    .from('training_quiz_attempts')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', req.params.id)
    .eq('id', req.params.attemptId)
    .maybeSingle();

  if (error || !attempt) return res.status(404).json({ error: 'Passage introuvable.' });
  if (!attempt.completed_at) return res.status(409).json({ error: "Ce QCM n'a pas encore été passé." });

  const [{ data: training }, { data: tenant }, { data: record }] = await Promise.all([
    supabase.from('trainings').select('title').eq('id', attempt.training_id).single(),
    supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single(),
    supabase.from('training_records').select('session:training_sessions(session_date)').eq('id', attempt.record_id).maybeSingle(),
  ]);
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);

  const buffer = await buildTrainingQuizWord({
    tenantName: tenant?.name,
    tenantLogo,
    trainingTitle: training?.title || 'Formation',
    sessionDate: record?.session?.session_date || null,
    attempt,
  });

  const safeName = `QCM-${(attempt.person_name || 'participant').replace(/[^A-Za-z0-9À-ÿ_-]+/g, '_')}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`);
  res.send(buffer);
});

export default router;
