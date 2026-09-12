import { Router } from 'express';
import { body, query, validationResult } from 'express-validator';
import { supabase } from '../services/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  filterViewableGenericCategories,
  hasGenericCategoryPermission,
  getOrCreatePersonalCategory,
} from '../middleware/genericCategoryPermissions.js';
import { loadAncestors, loadSubtreeIds } from '../utils/folderAncestors.js';

const router = Router();
const SUBJECT_TYPES = ['user', 'group'];
const RESOURCE_TYPES = [
  'capa',
  'complaint',
  'qqoqccp',
  'supplier',
  'training',
  'management_review',
  'audit',
  'risk',
  'haccp_plan',
  'task',
  'kpi',
  'procedure',
  'accident',
  'pdca',
  'nonconforming_output',
  'customer_satisfaction',
  'employee',
];

// Table réellement porteuse de category_id pour chaque resource_type — voir schema.sql.
// Utilisé uniquement par DELETE /:id pour vérifier qu'aucun élément n'y est encore rattaché.
const RESOURCE_TABLE_INFO = {
  capa: { table: 'capas', singular: 'CAPA', plural: 'CAPA' },
  complaint: { table: 'complaints', singular: 'réclamation', plural: 'réclamations' },
  qqoqccp: { table: 'qqoqccp_analyses', singular: 'analyse QQOQCCP', plural: 'analyses QQOQCCP' },
  supplier: { table: 'suppliers', singular: 'fournisseur', plural: 'fournisseurs' },
  training: { table: 'trainings', singular: 'formation', plural: 'formations' },
  management_review: { table: 'management_reviews', singular: 'revue de direction', plural: 'revues de direction' },
  audit: { table: 'audits', singular: 'audit', plural: 'audits' },
  risk: { table: 'risks', singular: 'risque/opportunité', plural: 'risques/opportunités' },
  haccp_plan: { table: 'haccp_plans', singular: 'plan HACCP', plural: 'plans HACCP' },
  task: { table: 'tasks', singular: 'tâche', plural: 'tâches' },
  kpi: { table: 'kpis', singular: 'KPI', plural: 'KPI' },
  procedure: { table: 'procedures', singular: 'procédure', plural: 'procédures' },
  accident: { table: 'accidents', singular: 'accident du travail', plural: 'accidents du travail' },
  pdca: { table: 'pdca_projects', singular: 'projet PDCA', plural: 'projets PDCA' },
  nonconforming_output: { table: 'nonconforming_outputs', singular: 'non-conformité produit/service', plural: 'non-conformités produit/service' },
  customer_satisfaction: { table: 'customer_satisfaction_surveys', singular: 'enquête de satisfaction', plural: 'enquêtes de satisfaction' },
  employee: { table: 'employees', singular: 'personne', plural: 'personnes' },
};

router.use(requireAuth);

// GET /api/module-categories?resource_type=capa&parent_id=<uuid>|root — sous-dossiers directs
// d'un dossier (racine si parent_id absent ou "root"), même principe que
// GET /api/kpi-folders. Une catégorie restreinte à laquelle l'utilisateur n'a pas accès
// (can_view) n'apparaît pas — même principe de moindre divulgation que GET /api/categories
// (documents).
router.get('/', [query('resource_type').isIn(RESOURCE_TYPES).withMessage('Type de ressource invalide.')], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Requête invalide.', details: errors.array() });
  }

  const { parent_id: parentId } = req.query;

  let query_ = supabase
    .from('categories')
    .select('*')
    .eq('tenant_id', req.tenantId)
    .eq('resource_type', req.query.resource_type)
    // Les catégories personnelles ("Uniquement moi", voir POST /personal) ne sont jamais
    // listées ici : ni dans Paramètres > Catégories (l'admin n'a rien à en faire), ni dans le
    // sélecteur de catégorie normal d'un formulaire de création. Jamais imbriquées non plus
    // (voir contrainte categories_personal_never_nested, schema.sql) : cette exclusion
    // n'entre donc jamais en conflit avec le filtre parent_id ci-dessous.
    .is('owner_user_id', null);
  query_ = !parentId || parentId === 'root' ? query_.is('parent_id', null) : query_.eq('parent_id', parentId);

  const { data, error } = await query_.order('name', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les catégories.' });
  }

  const viewable = await filterViewableGenericCategories({ userId: req.user.id, userRole: req.userRole, categories: data });

  res.json(viewable);
});

// GET /api/module-categories/:id/breadcrumb — chaîne des ancêtres (racine → dossier), pour le
// fil d'Ariane de navigation. Pas de resource_type requis : l'id + tenant_id suffisent à
// résoudre la ligne sans ambiguïté, même principe que /:id/permissions un peu plus bas dans ce
// fichier (qui ne vérifie pas non plus le resource_type appelant).
router.get('/:id/breadcrumb', async (req, res) => {
  const { data: folder } = await supabase
    .from('categories')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .maybeSingle();

  if (!folder) {
    return res.status(404).json({ error: 'Dossier introuvable.' });
  }

  const breadcrumb = await loadAncestors(supabase, 'categories', req.tenantId, req.params.id);
  res.json(breadcrumb);
});

// POST /api/module-categories/personal — libre-service (tous les rôles, pas seulement admin) :
// renvoie l'id de la catégorie "Uniquement moi" de l'utilisateur courant pour ce module,
// créée au premier appel si besoin. Utilisé par les formulaires de création/édition quand
// l'utilisateur choisit "Uniquement moi" plutôt qu'une catégorie existante — le category_id
// obtenu est ensuite envoyé normalement, comme n'importe quel autre category_id.
router.post(
  '/personal',
  [body('resource_type').isIn(RESOURCE_TYPES).withMessage('Type de ressource invalide.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Requête invalide.', details: errors.array() });
    }

    try {
      const categoryId = await getOrCreatePersonalCategory({
        tenantId: req.tenantId,
        userId: req.user.id,
        resourceType: req.body.resource_type,
      });
      res.json({ id: categoryId });
    } catch {
      res.status(500).json({ error: 'Impossible de préparer la visibilité personnelle.' });
    }
  }
);

// POST /api/module-categories — création (admin uniquement)
router.post(
  '/',
  requireRole('admin'),
  [
    body('resource_type').isIn(RESOURCE_TYPES).withMessage('Type de ressource invalide.'),
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
    body('parent_id').optional({ values: 'falsy' }).isUUID().withMessage('Dossier parent invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { resource_type: resourceType, name, color, is_restricted: isRestricted, parent_id: parentId } = req.body;

    if (parentId) {
      const { data: parent } = await supabase
        .from('categories')
        .select('id')
        .eq('tenant_id', req.tenantId)
        .eq('resource_type', resourceType)
        .eq('id', parentId)
        .maybeSingle();
      if (!parent) {
        return res.status(400).json({ error: 'Dossier parent introuvable.' });
      }
    }

    const { data, error } = await supabase
      .from('categories')
      .insert({
        tenant_id: req.tenantId,
        resource_type: resourceType,
        name,
        color: color || null,
        is_restricted: isRestricted ?? false,
        parent_id: parentId || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Une catégorie porte déjà ce nom pour ce module.' });
      }
      return res.status(500).json({ error: 'Erreur lors de la création de la catégorie.' });
    }

    res.status(201).json(data);
  }
);

// PUT /api/module-categories/:id — mise à jour (admin uniquement). resource_type n'est jamais
// modifiable après coup : changer le type reviendrait à faire apparaître cette catégorie dans
// un autre module, ce qui n'a pas de sens (les éléments qui y sont déjà rattachés resteraient
// du mauvais resource_type).
router.put(
  '/:id',
  requireRole('admin'),
  [
    body('name').trim().notEmpty().withMessage('Le nom de la catégorie est requis.'),
    body('is_restricted').optional().isBoolean().withMessage('Valeur invalide.'),
    body('parent_id')
      .optional({ nullable: true })
      .custom((value) => value === null || typeof value === 'string')
      .withMessage('Dossier parent invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { name, color, is_restricted: isRestricted } = req.body;

    const update = { name, color: color || null };
    if ('is_restricted' in req.body) {
      update.is_restricted = isRestricted;
    }

    if ('parent_id' in req.body) {
      const parentId = req.body.parent_id;

      if (parentId) {
        if (parentId === req.params.id) {
          return res.status(400).json({ error: 'Un dossier ne peut pas être son propre parent.' });
        }
        // resource_type comparé ici (jamais transmis par le client, voir commentaire de la
        // route) : un déplacement ne doit jamais faire apparaître une catégorie sous un
        // parent d'un autre module.
        const { data: current } = await supabase
          .from('categories')
          .select('resource_type')
          .eq('tenant_id', req.tenantId)
          .eq('id', req.params.id)
          .maybeSingle();
        const { data: parent } = await supabase
          .from('categories')
          .select('id')
          .eq('tenant_id', req.tenantId)
          .eq('id', parentId)
          .eq('resource_type', current?.resource_type)
          .maybeSingle();
        if (!parent) {
          return res.status(400).json({ error: 'Dossier parent introuvable.' });
        }
        // Empêche de déplacer un dossier dans l'un de ses propres sous-dossiers, ce qui
        // créerait un cycle et casserait la remontée du fil d'Ariane.
        const ancestors = await loadAncestors(supabase, 'categories', req.tenantId, parentId);
        if (ancestors.some((ancestor) => ancestor.id === req.params.id)) {
          return res.status(400).json({ error: "Impossible de déplacer un dossier dans l'un de ses sous-dossiers." });
        }
      }

      update.parent_id = parentId || null;
    }

    const { data, error } = await supabase
      .from('categories')
      .update(update)
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

// DELETE /api/module-categories/:id — suppression (admin uniquement). Bloquée tant que des
// éléments y sont encore rattachés : les laisser retomber à category_id=null (on delete set
// null) semblait anodin, mais pour une catégorie restreinte ça lève SILENCIEUSEMENT la
// restriction d'accès sur tout ce qu'elle contenait (un élément sans catégorie est visible par
// tout le tenant par défaut) — le même risque que le garde-fou déjà posé sur
// categories.js (documents), ici avec 14 modules concernés au lieu d'un seul.
//
// La vérification porte sur TOUT LE SOUS-ARBRE (ce dossier + ses descendants), pas seulement
// le dossier ciblé : parent_id est en "on delete cascade" (schema.sql), donc supprimer un
// dossier supprime aussi ses sous-dossiers — sans cette vérification élargie, un élément
// rattaché deux niveaux plus bas se retrouverait détaché silencieusement (category_id remis à
// null), perdant sa restriction d'accès au passage sans qu'on l'ait jamais visé directement.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id, resource_type')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (categoryError || !category) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  const referenceInfo = RESOURCE_TABLE_INFO[category.resource_type];
  if (referenceInfo) {
    const subtreeIds = await loadSubtreeIds(supabase, 'categories', req.tenantId, req.params.id);
    const { count: referenceCount, error: countError } = await supabase
      .from(referenceInfo.table)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', req.tenantId)
      .in('category_id', subtreeIds);

    if (countError) {
      return res.status(500).json({ error: 'Impossible de vérifier les éléments rattachés à cette catégorie.' });
    }

    if (referenceCount > 0) {
      const label = referenceCount > 1 ? referenceInfo.plural : referenceInfo.singular;
      const scope = subtreeIds.length > 1 ? ' (y compris ses sous-dossiers)' : '';
      return res.status(409).json({
        error: `${referenceCount} ${label} sont rattaché(s) à cette catégorie${scope}. Déplacez-les avant de la supprimer.`,
      });
    }
  }

  const { error, count } = await supabase
    .from('categories')
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

// GET /api/module-categories/:id/permissions — permissions d'accès (utilisateurs et groupes)
// sur une catégorie restreinte. Même règle que pour les documents : visible par les admins et
// par quiconque a can_edit sur cette catégorie, pas les simples lecteurs.
router.get('/:id/permissions', async (req, res) => {
  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (categoryError || !category) {
    return res.status(404).json({ error: 'Catégorie introuvable.' });
  }

  const allowed = await hasGenericCategoryPermission({
    tenantId: req.tenantId,
    userId: req.user.id,
    userRole: req.userRole,
    categoryId: category.id,
    permission: 'edit',
  });

  if (!allowed) {
    return res.status(403).json({ error: "Vous n'avez pas accès à cette information." });
  }

  const { data: permissions, error } = await supabase
    .from('generic_category_permissions')
    .select('*')
    .eq('category_id', category.id)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: 'Impossible de récupérer les permissions.' });
  }

  const userIds = permissions.filter((p) => p.subject_type === 'user').map((p) => p.subject_id);
  const groupIds = permissions.filter((p) => p.subject_type === 'group').map((p) => p.subject_id);

  const [{ data: users }, { data: groups }] = await Promise.all([
    userIds.length
      ? supabase.from('users').select('id, full_name').eq('tenant_id', req.tenantId).in('id', userIds)
      : Promise.resolve({ data: [] }),
    groupIds.length
      ? supabase.from('groups').select('id, name').eq('tenant_id', req.tenantId).in('id', groupIds)
      : Promise.resolve({ data: [] }),
  ]);

  const usersById = Object.fromEntries((users || []).map((u) => [u.id, u]));
  const groupsById = Object.fromEntries((groups || []).map((g) => [g.id, g]));

  const enriched = permissions.map((p) => ({
    ...p,
    subject: p.subject_type === 'user' ? usersById[p.subject_id] || null : groupsById[p.subject_id] || null,
  }));

  res.json(enriched);
});

// POST /api/module-categories/:id/permissions — accorde/modifie les droits d'un utilisateur ou
// groupe sur la catégorie (upsert : un même sujet ne peut avoir qu'une ligne par catégorie).
router.post(
  '/:id/permissions',
  requireRole('admin'),
  [
    body('subject_type').isIn(SUBJECT_TYPES).withMessage('Type de sujet invalide.'),
    body('subject_id').isUUID().withMessage('Sujet invalide.'),
    body('can_view').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_edit').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_approve').optional().isBoolean().withMessage('Valeur invalide.'),
    body('can_delete').optional().isBoolean().withMessage('Valeur invalide.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Données invalides.', details: errors.array() });
    }

    const { data: category, error: categoryError } = await supabase
      .from('categories')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();

    if (categoryError || !category) {
      return res.status(404).json({ error: 'Catégorie introuvable.' });
    }

    const {
      subject_type: subjectType,
      subject_id: subjectId,
      can_view: canView = true,
      can_edit: canEdit = false,
      can_approve: canApprove = false,
      can_delete: canDelete = false,
    } = req.body;

    const { data, error } = await supabase
      .from('generic_category_permissions')
      .upsert(
        {
          tenant_id: req.tenantId,
          category_id: category.id,
          subject_type: subjectType,
          subject_id: subjectId,
          can_view: canView,
          can_edit: canEdit,
          can_approve: canApprove,
          can_delete: canDelete,
        },
        { onConflict: 'category_id,subject_type,subject_id' }
      )
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: "Erreur lors de l'enregistrement de la permission." });
    }

    res.status(201).json(data);
  }
);

// DELETE /api/module-categories/:id/permissions/:permissionId — révoque un accès
router.delete('/:id/permissions/:permissionId', requireRole('admin'), async (req, res) => {
  const { error, count } = await supabase
    .from('generic_category_permissions')
    .delete({ count: 'exact' })
    .eq('tenant_id', req.tenantId)
    .eq('category_id', req.params.id)
    .eq('id', req.params.permissionId);

  if (error) {
    return res.status(500).json({ error: 'Erreur lors de la suppression de la permission.' });
  }

  if (!count) {
    return res.status(404).json({ error: 'Permission introuvable.' });
  }

  res.status(204).send();
});

export default router;
