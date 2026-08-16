import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const APPROVER_ROLES = ['owner', 'admin', 'manager', 'member'];

router.use(requireAuth);

// GET /api/categories — liste des catégories du tenant
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('document_categories')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les catégories.' });
  }

  res.json(data);
});

// POST /api/categories — création
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('required_approver_role').optional({ values: 'falsy' }).isIn(APPROVER_ROLES).withMessage('Rôle approbateur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, required_approver_role: requiredApproverRole } = req.body;

    const { data, error } = await supabase
      .from('document_categories')
      .insert({ tenant_id: req.tenantId, name, color: color || null, required_approver_role: requiredApproverRole || null })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création de la catégorie.' });
    }

    res.status(201).json(data);
  }
);

// PUT /api/categories/:id — mise à jour
router.put(
  '/:id',
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('required_approver_role').optional({ values: 'falsy' }).isIn(APPROVER_ROLES).withMessage('Rôle approbateur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, required_approver_role: requiredApproverRole } = req.body;

    const { data, error } = await supabase
      .from('document_categories')
      .update({ name, color: color || null, required_approver_role: requiredApproverRole || null })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Catégorie introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/categories/:id — suppression
router.delete('/:id', async (req, res) => {
  const { error, count } = await supabase
    .from('document_categories')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la catégorie.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  res.status(204).send();
});

export default router;
