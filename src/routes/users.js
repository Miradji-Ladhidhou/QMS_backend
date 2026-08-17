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

// GET /api/users — membres du tenant (utilisé pour les sélecteurs d'assignation et la gestion des utilisateurs)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, is_active')
    .eq('tenant_id', req.tenantId)
    .order('full_name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs.' });
  }

  // L'email et le statut d'invitation vivent dans auth.users, pas dans public.users —
  // un appel admin par utilisateur (liste de tenant, donc de petite taille).
  const withAuthInfo = await Promise.all(
    data.map(async (member) => {
      const { data: authData } = await supabase.auth.admin.getUserById(member.id);
      return {
        ...member,
        email: authData?.user?.email || null,
        invitation_pending: !!authData?.user && !authData.user.last_sign_in_at,
      };
    })
  );

  res.json(withAuthInfo);
});

// GET /api/users/me — profil de l'utilisateur authentifié
router.get('/me', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, tenant_id, is_super_admin, is_active')
    .eq('id', req.user.id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Profil introuvable.' });
  }

  res.json({ ...data, email: req.user.email });
});

// PATCH /api/users/me — modifie son propre nom complet
router.patch(
  '/me',
  [body('full_name').trim().notEmpty().withMessage('Le nom complet est requis.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('users')
      .update({ full_name: req.body.full_name })
      .eq('id', req.user.id)
      .select('id, full_name, role')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour du profil.' });
    }

    res.json(data);
  }
);

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

// POST /api/users/:id/resend-invite — renvoie l'email d'invitation (admin uniquement, tant que non confirmé)
router.post('/:id/resend-invite', requireRole('owner', 'admin'), async (req, res) => {
  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('id, full_name')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (targetError || !target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const { data: authData, error: authError } = await supabase.auth.admin.getUserById(req.params.id);

  if (authError || !authData?.user?.email) {
    return res.status(404).json({ error: 'Compte introuvable.' });
  }

  if (authData.user.last_sign_in_at) {
    return res.status(400).json({ error: 'Cet utilisateur a déjà activé son compte.' });
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(authData.user.email, {
    data: { full_name: target.full_name },
  });

  if (inviteError) {
    return res.status(500).json({ error: "Erreur lors du renvoi de l'invitation." });
  }

  res.json({ ok: true });
});

// POST /api/users/:id/transfer-ownership — le owner actuel cède son rôle à un autre membre (owner uniquement)
router.post('/:id/transfer-ownership', requireRole('owner'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Vous êtes déjà propriétaire.' });
  }

  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('id, is_active')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (targetError || !target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  if (!target.is_active) {
    return res.status(400).json({ error: 'Ce compte est désactivé.' });
  }

  const { error: rpcError } = await supabase.rpc('transfer_ownership', {
    p_tenant_id: req.tenantId,
    p_current_owner_id: req.user.id,
    p_new_owner_id: req.params.id,
  });

  if (rpcError) {
    return res.status(500).json({ error: 'Erreur lors du transfert de propriété.' });
  }

  res.json({ ok: true });
});

// PATCH /api/users/:id — modifie le rôle et/ou le statut actif/inactif d'un utilisateur (admin uniquement)
router.patch(
  '/:id',
  requireRole('owner', 'admin'),
  [
    body('role').optional().isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    if (!('role' in req.body) && !('is_active' in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
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

    const update = {};

    if ('role' in req.body) {
      if (target.role === 'owner') {
        return res.status(403).json({ error: 'Le rôle du propriétaire ne peut pas être modifié.' });
      }
      update.role = req.body.role;
    }

    if ('is_active' in req.body) {
      if (target.role === 'owner') {
        return res.status(403).json({ error: 'Le propriétaire ne peut pas être désactivé.' });
      }
      if (target.id === req.user.id) {
        return res.status(403).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      }
      update.is_active = req.body.is_active;
    }

    const { data, error } = await supabase
      .from('users')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('id, full_name, role, is_active')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    res.json(data);
  }
);

export default router;
