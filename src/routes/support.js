import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  const { data, error } = await supabase.from('support_tickets').select('*').eq('tenant_id', req.tenantId).order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Impossible de récupérer vos tickets.' });
  res.json(data || []);
});

router.post('/', requireRole('admin', 'manager'), [body('subject').trim().notEmpty().isLength({ max: 200 }), body('message').trim().notEmpty().isLength({ max: 5000 }), body('priority').optional().isIn(['low', 'normal', 'high', 'urgent'])], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Sujet ou message invalide.', details: errors.array() });
  const { data, error } = await supabase.from('support_tickets').insert({ tenant_id: req.tenantId, created_by: req.user.id, subject: req.body.subject, message: req.body.message, priority: req.body.priority || 'normal' }).select().single();
  if (error) return res.status(500).json({ error: 'Impossible de créer le ticket.' });
  res.status(201).json(data);
});

export default router;