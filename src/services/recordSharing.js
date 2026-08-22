import { supabase } from './supabase.js';

// Rôles partageables : jamais 'admin', qui voit déjà tout partout — un partage vers ce rôle
// n'aurait aucun effet et ne ferait que polluer la liste des partages actifs d'un élément.
export const SHAREABLE_ROLES = ['manager', 'member'];

// Un élément est vu si : accès normal du module (assigné, catégorie non restreinte, etc. —
// géré par l'appelant) OU un partage existe pour son rôle OU pour lui précisément. Un admin
// n'a jamais besoin de cette fonction, ses routes le court-circuitent avant.
export async function isSharedWithUser({ tenantId, resourceType, resourceId, userId, userRole }) {
  const { data, error } = await supabase
    .from('record_shares')
    .select('subject_type, subject_id')
    .eq('tenant_id', tenantId)
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId);

  if (error || !data) return false;

  return data.some(
    (row) =>
      (row.subject_type === 'user' && row.subject_id === userId) ||
      (row.subject_type === 'role' && row.subject_id === userRole)
  );
}

// Version "liste" pour filtrer un GET / (évite un aller-retour par document/CAPA) : renvoie
// l'ensemble des resource_id de ce type partagés avec CET utilisateur, directement ou via son
// rôle — à combiner en OR avec les règles de visibilité normales du module appelant.
export async function getSharedResourceIds({ tenantId, resourceType, userId, userRole }) {
  const { data, error } = await supabase
    .from('record_shares')
    .select('resource_id, subject_type, subject_id')
    .eq('tenant_id', tenantId)
    .eq('resource_type', resourceType)
    .or(`and(subject_type.eq.user,subject_id.eq.${userId}),and(subject_type.eq.role,subject_id.eq.${userRole})`);

  if (error || !data) return new Set();
  return new Set(data.map((row) => row.resource_id));
}
