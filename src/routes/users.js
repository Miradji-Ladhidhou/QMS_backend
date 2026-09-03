import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendEmail } from '../services/email.js';
import { renderTemplate } from '../services/renderTemplate.js';

const router = Router();
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'member'];
const DIGEST_FREQUENCIES = ['immediate', 'daily', 'weekly'];
const NOTIFICATION_PREFERENCE_FIELDS = [
  'email_documents_to_review',
  'email_capa_overdue',
  'email_training_renewal',
  'email_approval_requests',
  'email_task_due',
  'email_procedure_review',
  'digest_frequency',
];

router.use(requireAuth);

// GET /api/users — membres du tenant (utilisé pour les sélecteurs d'assignation et la gestion des utilisateurs)
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, role, is_active, training_exempt, training_exempt_reason, job_title')
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
    body('email_task_due').optional().isBoolean().withMessage('Valeur invalide.'),
    body('email_procedure_review').optional().isBoolean().withMessage('Valeur invalide.'),
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

// Génère un lien d'invitation Supabase (sans envoi via GoTrue — son SMTP n'est pas configuré,
// ni en local ni forcément en prod) puis l'envoie nous-mêmes via Resend, avec notre propre
// template, comme le reste des notifications de l'app.
export async function sendInviteEmail({ email, fullName, tenantId }) {
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      data: { full_name: fullName },
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
    },
  });

  if (linkError) {
    return { error: linkError };
  }

  const { data: tenant } = await supabase.from('tenants').select('name').eq('id', tenantId).single();

  const html = renderTemplate('invite', {
    fullName,
    tenantName: tenant?.name || 'QMS SaaS',
    inviteUrl: linkData.properties.action_link,
  });

  await sendEmail(email, `Invitation à rejoindre ${tenant?.name || 'QMS SaaS'}`, html);

  return { userId: linkData.user.id };
}

// POST /api/users/invite — invite un nouvel utilisateur par email (admin uniquement)
router.post(
  '/invite',
  requireRole('admin'),
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

    let inviteResult;
    try {
      inviteResult = await sendInviteEmail({ email, fullName, tenantId: req.tenantId });
    } catch (err) {
      console.error("Échec de l'envoi de l'email d'invitation :", err);
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    if (inviteResult.error) {
      if (/already registered|already exists/i.test(inviteResult.error.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    const userId = inviteResult.userId;

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
router.post('/:id/resend-invite', requireRole('admin'), async (req, res) => {
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

  try {
    const inviteResult = await sendInviteEmail({
      email: authData.user.email,
      fullName: target.full_name,
      tenantId: req.tenantId,
    });
    if (inviteResult.error) throw inviteResult.error;
  } catch (err) {
    console.error("Échec du renvoi de l'email d'invitation :", err);
    return res.status(500).json({ error: "Erreur lors du renvoi de l'invitation." });
  }

  res.json({ ok: true });
});

// PATCH /api/users/:id — modifie le rôle et/ou le statut actif/inactif d'un utilisateur (admin uniquement)
router.patch(
  '/:id',
  requireRole('admin'),
  [
    body('role').optional().isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
    body('is_active').optional().isBoolean().withMessage('Valeur invalide.'),
    body('training_exempt').optional().isBoolean().withMessage('Valeur invalide.'),
    body('training_exempt_reason').optional({ values: 'falsy' }).trim().isLength({ max: 300 }),
    body('job_title').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const patchableFields = ['role', 'is_active', 'training_exempt', 'training_exempt_reason', 'job_title'];
    if (!patchableFields.some((field) => field in req.body)) {
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
      update.role = req.body.role;
    }

    if ('is_active' in req.body) {
      if (target.id === req.user.id) {
        return res.status(403).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
      }
      update.is_active = req.body.is_active;
    }

    if ('training_exempt' in req.body) {
      update.training_exempt = req.body.training_exempt;
    }

    if ('training_exempt_reason' in req.body) {
      update.training_exempt_reason = req.body.training_exempt_reason || null;
    }

    if ('job_title' in req.body) {
      update.job_title = req.body.job_title || null;
    }

    const { data, error } = await supabase
      .from('users')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('id, full_name, role, is_active, training_exempt, training_exempt_reason, job_title')
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
    }

    res.json(data);
  }
);

// DELETE /api/users/:id — suppression DÉFINITIVE (admin uniquement), distincte de la
// désactivation ci-dessus (réversible). Supprime le compte Supabase Auth, ce qui cascade
// automatiquement (voir schema.sql) sur la ligne users, ses appartenances de groupe,
// préférences de notification, catégorie personnelle "Uniquement moi" etc. — SAUF
// document_approvals, dont approver_id passe à NULL (ON DELETE SET NULL, pas CASCADE) : la
// décision/signature d'une approbation déjà rendue doit survivre à la suppression du compte
// qui l'a rendue, exigence de traçabilité QMS. Les autres références (created_by, assigned_to,
// lead_auditor...) passent aussi à NULL, jamais en cascade — aucune donnée métier n'est perdue.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(403).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
  }

  const { data: target, error: targetError } = await supabase
    .from('users')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (targetError || !target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }

  const { error } = await supabase.auth.admin.deleteUser(req.params.id);
  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du compte.' });
  }

  res.status(204).end();
});

export default router;
