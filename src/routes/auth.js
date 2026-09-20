import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { logActivity } from '../services/activityLog.js';

const router = Router();

// Toujours exportée : réutilisée par superAdmin.js pour la création de tenant (seul point
// d'entrée restant, l'inscription publique /register a été retirée).
export function slugify(text) {
  return text
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
