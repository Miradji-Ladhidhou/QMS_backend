import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const ASSIGNABLE_ROLES = ['admin', 'manager', 'member'];
const DIGEST_FREQUENCIES = ['immediate', 'daily', 'weekly'];
const NOTIFICATION_PREFERENCE_FIELDS = [
  'email_documents_to_review',
  'email_capa_overdue',
  'email_training_renewal',
  'email_approval_requests',
  'digest_frequency',
];

router.use(requireAuth);

// GET /api/users — membres du tenant (utilisé pour les sélecteurs d'assignation)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role')
    .eq('tenant_id', req.tenantId)
    .order('full_name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs.' });
  }

  res.json(data);
});

// GET /api/users/me — profil de l'utilisateur authentifié
router.get('/me', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, tenant_id')
    .eq('id', req.user.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Profil introuvable.' });
  }

  res.json(data);
});

// GET /api/users/me/notification-preferences — crée les préférences par défaut si absentes
router.get('/me/notification-preferences', async (req, res) => {
  const { data, error } = await supabase
    .from('user_notification_preferences')
    .select('*')
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les préférences de notification.' });
  }

  if (data) {
    return res.json(data);
  }

  const { data: created, error: createError } = await supabase
    .from('user_notification_preferences')
    .insert({ user_id: req.user.id, tenant_id: req.tenantId })
    .select()
    .single();

  if (createError) {
    return res.status(500).json({ error: 'Impossible de créer les préférences de notification.' });
  }

  res.json(created);
});

// PATCH /api/users/me/notification-preferences
router.patch(
  '/me/notification-preferences',
  [
    body('email_documents_to_review').optional().isBoolean().withMessage('Valeur invalide.'),
    body('email_capa_overdue').optional().isBoolean().withMessage('Valeur invalide.'),
    body('email_training_renewal').optional().isBoolean().withMessage('Valeur invalide.'),
    body('email_approval_requests').optional().isBoolean().withMessage('Valeur invalide.'),
    body('digest_frequency').optional({ values: 'falsy' }).isIn(DIGEST_FREQUENCIES).withMessage('Fréquence invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const update = {};
    for (const field of NOTIFICATION_PREFERENCE_FIELDS) {
      if (field in req.body) {
        update[field] = req.body[field];
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('user_notification_preferences')
      .upsert({ user_id: req.user.id, tenant_id: req.tenantId, ...update }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour des préférences.' });
    }

    res.json(data);
  }
);

// POST /api/users/invite — invite un nouvel utilisateur par email (admin uniquement)
router.post(
  '/invite',
  requireRole('owner', 'admin'),
  [
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('full_name').trim().notEmpty().withMessage('Le nom complet est requis.'),
    body('role').optional({ values: 'falsy' }).isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { email, full_name: fullName, role } = req.body;

    const { data: inviteData, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
    });

    if (inviteError) {
      if (/already registered|already exists/i.test(inviteError.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    const userId = inviteData.user.id;

    const { error: profileError } = await supabase.from('users').insert({
      id: userId,
      tenant_id: req.tenantId,
      full_name: fullName,
      role: role || 'member',
    });

    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
    }

    res.status(201).json({ id: userId, email, full_name: fullName, role: role || 'member' });
  }
);

// PATCH /api/users/:id — modifie le rôle d'un utilisateur (admin uniquement)
router.patch(
  '/:id',
  requireRole('owner', 'admin'),
  [body('role').isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: target, error: targetError } = await supabase
      .from('users')
      .select('id, role')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (targetError || !target) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    if (target.role === 'owner') {
      return res.status(403).json({ error: 'Le rôle du propriétaire ne peut pas être modifié.' });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ role: req.body.role })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('id, full_name, role')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour du rôle.' });
    }

    res.json(data);
  }
);

export default router;
