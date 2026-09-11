// Visibilité « cloisonnée par propriétaire » — pilote sur CAPA et Réclamations. Contrairement
// aux ~18 autres modules (où filterViewableByCategory/hasGenericCategoryPermission rendent tout
// visible par défaut dès qu'un dossier n'est PAS restreint), un manager ou un membre ne voit
// ici que ce qu'il a créé, ce qui lui est assigné, ou ce qu'on lui a partagé (record_shares) —
// jamais "tout le tenant" par défaut.
//
// Un dossier RESTREINT reste un mur dur, INDÉPENDANT de ce nouveau modèle : seule une
// permission de catégorie explicite (ou un partage) y donne accès, même à qui a créé ou s'est
// vu assigner la fiche — même invariant que les ~18 autres modules ("la restriction prime sur
// l'assignation", voir moduleCategories.test.js). Le nouveau modèle par propriétaire ne
// s'applique donc qu'aux fiches SANS dossier restreint, là où tout le monde voyait tout hier.
import { isSharedWithUser, getSharedResourceIds } from './recordSharing.js';
import { filterViewableByCategory, hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';

// GET / (liste) : à combiner à la place de "categoryViewableIds ∪ sharedIds". `items` doit
// porter created_by, assigned_to et category (avec is_restricted) — déjà le cas dans les
// SELECT de capas.js/complaints.js. Un admin voit tout, inchangé.
export async function filterOwnedOrShared({ tenantId, userId, userRole, resourceType, items }) {
  if (userRole === 'admin') return items;

  const sharedIds = await getSharedResourceIds({ tenantId, resourceType, userId, userRole });

  // Réutilise filterViewableByCategory (déjà groupé/optimisé par lot) pour la décision
  // "dossier restreint : permission accordée ou non" — mais seulement consultée pour les
  // fiches effectivement restreintes, voir le filtre ci-dessous.
  const categoryGranted = new Set((await filterViewableByCategory({ userId, userRole, items })).map((item) => item.id));

  return items.filter((item) => {
    if (sharedIds.has(item.id)) return true;
    if (item.category?.is_restricted) return categoryGranted.has(item.id);
    return item.created_by === userId || item.assigned_to === userId;
  });
}

// GET /:id, PATCH /:id, DELETE /:id : même règle pour un seul enregistrement déjà chargé.
export async function canAccessOwnedRecord({ tenantId, userId, userRole, resourceType, item }) {
  if (userRole === 'admin') return true;

  if (await isSharedWithUser({ tenantId, resourceType, resourceId: item.id, userId, userRole })) {
    return true;
  }

  if (item.category?.is_restricted) {
    return hasGenericCategoryPermission({
      tenantId,
      userId,
      userRole,
      categoryId: item.category_id,
      permission: 'view',
    });
  }

  // Dossier non restreint (ou aucun) : ici, et seulement ici, le nouveau modèle par
  // propriétaire s'applique — plus de visibilité par défaut, sauf créateur ou assigné.
  return item.created_by === userId || item.assigned_to === userId;
}
