import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { sendImmediateNotification } from '../services/notificationHelpers.js';

const router = Router();

const CAPA_STATUSES = ['open', 'in_progress', 'pending_verification', 'closed', 'overdue'];
const CAPA_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const PATCHABLE_FIELDS = ['status', 'priority', 'assigned_to', 'due_date'];

router.use(requireAuth);

// Notification immédiate (n'attend pas le batch quotidien) quand une CAPA est assignée.
// Réutilise le toggle "email_capa_overdue" : le modèle de préférences (Chantier 3.2) n'a
// pas de case dédiée "assignation", et c'est la plus proche sémantiquement.
async function notifyCapaAssigned(tenantId, capa) {
  if (!capa.assigned_to) return;

  await sendImmediateNotification({
    tenantId,
    userId: capa.assigned_to,
    prefField: 'email_capa_overdue',
    notificationType: 'capa_assigned',
    referenceId: capa.id,
    templateName: 'capaOverdue',
    subject: `Une CAPA vous a été assignée : ${capa.number}`,
    variables: {
      capaNumber: capa.number,
      capaTitle: capa.title,
      dueDate: capa.due_date || '—',
      capaUrl: `${process.env.FRONTEND_URL}/capas/${capa.id}`,
    },
    notificationTitle: 'CAPA assignée',
    notificationMessage: `${capa.number} — ${capa.title}`,
    notificationLink: `/capas/${capa.id}`,
  });
}

async function closeOverdueCapas(tenantId) {
  const today = new Date().toISOString().slice(0, 10);

  await supabase
    .from('capas')
    .update({ status: 'overdue' })
    .eq('tenant_id', tenantId)
    .lt('due_date', today)
    .not('status', 'in', '(closed,overdue)');
}

// GET /api/capas — liste avec le responsable assigné, statuts en retard mis à jour
router.get('/', async (req, res) => {
  await closeOverdueCapas(req.tenantId);

  const { data, error } = await supabase
    .from('capas')
    .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les CAPA.' });
  }

  res.json(data);
});

// GET /api/capas/:id — détail avec commentaires de suivi
router.get('/:id', async (req, res) => {
  const { data: capa, error } = await supabase
    .from('capas')
    .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !capa) {
    return res.status(404).json({ error: 'CAPA introuvable.' });
  }

  const { data: comments, error: commentsError } = await supabase
    .from('capa_comments')
    .select('*, author:users(id, full_name)')
    .eq('capa_id', capa.id)
    .order('created_at', { ascending: true });

  if (commentsError) {
    return res.status(500).json({ error: 'Impossible de récupérer les commentaires.' });
  }

  res.json({ ...capa, comments });
});

// POST /api/capas — création, numérotation automatique CAPA-{année}-{seq}
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('origin').optional({ values: 'falsy' }).trim(),
    body('ref_document').optional({ values: 'falsy' }).isUUID().withMessage('Document de référence invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_PRIORITIES).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { title, origin, ref_document: refDocument, priority, assigned_to: assignedTo, due_date: dueDate } = req.body;

    const { data, error } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        origin: origin || null,
        ref_document: refDocument || null,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        created_by: req.user.id,
      })
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    notifyCapaAssigned(req.tenantId, data).catch((err) =>
      console.error("Échec de la notification d'assignation CAPA :", err.message)
    );

    res.status(201).json(data);
  }
);

// PATCH /api/capas/:id — mise à jour du statut, de la priorité, de l'assignation ou de l'échéance
router.patch(
  '/:id',
  [
    body('status').optional({ values: 'falsy' }).isIn(CAPA_STATUSES).withMessage('Statut invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_PRIORITIES).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of PATCHABLE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    if (update.status === 'closed') {
      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('capas')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    if (update.assigned_to) {
      notifyCapaAssigned(req.tenantId, data).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    res.json(data);
  }
);

// POST /api/capas/:id/comments — ajoute un commentaire de suivi horodaté
router.post(
  '/:id/comments',
  [body('comment').trim().notEmpty().withMessage('Le commentaire ne peut pas être vide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (capaError || !capa) {
      return res.status(404).json({ error: 'CAPA introuvable.' });
    }

    const { data, error } = await supabase
      .from('capa_comments')
      .insert({
        tenant_id: req.tenantId,
        capa_id: capa.id,
        user_id: req.user.id,
        comment: req.body.comment,
      })
      .select('*, author:users(id, full_name)')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'ajout du commentaire." });
    }

    res.status(201).json(data);
  }
);

export default router;
