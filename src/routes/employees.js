import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Toutes les tables qui référencent une entrée personnel (voir schema.sql) — le nom de colonne
// varie selon le module, contrairement à service_id sur services.js. training_records est en
// on delete cascade (l'historique de formation disparaîtrait sans ce garde-fou) ; les deux
// autres en on delete set null (la trace serait juste détachée en silence).
const EMPLOYEE_REFERENCES = [
  { table: 'training_records', column: 'employee_id', singular: 'réalisation de formation', plural: 'réalisations de formation' },
  { table: 'accidents', column: 'injured_employee_id', singular: 'accident du travail', plural: 'accidents du travail' },
  { table: 'tasks', column: 'assigned_employee_id', singular: 'tâche assignée', plural: 'tâches assignées' },
];

function formatFrenchList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

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

// DELETE /api/employees/:id — refuse si des éléments d'un des 3 modules qui référencent cette
// personne y sont encore rattachés (admin uniquement)
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

  const results = await Promise.all(
    EMPLOYEE_REFERENCES.map(({ table, column }) =>
      supabase.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', req.tenantId).eq(column, req.params.id)
    )
  );

  const countError = results.find((result) => result.error);
  if (countError) {
    return res.status(500).json({ error: 'Impossible de vérifier les éléments rattachés à cette personne.' });
  }

  const parts = EMPLOYEE_REFERENCES.map(({ singular, plural }, index) => ({ count: results[index].count || 0, singular, plural }))
    .filter(({ count }) => count > 0)
    .map(({ count, singular, plural }) => `${count} ${count > 1 ? plural : singular}`);

  if (parts.length > 0) {
    return res.status(409).json({
      error: `${formatFrenchList(parts)} sont rattaché(s) à cette personne. Désactivez-la plutôt que de la supprimer.`,
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
