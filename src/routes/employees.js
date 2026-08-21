import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);

// GET /api/employees — liste de tout le personnel du tenant, actif et inactif (tous les
// rôles, comme /services : la sélection d'un salarié pour enregistrer une formation doit
// être possible pour n'importe quel rôle autorisé à créer une réalisation).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, email, is_active, training_exempt, training_exempt_reason, job_title')
    .eq('tenant_id', req.tenantId)
    .order('full_name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le personnel.' });
  }

  res.json(data);
});

// POST /api/employees — création (admin uniquement)
router.post(
  '/',
  requireRole('admin'),
  [
    body('full_name').trim().notEmpty().withMessage('Le nom est requis.'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Adresse email invalide.'),
    body('job_title').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('employees')
      .insert({
        tenant_id: req.tenantId,
        full_name: req.body.full_name,
        email: req.body.email || null,
        job_title: req.body.job_title || null,
      })
      .select('id, full_name, email, is_active, training_exempt, training_exempt_reason, job_title')
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de la création de l'entrée personnel." });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/employees/:id — renomme et/ou active/désactive (admin uniquement)
router.patch(
  '/:id',
  requireRole('admin'),
  [
    body('full_name').optional().trim().notEmpty().withMessage('Le nom ne peut pas être vide.'),
    body('email').optional({ nullable: true, values: 'falsy' }).isEmail().withMessage('Adresse email invalide.'),
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

    const patchableFields = ['full_name', 'email', 'is_active', 'training_exempt', 'training_exempt_reason', 'job_title'];
    if (!patchableFields.some((field) => field in req.body)) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const update = {};
    if ('full_name' in req.body) update.full_name = req.body.full_name;
    if ('email' in req.body) update.email = req.body.email || null;
    if ('is_active' in req.body) update.is_active = req.body.is_active;
    if ('training_exempt' in req.body) update.training_exempt = req.body.training_exempt;
    if ('training_exempt_reason' in req.body) update.training_exempt_reason = req.body.training_exempt_reason || null;
    if ('job_title' in req.body) update.job_title = req.body.job_title || null;

    const { data, error } = await supabase
      .from('employees')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select('id, full_name, email, is_active, training_exempt, training_exempt_reason, job_title')
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Entrée personnel introuvable.' });
    }

    res.json(data);
  }
);

// DELETE /api/employees/:id — refuse si des réalisations de formation existent (admin uniquement)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: employee, error: employeeError } = await supabase
    .from('employees')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (employeeError || !employee) {
    return res.status(404).json({ error: 'Entrée personnel introuvable.' });
  }

  const { count, error: countError } = await supabase
    .from('training_records')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', req.tenantId)
    .eq('employee_id', req.params.id);

  if (countError) {
    return res.status(500).json({ error: 'Impossible de vérifier les réalisations rattachées.' });
  }

  if (count > 0) {
    return res.status(409).json({
      error: `${count} réalisation(s) de formation sont rattachées à cette personne. Désactivez-la plutôt que de la supprimer.`,
    });
  }

  const { error: deleteError } = await supabase
    .from('employees')
    .delete()
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id);

  if (deleteError) {
    return res.status(500).json({ error: "Erreur lors de la suppression de l'entrée personnel." });
  }

  res.status(204).end();
});

export default router;
