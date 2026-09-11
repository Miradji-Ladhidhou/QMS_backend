// Remonte la chaîne des parents d'un dossier jusqu'à la racine — utilisé pour le fil d'Ariane
// et pour bloquer les cycles avant un déplacement. Généralisé depuis routes/kpiFolders.js
// (seul module à avoir des dossiers imbriqués jusqu'ici) pour servir aussi categories
// (moduleCategories.js) et document_categories (categories.js) : les trois tables partagent
// exactement la même forme (id, tenant_id, parent_id auto-référencé). Une boucle de requêtes
// plutôt qu'une CTE récursive : la profondeur réelle d'un classement reste faible.
const MAX_ANCESTOR_DEPTH = 30;

export async function loadAncestors(supabase, table, tenantId, folderId) {
  const ancestors = [];
  let currentId = folderId;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH && currentId; i += 1) {
    const { data } = await supabase
      .from(table)
      .select('id, name, parent_id')
      .eq('tenant_id', tenantId)
      .eq('id', currentId)
      .maybeSingle();
    if (!data) break;
    ancestors.unshift({ id: data.id, name: data.name });
    currentId = data.parent_id;
  }
  return ancestors;
}

// Descend l'arborescence à partir d'un dossier (lui-même inclus) pour lister tous ses
// descendants — utilisé par DELETE pour vérifier qu'aucun élément n'est encore rattaché
// n'importe où dans le sous-arbre avant de laisser la suppression cascader en base (sans ça,
// supprimer un dossier détacherait silencieusement les éléments de ses sous-dossiers, voir
// moduleCategories.js/categories.js#DELETE). Même plafond de profondeur que loadAncestors,
// pour la même raison (aucun classement réel n'est censé aller aussi loin).
export async function loadSubtreeIds(supabase, table, tenantId, folderId) {
  const ids = [folderId];
  let frontier = [folderId];
  for (let i = 0; i < MAX_ANCESTOR_DEPTH && frontier.length > 0; i += 1) {
    const { data } = await supabase.from(table).select('id').eq('tenant_id', tenantId).in('parent_id', frontier);
    const nextIds = (data || []).map((row) => row.id);
    if (nextIds.length === 0) break;
    ids.push(...nextIds);
    frontier = nextIds;
  }
  return ids;
}
