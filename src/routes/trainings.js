import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const RENEWAL_WINDOW_DAYS = 60;
const STATUS = {
  UP_TO_DATE: 'up_to_date',
  DUE_SOON: 'due_soon',
  EXPIRED: 'expired',
  NEVER_DONE: 'never_done',
};

router.use(requireAuth);

function addMonths(dateStr, months) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + months);
  return date.toISOString().slice(0, 10);
}

function isoDateInDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

// Ne garde que le dernier enregistrement par couple (formation, utilisateur)
async function fetchLatestTrainingRecords(tenantId) {
  const { data: records, error } = await supabase
    .from('training_records')
    .select('training_id, user_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);

  if (error) {
    throw new Error('Impossible de récupérer les réalisations de formation.');
  }

  const latestByPair = new Map();
  for (const record of records) {
    const key = `${record.training_id}:${record.user_id}`;
    const existing = latestByPair.get(key);
    if (!existing || record.completed_at > existing.completed_at) {
      latestByPair.set(key, record);
    }
  }

  return latestByPair;
}

// GET /api/trainings — liste avec réalisations
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('trainings')
    .select('*, records:training_records(id, user_id, completed_at, next_due_date, certificate_url, user:users(id, full_name))')
    .eq('tenant_id', req.tenantId)
    .order('title', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les formations.' });
  }

  res.json(data);
});

// GET /api/trainings/matrix — vue croisée utilisateurs x formations
router.get('/matrix', async (req, res) => {
  const [{ data: users, error: usersError }, { data: trainings, error: trainingsError }] = await Promise.all([
    supabase.from('users').select('id, full_name').eq('tenant_id', req.tenantId),
    supabase.from('trainings').select('id, title, frequency_months').eq('tenant_id', req.tenantId),
  ]);

  if (usersError || trainingsError) {
    return res.status(500).json({ error: 'Impossible de construire la matrice des formations.' });
  }

  let latestByPair;
  try {
    latestByPair = await fetchLatestTrainingRecords(req.tenantId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const today = new Date().toISOString().slice(0, 10);
  const soonThreshold = isoDateInDays(RENEWAL_WINDOW_DAYS);

  const matrix = trainings.map((training) => ({
    training: { id: training.id, title: training.title },
    users: users.map((user) => {
      const record = latestByPair.get(`${training.id}:${user.id}`);

      if (!record) {
        return {
          user: { id: user.id, full_name: user.full_name },
          status: STATUS.NEVER_DONE,
          last_completed_at: null,
          next_due_date: null,
        };
      }

      let status = STATUS.UP_TO_DATE;
      if (record.next_due_date) {
        if (record.next_due_date < today) {
          status = STATUS.EXPIRED;
        } else if (record.next_due_date <= soonThreshold) {
          status = STATUS.DUE_SOON;
        }
      }

      return {
        user: { id: user.id, full_name: user.full_name },
        status,
        last_completed_at: record.completed_at,
        next_due_date: record.next_due_date,
      };
    }),
  }));

  res.json(matrix);
});

// GET /api/trainings/upcoming-renewals — renouvellements à échéance sous 60 jours
router.get('/upcoming-renewals', async (req, res) => {
  let latestByPair;
  try {
    latestByPair = await fetchLatestTrainingRecords(req.tenantId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const today = new Date().toISOString().slice(0, 10);
  const windowEnd = isoDateInDays(RENEWAL_WINDOW_DAYS);

  const upcoming = [...latestByPair.values()].filter(
    (record) => record.next_due_date && record.next_due_date >= today && record.next_due_date <= windowEnd
  );

  if (upcoming.length === 0) {
    return res.json([]);
  }

  const trainingIds = [...new Set(upcoming.map((record) => record.training_id))];
  const userIds = [...new Set(upcoming.map((record) => record.user_id))];

  const [{ data: trainings, error: trainingsError }, { data: users, error: usersError }] = await Promise.all([
    supabase.from('trainings').select('id, title').in('id', trainingIds),
    supabase.from('users').select('id, full_name').in('id', userIds),
  ]);

  if (trainingsError || usersError) {
    return res.status(500).json({ error: 'Impossible de récupérer les renouvellements à venir.' });
  }

  const trainingsById = new Map(trainings.map((training) => [training.id, training]));
  const usersById = new Map(users.map((user) => [user.id, user]));

  const result = upcoming
    .map((record) => ({
      training: trainingsById.get(record.training_id),
      user: usersById.get(record.user_id),
      last_completed_at: record.completed_at,
      next_due_date: record.next_due_date,
    }))
    .sort((a, b) => (a.next_due_date > b.next_due_date ? 1 : -1));

  res.json(result);
});

// POST /api/trainings — création
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('type').optional({ values: 'falsy' }).trim(),
    body('frequency_months').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Fréquence invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, type, frequency_months: frequencyMonths } = req.body;

    const { data, error } = await supabase
      .from('trainings')
      .insert({
        tenant_id: req.tenantId,
        title,
        type: type || null,
        frequency_months: frequencyMonths || null,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la formation.' });
    }

    res.status(201).json(data);
  }
);

// POST /api/trainings/:id/records — enregistre une réalisation, calcule next_due_date
router.post(
  '/:id/records',
  [
    body('user_id').isUUID().withMessage('Utilisateur invalide.'),
    body('completed_at').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('certificate_url').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: training, error: trainingError } = await supabase
      .from('trainings')
      .select('id, frequency_months')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (trainingError || !training) {
      return res.status(404).json({ error: 'Formation introuvable.' });
    }

    const { user_id: userId, certificate_url: certificateUrl } = req.body;
    const completedAt = req.body.completed_at || new Date().toISOString().slice(0, 10);
    const nextDueDate = training.frequency_months ? addMonths(completedAt, training.frequency_months) : null;

    const { data, error } = await supabase
      .from('training_records')
      .insert({
        tenant_id: req.tenantId,
        training_id: training.id,
        user_id: userId,
        completed_at: completedAt,
        next_due_date: nextDueDate,
        certificate_url: certificateUrl || null,
      })
      .select('*, user:users(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la réalisation." });
    }

    res.status(201).json(data);
  }
);

export default router;
