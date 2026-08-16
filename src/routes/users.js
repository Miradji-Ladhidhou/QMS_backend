import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
const ASSIGNABLE_ROLES = ['admin', 'manager', 'member'];

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
