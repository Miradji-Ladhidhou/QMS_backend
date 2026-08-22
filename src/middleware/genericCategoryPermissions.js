import { supabase } from '../services/supabase.js';
import { getUserGroupIds } from './documentPermissions.js';

// Un admin voit toujours tout — même bypass que documentPermissions.js.
const ADMIN_ROLES = ['admin'];

// Même modèle que hasCategoryPermission (documentPermissions.js) — y compris le fix "règle
// directe sur l'utilisateur toujours prioritaire sur le groupe" — généralisé aux catégories
// génériques (categories/generic_category_permissions) réutilisées par CAPA, réclamations,
// QQOQCCP, fournisseurs, formations, revues de direction. Contrairement aux documents, il n'y
// a pas de bypass "partagé individuellement" ici : cette fonction ne gère QUE la restriction
// de catégorie — combiner avec record_shares reste à la charge de chaque route appelante,
// exactement comme documentPermissions.js le fait déjà pour les documents.
export async function hasGenericCategoryPermission({ tenantId, userId, userRole, categoryId, permission }) {
  if (ADMIN_ROLES.includes(userRole)) return true;
  if (!categoryId) return true;

  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .select('is_restricted')
    .eq('tenant_id', tenantId)
    .eq('id', categoryId)
    .single();

  if (categoryError || !category) return false;
  if (!category.is_restricted) return true;

  const column = `can_${permission}`;

  const { data: directPerms, error: directError } = await supabase
    .from('generic_category_permissions')
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
    .from('generic_category_permissions')
    .select(column)
    .eq('category_id', categoryId)
    .eq('subject_type', 'group')
    .in('subject_id', groupIds);

  if (groupError) return false;
  return groupPerms?.some((row) => row[column]) ?? false;
}

// Filtre une liste d'éléments (déjà chargée, avec sa catégorie jointe incluant is_restricted)
// pour ne garder que ceux visibles par l'utilisateur — miroir de filterViewableDocuments, sans
// la partie "partage individuel" (à combiner par l'appelant si son module en a un, voir
// routes/capas.js). tenantId n'est volontairement pas nécessaire ici : les category_id à
// vérifier viennent déjà d'éléments filtrés sur le bon tenant par l'appelant.
export async function filterViewableByCategory({ userId, userRole, items }) {
  if (ADMIN_ROLES.includes(userRole)) return items;

  const restrictedCategoryIds = [
    ...new Set(items.filter((item) => item.category?.is_restricted).map((item) => item.category_id)),
  ];
  if (restrictedCategoryIds.length === 0) return items;

  const { data: directPerms, error: directError } = await supabase
    .from('generic_category_permissions')
    .select('category_id, can_view')
    .in('category_id', restrictedCategoryIds)
    .eq('subject_type', 'user')
    .eq('subject_id', userId);

  if (directError) {
    return items.filter((item) => !item.category?.is_restricted);
  }

  const directDecisionByCategoryId = new Map(directPerms.map((row) => [row.category_id, row.can_view]));
  const categoriesNeedingGroupCheck = restrictedCategoryIds.filter((id) => !directDecisionByCategoryId.has(id));

  let viewableCategoryIdsFromGroups = new Set();
  if (categoriesNeedingGroupCheck.length > 0) {
    const groupIds = await getUserGroupIds(userId);
    if (groupIds.length > 0) {
      const { data: groupPerms, error: groupError } = await supabase
        .from('generic_category_permissions')
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

  return items.filter((item) => {
    if (!item.category?.is_restricted) return true;
    if (directDecisionByCategoryId.has(item.category_id)) return directDecisionByCategoryId.get(item.category_id);
    return viewableCategoryIdsFromGroups.has(item.category_id);
  });
}

// Middleware express : si req.body.category_id est renseigné, vérifie qu'il appartient bien à
// CE tenant et à CE module (resourceType) avant de laisser passer — sinon 400. Ignoré
// silencieusement si category_id est absent/vide (l'action ne touche pas la catégorie), donc
// sans effet sur les champs habituellement "optional({ values: 'falsy' })" déjà en place.
//
// Sans ce contrôle, un category_id valide mais d'un autre module (ex : une catégorie créée pour
// les risques, posée sur une CAPA) ou d'un autre tenant était accepté tel quel : la permission
// restait correcte (toujours vérifiée par tenant_id + id, voir hasGenericCategoryPermission),
// mais l'élément se retrouvait rattaché à une catégorie qui n'a pas de sens pour lui — invisible
// à tout le monde sauf l'admin en cas de mismatch de tenant, ou mélangé au mauvais module côté
// Paramètres en cas de mismatch de resource_type.
export function requireValidCategoryId(resourceType) {
  return async (req, res, next) => {
    const categoryId = req.body?.category_id;
    if (!categoryId) return next();

    const { data, error } = await supabase
      .from('categories')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('id', categoryId)
      .eq('resource_type', resourceType)
      .maybeSingle();

    if (error || !data) {
      return res.status(400).json({ error: 'Catégorie invalide.' });
    }
    next();
  };
}

// "Uniquement moi" (libre-service, sans passer par un admin) : renvoie l'id de la catégorie
// personnelle restreinte de cet utilisateur pour ce module — une seule par (tenant,
// resource_type, utilisateur), créée à la demande au premier appel. Jamais listée par GET
// /api/module-categories (voir son filtre owner_user_id is null) ni dans le sélecteur de
// catégorie normal : purement interne, seulement utilisée pour poser category_id sur un élément.
export async function getOrCreatePersonalCategory({ tenantId, userId, resourceType }) {
  const { data: existing, error: existingError } = await supabase
    .from('categories')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('resource_type', resourceType)
    .eq('owner_user_id', userId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing.id;

  const { data: user } = await supabase.from('users').select('full_name').eq('id', userId).single();

  const { data: category, error: categoryError } = await supabase
    .from('categories')
    .insert({
      tenant_id: tenantId,
      resource_type: resourceType,
      name: `Personnel — ${user?.full_name || 'moi'}`,
      is_restricted: true,
      owner_user_id: userId,
    })
    .select('id')
    .single();
  if (categoryError) throw categoryError;

  const { error: permissionError } = await supabase
    .from('generic_category_permissions')
    .insert({ tenant_id: tenantId, category_id: category.id, subject_type: 'user', subject_id: userId, can_view: true });
  if (permissionError) throw permissionError;

  return category.id;
}

// Filtre la liste des catégories elles-mêmes (pour les sélecteurs de formulaire) — miroir de
// filterViewableCategories (documentPermissions.js), sur la table generic à la place.
export async function filterViewableGenericCategories({ userId, userRole, categories }) {
  if (ADMIN_ROLES.includes(userRole)) return categories;

  const restrictedIds = categories.filter((c) => c.is_restricted).map((c) => c.id);
  if (restrictedIds.length === 0) return categories;

  const { data: directPerms, error: directError } = await supabase
    .from('generic_category_permissions')
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
        .from('generic_category_permissions')
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
