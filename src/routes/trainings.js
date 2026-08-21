import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { buildSkillMatrixPdf } from '../services/skillMatrixPdf.js';
import { buildAttendanceSheetPdf } from '../services/attendanceSheetPdf.js';
import { buildTrainingCertificatePdf } from '../services/trainingCertificatePdf.js';
import { fetchTenantLogoBuffer } from '../services/tenantLogo.js';

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

// Un compte (user_id) ou un salarié sans compte (employee_id), jamais les deux — voir la
// contrainte training_records_person_check. Sert de clé stable pour grouper par personne
// sans dépendre de laquelle des deux colonnes est renseignée.
function personKey(record) {
  return record.user_id ? `u:${record.user_id}` : `e:${record.employee_id}`;
}

// Ne garde que le dernier enregistrement par couple (formation, personne)
async function fetchLatestTrainingRecords(tenantId) {
  const { data: records, error } = await supabase
    .from('training_records')
    .select('training_id, user_id, employee_id, completed_at, next_due_date')
    .eq('tenant_id', tenantId);

  if (error) {
    throw new Error('Impossible de récupérer les réalisations de formation.');
  }

  const latestByPair = new Map();
  for (const record of records) {
    const key = `${record.training_id}:${personKey(record)}`;
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
    .select(
      '*, records:training_records(id, user_id, employee_id, completed_at, next_due_date, certificate_url, user:users(id, full_name), employee:employees(id, full_name))'
    )
    .eq('tenant_id', req.tenantId)
    .order('title', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les formations.' });
  }

  res.json(data);
});

// GET /api/trainings/matrix — vue croisée personnel x formations (comptes ET salariés sans
// compte, voir employees.js).
// Partagée entre GET /matrix (JSON) et GET /matrix/pdf (export imprimable) pour ne jamais
// laisser les deux vues diverger sur la logique de statut (à jour/bientôt/expiré/jamais).
async function buildMatrix(tenantId) {
  const [{ data: users, error: usersError }, { data: employees, error: employeesError }, { data: trainings, error: trainingsError }] =
    await Promise.all([
      supabase.from('users').select('id, full_name').eq('tenant_id', tenantId).eq('training_exempt', false),
      supabase.from('employees').select('id, full_name').eq('tenant_id', tenantId).eq('is_active', true).eq('training_exempt', false),
      supabase.from('trainings').select('id, title, frequency_months').eq('tenant_id', tenantId),
    ]);

  if (usersError || employeesError || trainingsError) {
    throw new Error('Impossible de construire la matrice des formations.');
  }

  const latestByPair = await fetchLatestTrainingRecords(tenantId);

  const today = new Date().toISOString().slice(0, 10);
  const soonThreshold = isoDateInDays(RENEWAL_WINDOW_DAYS);

  const people = [
    ...users.map((user) => ({ id: user.id, full_name: user.full_name, kind: 'user' })),
    ...employees.map((employee) => ({ id: employee.id, full_name: employee.full_name, kind: 'employee' })),
  ];

  return trainings.map((training) => ({
    training: { id: training.id, title: training.title },
    people: people.map((person) => {
      const key = `${training.id}:${person.kind === 'user' ? 'u' : 'e'}:${person.id}`;
      const record = latestByPair.get(key);

      if (!record) {
        return {
          person,
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
        person,
        status,
        last_completed_at: record.completed_at,
        next_due_date: record.next_due_date,
      };
    }),
  }));
}

router.get('/matrix', async (req, res) => {
  try {
    const matrix = await buildMatrix(req.tenantId);
    res.json(matrix);
  } catch (err) {
    // err.message est déjà un texte français sûr (voir buildMatrix/fetchLatestTrainingRecords
    // plus haut, jamais un message brut de Supabase) — mais rien n'était logué côté serveur
    // jusqu'ici en cas d'échec, seul le client le voyait.
    console.error('Échec de construction de la matrice des compétences :', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trainings/matrix/pdf — même matrice, mise en page imprimable (grille personnel ×
// formations paysage, paginée si trop large/haute). Placée juste après /matrix : chemin à
// deux segments, ne rentre pas en conflit avec une éventuelle route /:id ailleurs dans ce
// fichier (même raisonnement que /:id/pdf dans qqoqccp.js).
router.get('/matrix/pdf', async (req, res) => {
  try {
    const matrix = await buildMatrix(req.tenantId);
    const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
    const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
    const pdfBuffer = await buildSkillMatrixPdf({ tenantName: tenant?.name, tenantLogo, matrix });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="matrice-competences-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Échec de génération du PDF de la matrice des compétences :', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trainings/upcoming-renewals — renouvellements à échéance sous 60 jours
router.get('/upcoming-renewals', async (req, res) => {
  let latestByPair;
  try {
    latestByPair = await fetchLatestTrainingRecords(req.tenantId);
  } catch (err) {
    console.error('Échec de récupération des renouvellements de formation :', err);
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
  const userIds = [...new Set(upcoming.map((record) => record.user_id).filter(Boolean))];
  const employeeIds = [...new Set(upcoming.map((record) => record.employee_id).filter(Boolean))];

  const [
    { data: trainings, error: trainingsError },
    { data: users, error: usersError },
    { data: employees, error: employeesError },
  ] = await Promise.all([
    supabase.from('trainings').select('id, title').in('id', trainingIds),
    userIds.length ? supabase.from('users').select('id, full_name').in('id', userIds) : Promise.resolve({ data: [] }),
    employeeIds.length
      ? supabase.from('employees').select('id, full_name').in('id', employeeIds)
      : Promise.resolve({ data: [] }),
  ]);

  if (trainingsError || usersError || employeesError) {
    return res.status(500).json({ error: 'Impossible de récupérer les renouvellements à venir.' });
  }

  const trainingsById = new Map(trainings.map((training) => [training.id, training]));
  const usersById = new Map(users.map((user) => [user.id, user]));
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));

  const result = upcoming
    .map((record) => ({
      training: trainingsById.get(record.training_id),
      user: record.user_id ? usersById.get(record.user_id) : null,
      employee: record.employee_id ? employeesById.get(record.employee_id) : null,
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
    body('location').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    body('instructor').optional({ values: 'falsy' }).trim().isLength({ max: 200 }),
    body('duration').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, type, frequency_months: frequencyMonths, location, instructor, duration } = req.body;

    const { data, error } = await supabase
      .from('trainings')
      .insert({
        tenant_id: req.tenantId,
        title,
        type: type || null,
        frequency_months: frequencyMonths || null,
        location: location || null,
        instructor: instructor || null,
        duration: duration || null,
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la formation.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/trainings/:id — corrige le titre/type/fréquence/lieu/formateur/durée d'une
// formation (admin uniquement)
router.patch(
  '/:id',
  requireRole('admin', 'manager'),
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('type').optional({ values: 'falsy' }).trim(),
    body('frequency_months').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Fréquence invalide.'),
    body('location').optional({ nullable: true, values: 'falsy' }).trim().isLength({ max: 200 }),
    body('instructor').optional({ nullable: true, values: 'falsy' }).trim().isLength({ max: 200 }),
    body('duration').optional({ nullable: true, values: 'falsy' }).trim().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of ['title', 'type', 'frequency_months', 'location', 'instructor', 'duration']) {
      if (field in req.body) {
        update[field] = req.body[field] || null;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('trainings')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Formation introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/trainings/:id — supprime une formation et ses réalisations (admin uniquement)
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  const { data, error } = await supabase
    .from('trainings')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Formation introuvable.' });
  }

  res.status(204).end();
});

// POST /api/trainings/:id/records — enregistre une réalisation, calcule next_due_date
router.post(
  '/:id/records',
  [
    body('user_id').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur invalide.'),
    body('employee_id').optional({ values: 'falsy' }).isUUID().withMessage('Personne invalide.'),
    body('completed_at').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('certificate_url').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { user_id: userId, employee_id: employeeId, certificate_url: certificateUrl } = req.body;

    if ((userId && employeeId) || (!userId && !employeeId)) {
      return res.status(400).json({ error: 'Indiquez soit un utilisateur, soit une personne du personnel, pas les deux.' });
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

    const completedAt = req.body.completed_at || new Date().toISOString().slice(0, 10);
    const nextDueDate = training.frequency_months ? addMonths(completedAt, training.frequency_months) : null;

    const { data, error } = await supabase
      .from('training_records')
      .insert({
        tenant_id: req.tenantId,
        training_id: training.id,
        user_id: userId || null,
        employee_id: employeeId || null,
        completed_at: completedAt,
        next_due_date: nextDueDate,
        certificate_url: certificateUrl || null,
      })
      .select('*, user:users(id, full_name), employee:employees(id, full_name)')
      .single();

    if (error) {
      // Violation de training_records_user_unique/_employee_unique (voir schema.sql) : déjà
      // enregistré pour cette personne, cette formation, cette date.
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Cette personne a déjà une réalisation enregistrée pour cette formation à cette date.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la réalisation." });
    }

    res.status(201).json(data);
  }
);

// POST /api/trainings/:id/records/bulk — enregistre la même réalisation (même date) pour
// plusieurs personnes en un seul appel : cas d'une session de formation collective, où
// répéter POST /:id/records une fois par participant serait lent et non atomique côté UI.
router.post(
  '/:id/records/bulk',
  [
    body('user_ids').optional().isArray({ max: 500 }).withMessage('Liste d\'utilisateurs invalide.'),
    body('user_ids.*').isUUID().withMessage('Utilisateur invalide.'),
    body('employee_ids').optional().isArray({ max: 500 }).withMessage('Liste de personnel invalide.'),
    body('employee_ids.*').isUUID().withMessage('Personne invalide.'),
    body('completed_at').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const userIds = req.body.user_ids || [];
    const employeeIds = req.body.employee_ids || [];

    if (userIds.length === 0 && employeeIds.length === 0) {
      return res.status(400).json({ error: 'Sélectionnez au moins une personne.' });
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

    const completedAt = req.body.completed_at || new Date().toISOString().slice(0, 10);
    const nextDueDate = training.frequency_months ? addMonths(completedAt, training.frequency_months) : null;

    // Ignore silencieusement les personnes déjà enregistrées pour cette formation à cette date
    // (ex. réouverture du formulaire, re-sélection par erreur) plutôt que de faire échouer tout
    // le lot — voir training_records_user_unique/_employee_unique en filet de sécurité.
    const { data: existing, error: existingError } = await supabase
      .from('training_records')
      .select('user_id, employee_id')
      .eq('tenant_id', req.tenantId)
      .eq('training_id', training.id)
      .eq('completed_at', completedAt);

    if (existingError) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement des réalisations." });
    }

    const existingUserIds = new Set(existing.map((r) => r.user_id).filter(Boolean));
    const existingEmployeeIds = new Set(existing.map((r) => r.employee_id).filter(Boolean));

    const newUserIds = userIds.filter((id) => !existingUserIds.has(id));
    const newEmployeeIds = employeeIds.filter((id) => !existingEmployeeIds.has(id));
    const skippedUserIds = userIds.filter((id) => existingUserIds.has(id));
    const skippedEmployeeIds = employeeIds.filter((id) => existingEmployeeIds.has(id));

    const rows = [
      ...newUserIds.map((userId) => ({
        tenant_id: req.tenantId,
        training_id: training.id,
        user_id: userId,
        employee_id: null,
        completed_at: completedAt,
        next_due_date: nextDueDate,
      })),
      ...newEmployeeIds.map((employeeId) => ({
        tenant_id: req.tenantId,
        training_id: training.id,
        user_id: null,
        employee_id: employeeId,
        completed_at: completedAt,
        next_due_date: nextDueDate,
      })),
    ];

    if (rows.length === 0) {
      return res.status(409).json({
        error: 'Toutes les personnes sélectionnées ont déjà une réalisation enregistrée pour cette formation à cette date.',
      });
    }

    const { data, error } = await supabase
      .from('training_records')
      .insert(rows)
      .select('*, user:users(id, full_name), employee:employees(id, full_name)');

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement des réalisations." });
    }

    res.status(201).json({
      created: data,
      skipped: { user_ids: skippedUserIds, employee_ids: skippedEmployeeIds },
    });
  }
);

// PATCH /api/trainings/:id/records/:recordId — corrige une réalisation mal saisie ; recalcule
// next_due_date si la date de réalisation change (admin uniquement)
router.patch(
  '/:id/records/:recordId',
  requireRole('admin', 'manager'),
  [
    body('completed_at').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('certificate_url').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (!('completed_at' in req.body) && !('certificate_url' in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
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

    const update = {};
    if ('certificate_url' in req.body) {
      update.certificate_url = req.body.certificate_url || null;
    }
    if (req.body.completed_at) {
      update.completed_at = req.body.completed_at;
      update.next_due_date = training.frequency_months
        ? addMonths(req.body.completed_at, training.frequency_months)
        : null;
    }

    const { data, error } = await supabase
      .from('training_records')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('training_id', req.params.id)
      .eq('id', req.params.recordId)
      .select('*, user:users(id, full_name), employee:employees(id, full_name)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Réalisation introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/trainings/:id/records/:recordId — retire une réalisation (admin uniquement)
router.delete('/:id/records/:recordId', requireRole('admin', 'manager'), async (req, res) => {
  const { data, error } = await supabase
    .from('training_records')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('training_id', req.params.id)
    .eq('id', req.params.recordId)
    .select('id')
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Réalisation introuvable.' });
  }

  res.status(204).end();
});

// POST /api/trainings/:id/attendance-sheet/pdf — fiche de présence imprimable pour une session
// (nom + colonne signature vierge) : les noms sont résolus côté serveur à partir des id reçus
// (jamais du texte envoyé par le client), pour rester scopé au tenant comme tout le reste ici.
router.post(
  '/:id/attendance-sheet/pdf',
  [
    body('date').optional({ values: 'falsy' }).isISO8601().withMessage('Date invalide.'),
    body('user_ids').optional().isArray({ max: 500 }).withMessage('Liste d\'utilisateurs invalide.'),
    body('user_ids.*').isUUID().withMessage('Utilisateur invalide.'),
    body('employee_ids').optional().isArray({ max: 500 }).withMessage('Liste de personnel invalide.'),
    body('employee_ids.*').isUUID().withMessage('Personne invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const userIds = req.body.user_ids || [];
    const employeeIds = req.body.employee_ids || [];

    if (userIds.length === 0 && employeeIds.length === 0) {
      return res.status(400).json({ error: 'Sélectionnez au moins un participant.' });
    }

    const { data: training, error: trainingError } = await supabase
      .from('trainings')
      .select('id, title, type, location, instructor, duration')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (trainingError || !training) {
      return res.status(404).json({ error: 'Formation introuvable.' });
    }

    try {
      const [{ data: users }, { data: employees }, { data: tenant }] = await Promise.all([
        userIds.length
          ? supabase.from('users').select('id, full_name, job_title').eq('tenant_id', req.tenantId).in('id', userIds)
          : Promise.resolve({ data: [] }),
        employeeIds.length
          ? supabase.from('employees').select('id, full_name, job_title').eq('tenant_id', req.tenantId).in('id', employeeIds)
          : Promise.resolve({ data: [] }),
        supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single(),
      ]);

      const rows = [...(users || []), ...(employees || [])]
        .map((person) => ({ name: person.full_name, jobTitle: person.job_title || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

      const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
      const pdfBuffer = await buildAttendanceSheetPdf({
        tenantName: tenant?.name,
        tenantLogo,
        trainingTitle: training.title,
        trainingType: training.type,
        location: training.location,
        instructor: training.instructor,
        duration: training.duration,
        date: req.body.date || new Date().toISOString().slice(0, 10),
        rows,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="fiche-participation.pdf"');
      res.send(pdfBuffer);
    } catch (err) {
      console.error('Échec de génération de la fiche de participation :', err);
      res.status(500).json({ error: 'Impossible de générer la fiche de participation.' });
    }
  }
);

// GET /api/trainings/:id/records/:recordId/certificate/pdf — certificat de réussite pour une
// réalisation donnée (une personne, une formation, une date).
router.get('/:id/records/:recordId/certificate/pdf', async (req, res) => {
  const { data: record, error } = await supabase
    .from('training_records')
    .select(
      'completed_at, next_due_date, training:trainings(title), user:users(full_name), employee:employees(full_name)'
    )
    .eq('tenant_id', req.tenantId)
    .eq('training_id', req.params.id)
    .eq('id', req.params.recordId)
    .single();

  if (error || !record) {
    return res.status(404).json({ error: 'Réalisation introuvable.' });
  }

  const personName = record.user?.full_name || record.employee?.full_name || 'Personne inconnue';

  try {
    const { data: tenant } = await supabase.from('tenants').select('name, logo_url').eq('id', req.tenantId).single();
    const tenantLogo = await fetchTenantLogoBuffer(tenant?.logo_url);
    const pdfBuffer = await buildTrainingCertificatePdf({
      tenantName: tenant?.name,
      tenantLogo,
      personName,
      trainingTitle: record.training?.title || '',
      completedAt: record.completed_at,
      nextDueDate: record.next_due_date,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="certificat-reussite.pdf"');
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Échec de génération du certificat :', err);
    res.status(500).json({ error: 'Impossible de générer le certificat.' });
  }
});

export default router;
