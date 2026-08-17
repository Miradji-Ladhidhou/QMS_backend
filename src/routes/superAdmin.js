import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
router.use(requireSuperAdmin);

// GET /api/super-admin/tenants — tous les tenants de la plateforme, avec le nombre
// d'utilisateurs de chacun. Contourne volontairement le filtre tenant_id habituel (c'est
// tout le sens de cette route) — le client supabase du backend utilise déjà service_role et
// n'est jamais bridé par RLS, seul requireSuperAdmin protège l'accès ici.
router.get('/tenants', async (req, res) => {
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, name, slug, plan, is_suspended, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les tenants.' });
  }

  const { data: users, error: usersError } = await supabase.from('users').select('tenant_id');

  if (usersError) {
    return res.status(500).json({ error: 'Impossible de récupérer les utilisateurs.' });
  }

  const userCountByTenant = {};
  for (const { tenant_id: tenantId } of users) {
    userCountByTenant[tenantId] = (userCountByTenant[tenantId] || 0) + 1;
  }

  res.json(tenants.map((tenant) => ({ ...tenant, user_count: userCountByTenant[tenant.id] || 0 })));
});

// PATCH /api/super-admin/tenants/:id — suspend ou réactive un tenant. Ne supprime ni ne
// modifie aucune autre donnée : requireAuth bloque simplement ses utilisateurs tant que
// is_suspended est vrai (voir middleware/auth.js).
router.patch(
  '/tenants/:id',
  [body('is_suspended').isBoolean().withMessage('Valeur invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('tenants')
      .update({ is_suspended: req.body.is_suspended })
      .eq('id', req.params.id)
      .select('id, name, slug, plan, is_suspended, created_at')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Tenant introuvable.' });
    }

    res.json(data);
  }
);

export default router;
