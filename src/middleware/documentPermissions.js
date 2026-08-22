import { supabase } from '../services/supabase.js';
import { isSharedWithUser, getSharedResourceIds } from '../services/recordSharing.js';

// Un admin du tenant garde toujours accès à tout, quelle que soit la
// restriction de catégorie — bypass documenté explicitement, comme demandé.
const ADMIN_ROLES = ['admin'];

export async function getUserGroupIds(userId) {
  const { data, error } = await supabase.from('group_members').select('group_id').eq('user_id', userId);
  if (error) return [];
  return data.map((row) => row.group_id);
}

// Vérifie si l'utilisateur a la permission demandée (view/edit/approve/delete) sur une
// catégorie donnée. categoryId === null (document sans catégorie) => toujours autorisé,
// rien à restreindre. Catégorie non restreinte => toujours autorisé (comportement actuel
// inchangé). Sinon : une règle DIRECTE sur cet utilisateur (s'il en existe une) est toujours
// prioritaire et décide seule, même à false — sans ça, un utilisateur explicitement exclu
// (can_view=false) restait quand même visible via un groupe auquel il appartient, bug réel
// rapporté ("je voulais cacher la catégorie à ce membre précis, ça n'a pas marché"). Le
// groupe n'est consulté QUE si l'utilisateur n'a aucune règle directe sur cette catégorie.
export async function hasCategoryPermission({ tenantId, userId, userRole, categoryId, permission, documentId }) {
  if (ADMIN_ROLES.includes(userRole)) return true;

  // Partage d'UN document précis (voir record_shares/recordSharing.js, Paramètres > Partage
  // sur un document) : accordé EN PLUS des règles de catégorie, jamais à leur place — utile
  // pour donner accès à un seul document d'une catégorie restreinte sans ouvrir toute la
  // catégorie à cette personne.
  if (documentId && permission === 'view') {
    const shared = await isSharedWithUser({ tenantId, resourceType: 'document', resourceId: documentId, userId, userRole });
    if (shared) return true;
  }

  if (!categoryId) return true;

  const { data: category, error: categoryError } = await supabase
    .from('document_categories')
    .select('is_restricted')
    .eq('tenant_id', tenantId)
    .eq('id', categoryId)
    .single();

  if (categoryError || !category) return false;
  if (!category.is_restricted) return true;

  const column = `can_${permission}`;

  const { data: directPerms, error: directError } = await supabase
    .from('category_permissions')
    .select(column)
    .eq('category_id', categoryId)
    .eq('subject_type', 'user')
    .eq('subject_id', userId);

  if (!directError && directPerms && directPerms.length > 0) {
    return directPerms.some((row) => row[column]);
  }

  const groupIds = await getUserGroupIds(userId);
  if (groupIds.length === 0) return false;

  const { data: groupPerms, error: groupError } = await supabase
    .from('category_permissions')
    .select(column)
    .eq('category_id', categoryId)
    .eq('subject_type', 'group')
    .in('subject_id', groupIds);

  if (groupError) return false;
  return groupPerms?.some((row) => row[column]) ?? false;
}

// Filtre une liste de documents (déjà chargée, avec sa catégorie jointe incluant
// is_restricted) pour ne garder que ceux visibles par l'utilisateur — en une seule
// requête groupée plutôt qu'une vérification par document (évite le N+1).
export async function filterViewableDocuments({ tenantId, userId, userRole, documents }) {
  if (ADMIN_ROLES.includes(userRole)) return documents;

  const restrictedCategoryIds = [
    ...new Set(documents.filter((doc) => doc.category?.is_restricted).map((doc) => doc.category_id)),
  ];

  // Aucune catégorie restreinte dans ce lot : tout est déjà visible, un partage n'y changerait
  // rien (il ne fait qu'ajouter de la visibilité là où elle manquerait autrement).
  if (restrictedCategoryIds.length === 0) return documents;

  const sharedDocumentIds = await getSharedResourceIds({ tenantId, resourceType: 'document', userId, userRole });

  // Règles directes sur CET utilisateur d'abord — une catégorie où il a une règle directe
  // (même can_view=false) ne consulte JAMAIS les groupes pour cette catégorie, même logique
  // que hasCategoryPermission ci-dessus (voir son commentaire pour le bug que ça corrige).
  const { data: directPerms, error: directError } = await supabase
    .from('category_permissions')
    .select('category_id, can_view')
    .in('category_id', restrictedCategoryIds)
    .eq('subject_type', 'user')
    .eq('subject_id', userId);

  if (directError) {
    // En cas d'erreur de vérification, on refuse par prudence plutôt que d'exposer
    // potentiellement des documents restreints — un partage direct reste honoré.
    return documents.filter((doc) => !doc.category?.is_restricted || sharedDocumentIds.has(doc.id));
  }

  const directDecisionByCategoryId = new Map(directPerms.map((row) => [row.category_id, row.can_view]));
  const categoriesNeedingGroupCheck = restrictedCategoryIds.filter((id) => !directDecisionByCategoryId.has(id));

  let viewableCategoryIdsFromGroups = new Set();
  if (categoriesNeedingGroupCheck.length > 0) {
    const groupIds = await getUserGroupIds(userId);
    if (groupIds.length > 0) {
      const { data: groupPerms, error: groupError } = await supabase
        .from('category_permissions')
        .select('category_id')
        .in('category_id', categoriesNeedingGroupCheck)
        .eq('subject_type', 'group')
        .in('subject_id', groupIds)
        .eq('can_view', true);

      if (!groupError) {
        viewableCategoryIdsFromGroups = new Set((groupPerms || []).map((row) => row.category_id));
      }
    }
  }

  return documents.filter((doc) => {
    if (!doc.category?.is_restricted) return true;
    if (sharedDocumentIds.has(doc.id)) return true;
    if (directDecisionByCategoryId.has(doc.category_id)) return directDecisionByCategoryId.get(doc.category_id);
    return viewableCategoryIdsFromGroups.has(doc.category_id);
  });
}

// Filtre une liste de catégories (comme filterViewableDocuments, mais la restriction
// porte directement sur la catégorie elle-même plutôt que sur documents.category_id) —
// utilisé par GET /api/categories pour appliquer le principe de moindre divulgation :
// une catégorie restreinte sans accès n'apparaît nulle part, y compris dans les
// sélecteurs de filtre côté frontend.
export async function filterViewableCategories({ userId, userRole, categories }) {
  if (ADMIN_ROLES.includes(userRole)) return categories;

  const restrictedIds = categories.filter((c) => c.is_restricted).map((c) => c.id);
  if (restrictedIds.length === 0) return categories;

  // Même priorité "règle directe d'abord" que hasCategoryPermission/filterViewableDocuments
  // ci-dessus — sinon une catégorie explicitement masquée à cet utilisateur (can_view=false)
  // réapparaîtrait quand même dans les sélecteurs si un de ses groupes y a accès.
  const { data: directPerms, error: directError } = await supabase
    .from('category_permissions')
    .select('category_id, can_view')
    .in('category_id', restrictedIds)
    .eq('subject_type', 'user')
    .eq('subject_id', userId);

  if (directError) {
    return categories.filter((c) => !c.is_restricted);
  }

  const directDecisionByCategoryId = new Map(directPerms.map((row) => [row.category_id, row.can_view]));
  const categoriesNeedingGroupCheck = restrictedIds.filter((id) => !directDecisionByCategoryId.has(id));

  let viewableIdsFromGroups = new Set();
  if (categoriesNeedingGroupCheck.length > 0) {
    const groupIds = await getUserGroupIds(userId);
    if (groupIds.length > 0) {
      const { data: groupPerms, error: groupError } = await supabase
        .from('category_permissions')
        .select('category_id')
        .in('category_id', categoriesNeedingGroupCheck)
        .eq('subject_type', 'group')
        .in('subject_id', groupIds)
        .eq('can_view', true);

      if (!groupError) {
        viewableIdsFromGroups = new Set((groupPerms || []).map((row) => row.category_id));
      }
    }
  }

  return categories.filter((c) => {
    if (!c.is_restricted) return true;
    if (directDecisionByCategoryId.has(c.id)) return directDecisionByCategoryId.get(c.id);
    return viewableIdsFromGroups.has(c.id);
  });
}

// Vérifie que le category_id soumis dans le corps de la requête appartient bien au tenant
// courant, indépendamment du rôle (y compris admin, qui bypasse hasCategoryPermission
// ci-dessus mais ne doit pas pouvoir poser un category_id inexistant ou d'un autre tenant) —
// même garde-fou que requireValidCategoryId côté modules génériques (genericCategoryPermissions.js).
export async function requireValidDocumentCategoryId(req, res, next) {
  const categoryId = req.body?.category_id;
  if (!categoryId) return next();

  const { data, error } = await supabase
    .from('document_categories')
    .select('id')
    .eq('tenant_id', req.tenantId)
    .eq('id', categoryId)
    .maybeSingle();

  if (error || !data) {
    return res.status(400).json({ error: 'Catégorie invalide.' });
  }
  next();
}

// --- Résolveurs de cible, pour requireCategoryPermission ci-dessous ---

export async function resolveDocumentById(req) {
  const { data, error } = await supabase
    .from('documents')
    .select('id, category_id')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) return { exists: false, categoryId: null };
  return { exists: true, categoryId: data.category_id, documentId: data.id };
}

export function resolveCategoryFromBody(req) {
  return { exists: true, categoryId: req.body.category_id || null };
}

export async function resolveDocumentFromWorkflow(req) {
  const { data, error } = await supabase
    .from('document_workflows')
    .select('id, document:documents(category_id)')
    .eq('tenant_id', req.tenantId)
    .eq('id', req.params.id)
    .single();

  if (error || !data) return { exists: false, categoryId: null };
  return { exists: true, categoryId: data.document?.category_id ?? null };
}

// Middleware générique : resolveTarget(req) => { exists, categoryId }. Si le document
// (ou le workflow) n'existe pas OU que la permission manque, on répond de façon identique
// (404 "introuvable" par défaut) pour ne jamais laisser deviner qu'une ressource restreinte
// existe — c'est ce qui garantit qu'un utilisateur non autorisé "ne voit RIEN".
export function requireCategoryPermission(
  permission,
  resolveTarget,
  { deniedStatus = 404, deniedMessage = 'Document introuvable.' } = {}
) {
  return async (req, res, next) => {
    try {
      const target = await resolveTarget(req);

      if (!target || !target.exists) {
        return res.status(404).json({ error: 'Document introuvable.' });
      }

      const allowed = await hasCategoryPermission({
        tenantId: req.tenantId,
        userId: req.user.id,
        userRole: req.userRole,
        categoryId: target.categoryId,
        permission,
        documentId: target.documentId,
      });

      if (!allowed) {
        return res.status(deniedStatus).json({ error: deniedMessage });
      }

      next();
    } catch (err) {
      console.error('[documentPermissions]', err.message);
      res.status(500).json({ error: 'Erreur lors de la vérification des permissions.' });
    }
  };
}
