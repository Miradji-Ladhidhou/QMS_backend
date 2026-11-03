import { supabase } from './supabase.js';
import { SHAREABLE_RESOURCES } from './shareableResources.js';
import { hasCategoryPermission } from '../middleware/documentPermissions.js';
import { hasGenericCategoryPermission } from '../middleware/genericCategoryPermissions.js';
import { filterOwnedOrShared } from './ownershipVisibility.js';

export const SHAREABLE_RESOURCE_LABELS = {
  document: 'Documents', capa: 'CAPA', complaint: 'Réclamations',
  qqoqccp: 'QQOQCCP', accident: 'Accidents',
  pdca: 'PDCA', audit: 'Audits', management_review: 'Revues de direction',
  risk: 'Risques et opportunités', haccp_plan: 'HACCP', supplier: 'Fournisseurs',
  nonconforming_output: 'Non-conformités produit/service',
  customer_satisfaction: 'Satisfaction client', employee: 'Personnel',
  training: 'Formations', kpi: 'KPI', task: 'Planning',
  service: 'Services', quality_policy: 'Politique qualité',
};

export async function canManageResourceShare(req, resourceType, categoryId) {
  if (!categoryId) return true;
  const categorySource = SHAREABLE_RESOURCES[resourceType].categorySource;
  const check = categorySource === 'documents'
    ? hasCategoryPermission
    : categorySource === 'generic' ? hasGenericCategoryPermission : null;
  if (!check) return true;
  return check({
    tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole,
    categoryId, permission: 'view',
  });
}

export function selectionFields(type) {
  const config = SHAREABLE_RESOURCES[type];
  return ['id', 'created_at', ...(config.labelField ? [config.labelField] : []),
    ...(['capa', 'complaint'].includes(type) ? ['created_by', 'assigned_to', 'category:categories(is_restricted)'] : []),
    ...(config.categorySource ? ['category_id'] : [])].join(', ');
}

export function selectionItem(type, record) {
  return {
    resource_type: type,
    resource_id: record.id,
    label: record[SHAREABLE_RESOURCES[type].labelField] || SHAREABLE_RESOURCE_LABELS[type],
    created_at: record.created_at,
  };
}

export async function filterShareableRecords(req, type, records) {
  if (['capa', 'complaint'].includes(type)) {
    return filterOwnedOrShared({ tenantId: req.tenantId, userId: req.user.id, userRole: req.userRole, resourceType: type, items: records });
  }
  const categories = [...new Set(records.map((row) => row.category_id).filter(Boolean))];
  const permissions = new Map(await Promise.all(categories.map(async (id) =>
    [id, await canManageResourceShare(req, type, id)]
  )));
  const filtered = records.filter((row) => !row.category_id || permissions.get(row.category_id));
  return filtered;
}

export async function readGuestBundleItems(share) {
  const items = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('guest_share_items')
      .select('id, resource_type, resource_id, label')
      .eq('tenant_id', share.tenant_id).eq('guest_share_id', share.id)
      .order('id').range(offset, offset + 999);
    if (error) throw new Error(`Lecture du lot partagé impossible : ${error.message}`);
    items.push(...data);
    if (data.length < 1000) return items;
  }
}
