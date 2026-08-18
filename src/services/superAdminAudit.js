import { supabase } from './supabase.js';

// Journal d'audit plateforme (super_admin_audit_log) : distinct de document_audit_log qui
// est scopé à un document dans un tenant — ici les actions traversent les tenants. Best-
// effort : un échec d'écriture du journal ne doit jamais faire échouer l'action réelle
// qu'il enregistre, seulement être signalé côté serveur pour investigation.
export async function logSuperAdminAction({ actorId, action, targetType, targetId, details }) {
  const { error } = await supabase
    .from('super_admin_audit_log')
    .insert({ actor_id: actorId, action, target_type: targetType, target_id: targetId || null, details: details || null });

  if (error) {
    console.error('[super-admin-audit] échec de journalisation :', error.message);
  }
}
