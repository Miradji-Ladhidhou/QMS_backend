import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireModuleForWrites } from '../middleware/menuVisibility.js';
import { filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';
import { sendInviteEmail, ASSIGNABLE_ROLES } from './users.js';

const router = Router();

const EMPLOYEE_SELECT =
  'id, full_name, email, is_active, training_exempt, training_exempt_reason, job_title, category_id, category:categories(id, name, color, is_restricted, owner_user_id)';

// Toutes les tables qui référencent une entrée personnel (voir schema.sql) — le nom de colonne
// varie selon le module, contrairement à service_id sur services.js. training_records est en
// on delete cascade (l'historique de formation disparaîtrait sans ce garde-fou) ; les deux
// autres en on delete set null (la trace serait juste détachée en silence). userColumn est la
// colonne jumelle "personne avec compte" utilisée par la conversion en compte utilisateur.
const EMPLOYEE_REFERENCES = [
  { table: 'training_records', column: 'employee_id', userColumn: 'user_id', singular: 'réalisation de formation', plural: 'réalisations de formation' },
  { table: 'accidents', column: 'injured_employee_id', userColumn: 'injured_user_id', singular: 'accident du travail', plural: 'accidents du travail' },
  { table: 'tasks', column: 'assigned_employee_id', userColumn: 'assigned_to', singular: 'tâche assignée', plural: 'tâches assignées' },
];

function formatFrenchList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

router.use(requireAuth);
router.use(requireModuleForWrites('employees'));

// GET /api/employees — liste de tout le personnel du tenant, actif et inactif (tous les
// rôles, comme /services : la sélection d'un salarié pour enregistrer une formation doit
// être possible pour n'importe quel rôle autorisé à créer une réalisation).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select(EMPLOYEE_SELECT)
    .eq('tenant_id', req.tenantId)
    .order('full_name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer le personnel.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// POST /api/employees — création (admin uniquement)
router.post(
  '/',
  requireRole('admin'),
  [
    body('full_name').trim().notEmpty().withMessage('Le nom est requis.'),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('Adresse email invalide.'),
    body('job_title').optional({ values: 'falsy' }).trim().isLength({ max: 150 }),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Dossier invalide.'),
  ],
  requireValidCategoryId('employee'),
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
        category_id: req.body.category_id || null,
      })
      .select(EMPLOYEE_SELECT)
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
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Dossier invalide.'),
  ],
  requireValidCategoryId('employee'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const patchableFields = ['full_name', 'email', 'is_active', 'training_exempt', 'training_exempt_reason', 'job_title', 'category_id'];
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
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    const { data, error } = await supabase
      .from('employees')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(EMPLOYEE_SELECT)
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

// POST /api/employees/:id/convert — transforme une entrée personnel sans compte en compte
// utilisateur invité par email (admin uniquement). Toutes les données rattachées (réalisations
// de formation — et donc leurs tentatives de quiz liées par record_id —, accidents, tâches)
// sont re-rattachées au nouveau compte avant la suppression de l'entrée personnel : rien
// n'est perdu. En cas d'échec de migration, l'entrée personnel est conservée telle quelle.
router.post(
  '/:id/convert',
  requireRole('admin'),
  [
    body('email').isEmail().withMessage('Adresse email invalide.'),
    body('role').optional({ values: 'falsy' }).isIn(ASSIGNABLE_ROLES).withMessage('Rôle invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: employee, error: employeeError } = await supabase
      .from('employees')
      .select('id, full_name, job_title, training_exempt, training_exempt_reason')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (employeeError || !employee) {
      return res.status(404).json({ error: 'Entrée personnel introuvable.' });
    }

    const email = req.body.email;
    const role = req.body.role || 'member';

    let inviteResult;
    try {
      inviteResult = await sendInviteEmail({ email, fullName: employee.full_name, tenantId: req.tenantId });
    } catch (err) {
      console.error("Échec de l'envoi de l'email d'invitation :", err);
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    if (inviteResult.error) {
      if (inviteResult.error.code === 'email_exists' || /already (been )?registered|already exists/i.test(inviteResult.error.message)) {
        return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
      }
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'invitation." });
    }

    const userId = inviteResult.userId;

    // Même profil que /api/users/invite, enrichi des champs portés par l'entrée personnel
    // (poste, dispense de formation) pour que la conversion soit sans perte.
    const { error: profileError } = await supabase.from('users').insert({
      id: userId,
      tenant_id: req.tenantId,
      full_name: employee.full_name,
      role,
      job_title: employee.job_title || null,
      training_exempt: employee.training_exempt || false,
      training_exempt_reason: employee.training_exempt_reason || null,
    });

    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: 'Erreur lors de la création du profil utilisateur.' });
    }

    // Bascule employee_id → colonne user jumelle, table par table. Si une migration échoue,
    // on s'arrête : l'entrée personnel est conservée, les données déjà migrées pointent vers
    // le nouveau compte — rien n'est supprimé dans tous les cas.
    const migrated = {};
    for (const { table, column, userColumn } of EMPLOYEE_REFERENCES) {
      const { data: rows, error: migrateError } = await supabase
        .from(table)
        .update({ [userColumn]: userId, [column]: null })
        .eq('tenant_id', req.tenantId)
        .eq(column, employee.id)
        .select('id');

      if (migrateError) {
        console.error(`Échec de la migration ${table} lors de la conversion :`, migrateError);
        return res.status(500).json({
          error: "Le compte a été créé mais le transfert des données n'a pas pu aboutir. L'entrée personnel a été conservée.",
        });
      }
      migrated[table] = rows ? rows.length : 0;
    }

    const { error: deleteError } = await supabase
      .from('employees')
      .delete()
      .eq('tenant_id', req.tenantId)
      .eq('id', employee.id);

    if (deleteError) {
      return res.status(500).json({
        error: "Le compte a été créé et les données transférées, mais l'entrée personnel n'a pas pu être supprimée.",
      });
    }

    res.status(201).json({ id: userId, email, full_name: employee.full_name, role, migrated });
  }
);

export default router;
