import { Router } from 'express';
import { body, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { requireMenuVisible } from '../middleware/menuVisibility.js';
import { hasGenericCategoryPermission, filterViewableByCategory, requireValidCategoryId } from '../middleware/genericCategoryPermissions.js';
import { generatePdcaPhaseSuggestion } from '../services/groq.js';
import { notifyCapaAssigned } from '../services/capaNotifications.js';

const router = Router();

const MANAGER_ROLES = ['admin', 'manager'];
// Ordre fixe du cycle — POST /:id/advance ne fait qu'avancer d'un cran dedans, jamais de saut
// ni de retour en arrière (pas de statut libre, voir schema.sql).
const PDCA_SEQUENCE = ['plan', 'do', 'check', 'act', 'closed'];
const PHASE_LABELS = { plan: 'Plan', do: 'Do', check: 'Check', act: 'Act' };
// Mêmes niveaux que capas.js (CAPA_LEVELS) — dupliqués ici comme dans accidents.js/risks.js.
const CAPA_LEVELS = ['low', 'medium', 'high', 'critical'];

router.use(requireAuth);
router.use(requireMenuVisible('pdca'));

const PDCA_SELECT =
  '*, service:services(id, name), owner_user:users!pdca_projects_owner_fkey(id, full_name), category:categories(id, name, color, is_restricted, owner_user_id), linked_capa:capas!pdca_projects_linked_capa_id_fkey(id, number, title, status)';

function today() {
  return new Date().toISOString().slice(0, 10);
}

// GET /api/pdca — liste tenant-wide, tous les rôles : comme pour les risques/audits, un
// projet d'amélioration continue concerne le SMQ dans son ensemble, pas seulement son porteur.
router.get('/', async (req, res) => {
  let dbQuery = supabase.from('pdca_projects').select(PDCA_SELECT).eq('tenant_id', req.tenantId).order('created_at', { ascending: false });

  if (req.query.status) dbQuery = dbQuery.eq('status', req.query.status);
  if (req.query.service_id) dbQuery = dbQuery.eq('service_id', req.query.service_id);

  const { data, error } = await dbQuery;
  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les projets PDCA.' });
  }

  const visible = await filterViewableByCategory({ userId: req.user.id, userRole: req.userRole, items: data });
  res.json(visible);
});

// GET /api/pdca/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase.from('pdca_projects').select(PDCA_SELECT).eq('tenant_id', req.tenantId).eq('id', req.params.id).single();

  if (error || !data) {
    return res.status(404).json({ error: 'Projet PDCA introuvable.' });
  }

  const categoryAllowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: data.category_id,
    permission: 'view',
  });
  if (!categoryAllowed) {
    return res.status(404).json({ error: 'Projet PDCA introuvable.' });
  }

  res.json({ ...data, is_private_to_me: data.category?.owner_user_id === req.user.id });
});

// POST /api/pdca — ouvert à tous les rôles : démarrer une démarche d'amélioration continue ne
// demande pas de rang manager, contrairement à l'identification structurée d'un risque. Le
// statut démarre toujours à 'plan' (valeur par défaut en base) : on n'accepte ni status, ni les
// contenus/dates des autres phases ici — seule la route POST /:id/advance les fait progresser.
router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('target_date').optional({ values: 'falsy' }).isISO8601().withMessage('Date cible invalide.'),
    body('plan_content').optional({ values: 'falsy' }).trim(),
    body('category_id').optional({ values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('pdca'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      description,
      service_id: serviceId,
      owner,
      target_date: targetDate,
      plan_content: planContent,
      category_id: categoryId,
    } = req.body;

    const { data, error } = await supabase
      .from('pdca_projects')
      .insert({
        tenant_id: req.tenantId,
        title,
        description: description || null,
        service_id: serviceId || null,
        owner: owner || null,
        target_date: targetDate || null,
        plan_content: planContent || null,
        category_id: categoryId || null,
        created_by: req.user.id,
      })
      .select(PDCA_SELECT)
      .single();

    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la création du projet PDCA.' });
    }

    res.status(201).json(data);
  }
);

// PATCH /api/pdca/bulk-category — déplace plusieurs projets d'un coup vers une catégorie.
// Placée avant PATCH /:id pour ne pas être capturée comme un id, réservée admin/manager (comme
// risks.js/suppliers.js) : un déplacement en masse touche potentiellement des projets d'autrui.
router.patch(
  '/bulk-category',
  requireRole('admin', 'manager'),
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un projet.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('pdca'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data, error } = await supabase
      .from('pdca_projects')
      .update({ category_id: req.body.category_id || null })
      .eq('tenant_id', req.tenantId)
      .in('id', req.body.ids)
      .select('id');

    if (error) {
      return res.status(500).json({ error: 'Erreur lors du déplacement.' });
    }

    res.json({ updated: data.length });
  }
);

// PATCH /api/pdca/:id — admin/manager OU le créateur du projet : contrairement aux
// risques/CAPA (pilotage réservé au management), un PDCA reste l'outil de son porteur — il doit
// pouvoir continuer à le documenter sans dépendre d'un manager, comme pour ses propres analyses
// QQOQCCP (voir qqoqccp.js). Le statut ne se change jamais ici : seule POST /:id/advance le fait.
router.patch(
  '/:id',
  [
    body('title').optional().trim().notEmpty().withMessage('Le titre ne peut pas être vide.'),
    body('description').optional({ values: 'falsy' }).trim(),
    body('service_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('owner').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Responsable invalide.'),
    body('target_date').optional({ nullable: true, values: 'falsy' }).isISO8601().withMessage('Date cible invalide.'),
    body('plan_content').optional({ nullable: true, values: 'falsy' }).trim(),
    body('do_content').optional({ nullable: true, values: 'falsy' }).trim(),
    body('check_content').optional({ nullable: true, values: 'falsy' }).trim(),
    body('act_content').optional({ nullable: true, values: 'falsy' }).trim(),
    body('category_id').optional({ nullable: true, values: 'falsy' }).isUUID().withMessage('Catégorie invalide.'),
  ],
  requireValidCategoryId('pdca'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('pdca_projects')
      .select('id, created_by')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Projet PDCA introuvable.' });
    }

    const isManager = MANAGER_ROLES.includes(req.userRole);
    if (!isManager && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }

    const update = {};
    for (const field of ['title', 'description', 'plan_content', 'do_content', 'check_content', 'act_content']) {
      if (field in req.body) update[field] = req.body[field] || null;
    }
    if ('service_id' in req.body) update.service_id = req.body.service_id || null;
    if ('owner' in req.body) update.owner = req.body.owner || null;
    if ('target_date' in req.body) update.target_date = req.body.target_date || null;
    if ('category_id' in req.body) update.category_id = req.body.category_id || null;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
    }

    const { data, error } = await supabase
      .from('pdca_projects')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(PDCA_SELECT)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Projet PDCA introuvable.' });
    }

    res.json(data);
  }
);

// POST /api/pdca/:id/generate — brouillon IA (Groq) pour le contenu de l'étape COURANTE du
// cycle, à partir du titre/description du projet et de ce qui est déjà documenté pour les
// étapes précédentes. Permission identique à PATCH/:id et POST /:id/advance (admin/manager ou
// créateur) : c'est la même personne qui documente qui peut se faire aider à rédiger. Ne
// persiste rien — le frontend ne fait que préremplir le brouillon de la phase, à valider ou
// corriger avant d'enregistrer via PATCH /:id (même principe que le reste des suggestions IA de
// l'app, voir services/groq.js).
router.post('/:id/generate', async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from('pdca_projects')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: 'Projet PDCA introuvable.' });
  }

  const isManager = MANAGER_ROLES.includes(req.userRole);
  if (!isManager && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }

  if (existing.status === 'closed') {
    return res.status(400).json({ error: 'Ce projet PDCA est déjà clôturé.' });
  }

  let suggestion;
  try {
    suggestion = await generatePdcaPhaseSuggestion({
      phase: existing.status,
      title: existing.title,
      description: existing.description,
      planContent: existing.plan_content,
      doContent: existing.do_content,
      checkContent: existing.check_content,
    });
  } catch (err) {
    return res.status(503).json({ error: `Impossible de générer une suggestion IA : ${err.message}` });
  }

  res.json({ content: suggestion.content });
});

// DELETE /api/pdca/:id — admin ou créateur uniquement (voir DELETE /bulk ci-dessous : un
// manager qui n'a pas créé le projet n'a ici pas plus de droits qu'un member, contrairement à
// PATCH/:id — supprimer le travail de quelqu'un d'autre reste un acte plus lourd qu'y contribuer).
// DELETE /api/pdca/bulk — suppression en masse, placée avant DELETE /:id pour ne pas être
// capturée comme un id, même convention que /bulk-category. Miroir de DELETE /tasks/bulk : un
// non-admin ne supprime que ses propres projets, les autres ids sont silencieusement ignorés.
router.delete(
  '/bulk',
  [
    body('ids').isArray({ min: 1 }).withMessage('Sélectionnez au moins un projet.'),
    body('ids.*').isUUID().withMessage('Identifiant invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    let dbQuery = supabase.from('pdca_projects').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).in('id', req.body.ids);
    if (req.userRole !== 'admin') {
      dbQuery = dbQuery.eq('created_by', req.user.id);
    }

    const { error, count } = await dbQuery;
    if (error) {
      return res.status(500).json({ error: 'Erreur lors de la suppression.' });
    }

    res.json({ deleted: count });
  }
);

router.delete('/:id', async (req, res) => {
  const { data: existing, error: fetchError } = await supabase
    .from('pdca_projects')
    .select('id, created_by')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (fetchError || !existing) {
    return res.status(404).json({ error: 'Projet PDCA introuvable.' });
  }

  if (req.userRole !== 'admin' && existing.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
  }

  const { error, count } = await supabase.from('pdca_projects').delete({ count: 'exact' }).eq('tenant_id', req.tenantId).eq('id', req.params.id);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression du projet PDCA.' });
  }
  if (!count) {
    return res.status(404).json({ error: 'Projet PDCA introuvable.' });
  }

  res.status(204).end();
});

// POST /api/pdca/:id/advance — fait progresser le cycle d'une phase vers la suivante
// (plan → do → check → act → closed), jamais en arrière ni en sautant une étape. Permission
// identique à PATCH /:id (admin/manager ou créateur) : c'est la même personne qui documente qui
// décide quand une phase est terminée. La phase quittée doit être documentée (son champ
// `*_content` non vide) avant de pouvoir avancer — sinon le cycle perdrait sa traçabilité.
router.post(
  '/:id/advance',
  [
    body('do_content').optional({ values: 'falsy' }).trim(),
    body('check_content').optional({ values: 'falsy' }).trim(),
    body('act_content').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: existing, error: fetchError } = await supabase
      .from('pdca_projects')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Projet PDCA introuvable.' });
    }

    const isManager = MANAGER_ROLES.includes(req.userRole);
    if (!isManager && existing.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }

    const currentIndex = PDCA_SEQUENCE.indexOf(existing.status);
    if (existing.status === 'closed' || currentIndex === -1 || currentIndex >= PDCA_SEQUENCE.length - 1) {
      return res.status(400).json({ error: 'Ce projet PDCA est déjà clôturé.' });
    }

    const currentPhase = existing.status;
    const currentContentField = `${currentPhase}_content`;
    if (!existing[currentContentField] || !existing[currentContentField].trim()) {
      return res.status(400).json({ error: `Documentez d'abord l'étape ${PHASE_LABELS[currentPhase]} avant de passer à la suivante.` });
    }

    const nextPhase = PDCA_SEQUENCE[currentIndex + 1];

    const update = {
      status: nextPhase,
      [`${currentPhase}_completed_at`]: today(),
    };

    // Amorçage optionnel du contenu de la phase suivante (ex : do_content fourni en avançant
    // vers 'do') — jamais requis, l'utilisateur pourra toujours le compléter ensuite via PATCH.
    if (nextPhase !== 'closed') {
      const nextContentField = `${nextPhase}_content`;
      if (req.body[nextContentField]) update[nextContentField] = req.body[nextContentField];
    } else {
      update.closed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('pdca_projects')
      .update(update)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select(PDCA_SELECT)
      .single();

    if (error || !data) {
      return res.status(500).json({ error: "Erreur lors de l'avancement du projet PDCA." });
    }

    res.json(data);
  }
);

// POST /api/pdca/:id/create-capa — crée une CAPA à partir de ce projet et lie les deux dans les
// deux sens. Même mécanique que POST /risks/:id/create-capa, MAIS permission différente :
// contrairement à risks.js/accidents.js (réservé admin/manager), ici admin/manager OU
// created_by === req.user.id — exactement comme PATCH /:id et POST /:id/advance ci-dessus.
// Ouvrir une CAPA depuis la conclusion Act d'un cycle qu'on a soi-même documenté est un
// prolongement naturel de son propre suivi, pas un acte de pilotage managérial séparé.
router.post(
  '/:id/create-capa',
  [
    body('title').trim().notEmpty().withMessage('Le titre est requis.'),
    body('service_id').optional({ values: 'falsy' }).isUUID().withMessage('Service invalide.'),
    body('severity').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Gravité invalide.'),
    body('priority').optional({ values: 'falsy' }).isIn(CAPA_LEVELS).withMessage('Priorité invalide.'),
    body('assigned_to').optional({ values: 'falsy' }).isUUID().withMessage('Utilisateur assigné invalide.'),
    body('due_date').optional({ values: 'falsy' }).isISO8601().withMessage('Échéance invalide.'),
    body('root_cause').optional({ values: 'falsy' }).trim(),
    body('corrective_action').optional({ values: 'falsy' }).trim(),
    body('preventive_action').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const { data: pdca, error: fetchError } = await supabase
      .from('pdca_projects')
      .select('id, title, service_id, description, check_content, act_content, created_by')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (fetchError || !pdca) {
      return res.status(404).json({ error: 'Projet PDCA introuvable.' });
    }

    const isManager = MANAGER_ROLES.includes(req.userRole);
    if (!isManager && pdca.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Action non autorisée pour ce rôle.' });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const {
      title,
      service_id: serviceId,
      severity,
      priority,
      assigned_to: assignedTo,
      due_date: dueDate,
      root_cause: rootCause,
      corrective_action: correctiveAction,
      preventive_action: preventiveAction,
    } = req.body;

    // description : le premier contenu non vide parmi Act (où "ceci nécessite un suivi
    // formel" se décide), Check (repli si on ouvre la CAPA avant d'avoir rédigé Act), puis la
    // description du projet — jamais vide. root_cause : Check uniquement (l'étape la plus
    // proche d'un diagnostic de cause dans un cycle PDCA), distinct d'Act pour ne pas dupliquer
    // le même texte dans les deux champs si l'appelant ne fournit pas root_cause lui-même.
    const defaultDescription = pdca.act_content || pdca.check_content || pdca.description || undefined;

    const { data: capa, error: capaError } = await supabase
      .from('capas')
      .insert({
        tenant_id: req.tenantId,
        title,
        origin: `Projet PDCA — ${pdca.title}`,
        description: defaultDescription,
        service_id: serviceId || pdca.service_id || null,
        severity: severity || undefined,
        priority: priority || undefined,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        root_cause: rootCause || pdca.check_content || null,
        corrective_action: correctiveAction || null,
        preventive_action: preventiveAction || null,
        pdca_project_id: pdca.id,
        created_by: req.user.id,
      })
      .select('*, assigned:users!capas_assigned_to_fkey(id, full_name)')
      .single();

    if (capaError) {
      return res.status(500).json({ error: 'Erreur lors de la création de la CAPA.' });
    }

    if (capa.assigned_to) {
      notifyCapaAssigned(req.tenantId, capa).catch((err) =>
        console.error("Échec de la notification d'assignation CAPA :", err.message)
      );
    }

    const { error: linkError } = await supabase
      .from('pdca_projects')
      .update({ linked_capa_id: capa.id })
      .eq('tenant_id', req.tenantId)
      .eq('id', pdca.id);

    if (linkError) {
      console.error("Échec de la mise à jour du projet PDCA après création de la CAPA :", linkError.message);
    }

    res.status(201).json(capa);
  }
);

export default router;
