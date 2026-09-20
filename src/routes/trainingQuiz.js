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
import {
  formatDeadline,
  numberAttempts,
  summarizeAttempts,
  generateQuizToken,
  hashQuizToken,
  normalizeEmail,
  validateQuestions,
  QUIZ_LINK_TTL_HOURS,
} from '../services/trainingQuiz.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { validateSignatureImage } from '../services/signatureImage.js';

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
const SEND_CONCURRENCY = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Formation du tenant, ou null si elle n'existe pas OU si sa catégorie est restreinte et que
// l'appelant n'y a pas accès (un manager ne doit pas lire le QCM d'une formation qu'il ne peut pas
// voir dans la liste — voir GET /api/trainings). Même 404 dans les deux cas : on ne révèle pas
// l'existence d'une formation restreinte.
async function findTraining(req, trainingId) {
  const { data } = await supabase
    .from('trainings')
    .select('id, title, description, instructor, category_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', trainingId)
    .maybeSingle();
  if (!data) return null;

  const allowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  return allowed ? data : null;
}

// GET /api/trainings/:id/quiz — le QCM (avec les bonnes réponses) ou null s'il n'existe pas encore.
router.get('/:id/quiz', guards, async (req, res) => {
  const training = await findTraining(req, req.params.id);
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

    const training = await findTraining(req, req.params.id);
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

// Signature du formateur : image PNG enregistrée une fois par formation, ajoutée automatiquement sur
// le compte rendu Word de chaque QCM RÉUSSI (voir GET .../attempts/:attemptId/word). Réservée
// admin/manager, comme le reste du QCM ; jamais renvoyée par la liste des formations (seulement un
// booléen has_instructor_signature, voir routes/trainings.js).
router.get('/:id/instructor-signature', guards, async (req, res) => {
  const training = await findTraining(req, req.params.id);
  if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

  const { data } = await supabase
    .from('training_instructor_signatures')
    .select('image, updated_at')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', training.id)
    .maybeSingle();
  res.json(data ? { image: data.image, updated_at: data.updated_at } : null);
});

router.put('/:id/instructor-signature', guards, async (req, res) => {
  const training = await findTraining(req, req.params.id);
  if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

  const parsed = validateSignatureImage(req.body?.image);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { error } = await supabase.from('training_instructor_signatures').upsert(
    { training_id: training.id, tenant_id: req.tenantId, image: parsed.dataUrl, updated_by: req.user.id, updated_at: new Date().toISOString() },
    { onConflict: 'training_id' }
  );
  if (error) return res.status(500).json({ error: "Impossible d'enregistrer la signature." });
  res.json({ has_instructor_signature: true });
});

router.delete('/:id/instructor-signature', guards, async (req, res) => {
  const training = await findTraining(req, req.params.id);
  if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

  const { error } = await supabase.from('training_instructor_signatures').delete().eq('tenant_id', req.tenantId).eq('training_id', training.id);
  if (error) return res.status(500).json({ error: 'Impossible de supprimer la signature.' });
  res.json({ has_instructor_signature: false });
});

// GET /api/trainings/:id/quiz/attempts — tous les passages (envoyés, en attente, terminés) de
// cette formation, sans le contenu du QCM ni les réponses (voir l'export Word pour le détail).
router.get('/:id/quiz/attempts', guards, async (req, res) => {
  const training = await findTraining(req, req.params.id);
  if (!training) return res.status(404).json({ error: 'Formation introuvable.' });

  const { data, error } = await supabase
    .from('training_quiz_attempts')
    .select('id, record_id, email, sent_at, expires_at, completed_at, correct_count, total_count, score_percent, passed, pass_threshold')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', training.id)
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

    const training = await findTraining(req, req.params.id);
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

    // Une seule entrée par réalisation : un doublon enverrait deux emails et le second lien
    // invaliderait aussitôt le premier.
    const items = [...new Map(req.body.items.map((item) => [item.record_id, item])).values()];
    const recordIds = items.map((item) => item.record_id);
    const [{ data: records }, { data: tenant }] = await Promise.all([
      supabase
        .from('training_records')
        .select('id, user_id, employee_id, user:users(id, full_name), employee:employees(id, full_name, email)')
        .eq('tenant_id', req.tenantId)
        .eq('training_id', training.id)
        .in('id', recordIds),
      supabase.from('tenants').select('name, timezone').eq('id', req.tenantId).single(),
    ]);
    const recordById = new Map((records || []).map((record) => [record.id, record]));

    const expiresAt = new Date(Date.now() + QUIZ_LINK_TTL_HOURS * 60 * 60 * 1000);

    async function inviteOne(item) {
      const record = recordById.get(item.record_id);
      if (!record) return { record_id: item.record_id, status: 'not_found' };

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

      if (!email) return { record_id: record.id, status: 'no_email', person_name: personName };

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
          // Objet/contenu et formateur figés à l'envoi (pièce d'audit, comme quiz_snapshot).
          training_info: { title: training.title, description: training.description || null, instructor: training.instructor || null },
        })
        .select('id')
        .single();

      if (insertError || !attempt) return { record_id: record.id, status: 'failed', person_name: personName };

      try {
        const html = renderTemplate('trainingQuizInvite', {
          fullName: escapeHtml(personName),
          trainingTitle: escapeHtml(training.title),
          tenantName: escapeHtml(tenant?.name || 'QMS SaaS'),
          email: escapeHtml(normalizeEmail(email)),
          quizUrl: `${process.env.FRONTEND_URL}/quiz/${token}`,
          expiresAt: escapeHtml(formatDeadline(expiresAt, tenant?.timezone)),
        });
        await sendEmail(email, `QCM de la formation « ${training.title.replace(/[\r\n]+/g, ' ')} »`, html);
        return { record_id: record.id, status: 'sent', person_name: personName, email: normalizeEmail(email), attempt_id: attempt.id };
      } catch {
        // Email non parti : on retire le passage pour ne pas laisser un lien valide que personne
        // n'a reçu.
        await supabase.from('training_quiz_attempts').delete().eq('id', attempt.id);
        return { record_id: record.id, status: 'failed', person_name: personName };
      }
    }

    // Par paquets de SEND_CONCURRENCY : un envoi d'email prend ~1 s, et une session peut compter des
    // dizaines de personnes — en série, la requête dépasserait le délai de l'hébergeur. L'ordre des
    // résultats suit celui des personnes envoyées.
    const results = [];
    for (let start = 0; start < items.length; start += SEND_CONCURRENCY) {
      results.push(...(await Promise.all(items.slice(start, start + SEND_CONCURRENCY).map(inviteOne))));
    }

    res.json({ results, expires_at: expiresAt.toISOString() });
  }
);

// GET /api/trainings/:id/quiz/attempts/:attemptId/word — compte rendu d'audit d'un passage terminé :
// questions, réponses de la personne, bonnes réponses, taux de réussite.
router.get('/:id/quiz/attempts/:attemptId/word', guards, async (req, res) => {
  const visibleTraining = await findTraining(req, req.params.id);
  if (!visibleTraining) return res.status(404).json({ error: 'Formation introuvable.' });

  const { data: attempt, error } = await supabase
    .from('training_quiz_attempts')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('training_id', visibleTraining.id)
    .eq('id', req.params.attemptId)
    .maybeSingle();

  if (error || !attempt) return res.status(404).json({ error: 'Passage introuvable.' });
  if (!attempt.completed_at) return res.status(409).json({ error: "Ce QCM n'a pas encore été passé." });

  const [{ data: training }, { data: tenant }, { data: record }] = await Promise.all([
    supabase.from('trainings').select('title').eq('id', attempt.training_id).single(),
    supabase.from('tenants').select('name, logo_url, timezone').eq('id', req.tenantId).single(),
    supabase.from('training_records').select('session:training_sessions(session_date)').eq('id', attempt.record_id).maybeSingle(),
  ]);
  const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);

  // Objet/contenu et formateur tels qu'à l'envoi ; les passages plus anciens (sans copie) retombent
  // sur les valeurs actuelles de la formation.
  const trainingInfo = attempt.training_info || { title: training?.title, description: visibleTraining.description || null, instructor: visibleTraining.instructor || null };

  // Signature du formateur : uniquement si le QCM est réussi. La copie figée à la réussite fait foi ;
  // un passage réussi avant l'enregistrement de la signature retombe sur la signature actuelle.
  let instructorSignature = null;
  if (attempt.passed === true) {
    instructorSignature = attempt.instructor_signature;
    if (!instructorSignature) {
      const { data: current } = await supabase.from('training_instructor_signatures').select('image').eq('training_id', attempt.training_id).maybeSingle();
      instructorSignature = current?.image || null;
    }
  }

  // Historique de TOUS les passages de cette réalisation (échecs comme réussites), pour tracer le
  // nombre d'essais de la personne dans cette session.
  const { data: historyRows } = await supabase
    .from('training_quiz_attempts')
    .select('id, sent_at, expires_at, completed_at, correct_count, total_count, score_percent, passed, pass_threshold')
    .eq('tenant_id', req.tenantId)
    .eq('record_id', attempt.record_id);
  const history = numberAttempts(historyRows || [attempt]);

  const buffer = await buildTrainingQuizWord({
    history,
    trainingInfo,
    employeeSignature: attempt.employee_signature,
    instructorSignature,
    tenantName: tenant?.name,
    tenantLogo,
    tenantTimezone: tenant?.timezone,
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
