import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { sendEmail } from '../services/email.js';
import { renderTemplate } from '../services/renderTemplate.js';
import { logActivity } from '../services/activityLog.js';

const router = Router();

export function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Le mot de passe doit contenir au moins 8 caractères.'),
    body('fullName').trim().notEmpty().withMessage('Le nom complet est requis.'),
    body('companyName').trim().notEmpty().withMessage("Le nom de l'entreprise est requis."),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { email, password, fullName, companyName } = req.body;

    // 1. Création de l'utilisateur dans Supabase Auth, non confirmé. IMPORTANT : createUser()
    // (contrairement à generateLink() employé à l'étape 2) rejette proprement un email déjà
    // enregistré — c'est ce qui garantit que le userId manipulé ensuite est un compte tout
    // neuf, jamais un compte préexistant. generateLink('signup') seul, lui, est idempotent
    // silencieux sur un email déjà pris (même id renvoyé, aucune erreur) : l'utiliser en
    // première étape ferait courir le risque, sur une double inscription avec le même email,
    // de renvoyer l'id d'un compte tiers légitime — que le rollback plus bas supprimerait
    // ensuite en cas d'échec de création du profil (voir incident évité).
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
    });

    if (authError) {
      if (authError.code === 'email_exists' || /already (been )?registered|already exists/i.test(authError.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création du compte.' });
    }

    const userId = authData.user.id;

    // 2. Lien de confirmation pour le compte qu'on vient de créer (même mécanique que
    // sendInviteEmail dans users.js) — sans passer par le SMTP GoTrue (non configuré) : on
    // envoie nous-mêmes l'email via notre propre service, avec notre propre template.
    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'signup',
      email,
      password,
      options: { data: { full_name: fullName } },
    });

    if (linkError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du compte.' });
    }

    try {
      const html = renderTemplate('signup-confirmation', {
        fullName,
        tenantName: companyName,
        confirmUrl: linkData.properties.action_link,
      });
      await sendEmail(email, 'Confirmez votre adresse email — QMS SaaS', html);
    } catch (err) {
      console.error("Échec de l'envoi de l'email de confirmation :", err);
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'email de confirmation." });
    }

    const baseSlug = slugify(companyName);

    // 3. Création du tenant, avec repli sur un slug suffixé en cas de collision
    let tenant = null;
    let tenantError = null;

    for (let attempt = 0; attempt < 5 && !tenant; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

      const { data, error } = await supabase
        .from('tenants')
        .insert({ name: companyName, slug })
        .select()
        .single();

      if (!error) {
        tenant = data;
      } else if (error.code === '23505') {
        tenantError = error;
      } else {
        tenantError = error;
        break;
      }
    }

    if (!tenant) {
      await supabase.auth.admin.deleteUser(userId);
      const message =
        tenantError?.code === '23505'
          ? "Impossible de générer un identifiant unique pour cette entreprise, réessayez."
          : "Erreur lors de la création de l'entreprise.";
      return res.status(tenantError?.code === '23505' ? 409 : 500).json({ error: message });
    }

    // 4. Création du profil utilisateur, rattaché au tenant, en tant qu'admin — c'est la
    // personne qui vient de créer l'entreprise, donc son seul membre à ce stade.
    const { error: profileError } = await supabase.from('users').insert({
      id: userId,
      tenant_id: tenant.id,
      full_name: fullName,
      role: 'admin',
    });

    if (profileError) {
      await supabase.from('tenants').delete().eq('id', tenant.id);
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
    }

    return res.status(201).json({
      user: { id: userId, email, fullName },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      email_confirmation_required: true,
    });
  }
);

const ACTIVITY_TYPES = ['login_success', 'login_failed', 'logout', 'password_reset_requested', 'password_reset_completed'];
// Ces 3 types se produisent APRÈS l'établissement d'une session côté client (voir Login.jsx,
// ResetPassword.jsx, Layout.jsx#handleLogout, useInactivityLogout.js) : le jeton fourni est
// vérifié ici même, jamais un simple email déclaré par le client — sinon n'importe qui pourrait
// poster {type:'login_success', email:'quelqu-un-d-autre@x.com'} et polluer le journal
// d'activité d'un tiers. Les 2 autres types (login_failed, password_reset_requested) se
// produisent AVANT toute session : aucun jeton n'existe, résolution uniquement par email (voir
// lookup_user_by_email dans schema.sql).
const AUTHENTICATED_TYPES = ['login_success', 'logout', 'password_reset_completed'];
const ACTION_BY_TYPE = {
  login_success: 'LOGIN_SUCCESS',
  login_failed: 'LOGIN_FAILED',
  logout: 'LOGOUT',
  password_reset_requested: 'PASSWORD_RESET_REQUESTED',
  password_reset_completed: 'PASSWORD_RESET_COMPLETED',
};

// POST /api/auth/activity — journalise un événement d'authentification (voir
// services/activityLog.js, GET /api/super-admin/activity-log). La connexion/déconnexion/
// réinitialisation de mot de passe se font 100% côté client via le SDK Supabase Auth, jamais
// via ce backend (aucune route /login n'existe ni n'est nécessaire) — le frontend appelle
// cette route juste après chaque résultat, côté client (voir les 5 points d'appel : Login.jsx,
// Layout.jsx, useInactivityLogout.js, ForgotPassword.jsx, ResetPassword.jsx). Volontairement
// SANS requireAuth : login_failed/password_reset_requested n'ont par nature aucun jeton.
// Toujours 204, même en cas d'échec d'écriture interne (logActivity ne lève jamais) — jamais
// de fuite sur l'existence d'un compte via le code de statut ou le corps de la réponse.
router.post(
  '/activity',
  [
    body('type').isIn(ACTIVITY_TYPES).withMessage('Type invalide.'),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('reason').optional({ values: 'falsy' }).trim().isLength({ max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.' });
    }

    const { type, email, reason } = req.body;
    let actorId = null;
    let tenantId = null;
    let actorEmail = email || null;

    const authHeader = req.headers.authorization;
    if (AUTHENTICATED_TYPES.includes(type) && authHeader?.startsWith('Bearer ')) {
      const {
        data: { user },
      } = await supabase.auth.getUser(authHeader.slice('Bearer '.length));
      if (user) {
        actorId = user.id;
        actorEmail = user.email;
        const { data: profile } = await supabase.from('users').select('tenant_id').eq('id', user.id).maybeSingle();
        tenantId = profile?.tenant_id || null;
      }
    } else if (!AUTHENTICATED_TYPES.includes(type) && email) {
      const { data } = await supabase.rpc('lookup_user_by_email', { p_email: email });
      actorId = data?.[0]?.user_id || null;
      tenantId = data?.[0]?.tenant_id || null;
    }

    await logActivity({
      tenantId,
      actorId,
      actorEmail,
      action: ACTION_BY_TYPE[type],
      entityType: 'auth',
      entityId: null,
      metadata: reason ? { reason } : null,
      req,
    });

    res.status(204).end();
  }
);

export default router;
