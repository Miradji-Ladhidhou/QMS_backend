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
