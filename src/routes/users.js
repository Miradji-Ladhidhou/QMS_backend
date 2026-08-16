import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

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

export default router;
