import { supabase } from '../services/supabase.js';

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
// inchangé). Sinon, il faut une entrée dans category_permissions avec le bon flag à true,
// directement (subject_type='user') ou via l'appartenance à un groupe autorisé.
export async function hasCategoryPermission({ tenantId, userId, userRole, categoryId, permission }) {
  if (ADMIN_ROLES.includes(userRole)) return true;
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

  if (!directError && directPerms?.some((row) => row[column])) return true;

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
export async function filterViewableDocuments({ userId, userRole, documents }) {
  if (ADMIN_ROLES.includes(userRole)) return documents;

  const restrictedCategoryIds = [
    ...new Set(documents.filter((doc) => doc.category?.is_restricted).map((doc) => doc.category_id)),
  ];

  if (restrictedCategoryIds.length === 0) return documents;

  const { data: permissions, error } = await supabase
    .from('category_permissions')
    .select('category_id, subject_type, subject_id, can_view')
    .in('category_id', restrictedCategoryIds)
    .eq('can_view', true);

  if (error) {
    // En cas d'erreur de vérification, on refuse par prudence plutôt que d'exposer
    // potentiellement des documents restreints.
    return documents.filter((doc) => !doc.category?.is_restricted);
  }

  const groupIds = await getUserGroupIds(userId);

  const viewableCategoryIds = new Set(
    (permissions || [])
      .filter(
        (row) =>
          (row.subject_type === 'user' && row.subject_id === userId) ||
          (row.subject_type === 'group' && groupIds.includes(row.subject_id))
      )
      .map((row) => row.category_id)
  );

  return documents.filter((doc) => !doc.category?.is_restricted || viewableCategoryIds.has(doc.category_id));
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

  const { data: permissions, error } = await supabase
    .from('category_permissions')
    .select('category_id, subject_type, subject_id, can_view')
    .in('category_id', restrictedIds)
    .eq('can_view', true);

  if (error) {
    return categories.filter((c) => !c.is_restricted);
  }

  const groupIds = await getUserGroupIds(userId);

  const viewableIds = new Set(
    (permissions || [])
      .filter(
        (row) =>
          (row.subject_type === 'user' && row.subject_id === userId) ||
          (row.subject_type === 'group' && groupIds.includes(row.subject_id))
      )
      .map((row) => row.category_id)
  );

  return categories.filter((c) => !c.is_restricted || viewableIds.has(c.id));
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
  return { exists: true, categoryId: data.category_id };
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
