import { supabase } from './supabase.js';

export function effectiveSharePermissions(rows) {
  const explicit = rows.filter((row) => row.can_edit !== null || row.can_export !== null);
  return {
    shared: rows.length > 0,
    restricted: explicit.length > 0,
    can_edit: explicit.length ? explicit.every((row) => row.can_edit === true) : null,
    can_export: explicit.length ? explicit.every((row) => row.can_export !== false) : true,
  };
}

export async function getSharePermissions({ tenantId, userId, userRole }) {
  if (userRole === 'admin') return new Map();
  const records = new Map();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('record_shares')
      .select('resource_type, resource_id, can_edit, can_export')
      .eq('tenant_id', tenantId)
      .or(`and(subject_type.eq.user,subject_id.eq.${userId}),and(subject_type.eq.role,subject_id.eq.${userRole})`)
      .order('id').range(offset, offset + 999);
    if (error) throw new Error(`Vérification des droits de partage impossible : ${error.message}`);
    for (const row of data) {
      const key = `${row.resource_type}:${row.resource_id}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(row);
    }
    if (data.length < 1000) break;
  }
  return new Map([...records].map(([key, rows]) => [key, effectiveSharePermissions(rows)]));
}
