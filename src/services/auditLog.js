import { supabase } from './supabase.js';

// Journal d'audit insert-only (voir document_audit_log_immutable dans schema.sql).
// Best-effort : un échec d'écriture est loggé côté serveur mais ne bloque jamais
// l'action métier en cours (les appels documents/kpi_records ne partagent pas de
// transaction avec cette table via l'API REST de Supabase).
export async function logAudit({ tenantId, documentId, userId, action, details }) {
  const { error } = await supabase.from('document_audit_log').insert({
    tenant_id: tenantId,
    document_id: documentId,
    user_id: userId || null,
    action,
    details: details || null,
  });

  if (error) {
    console.error(`Échec de l'écriture du journal d'audit (${action}) :`, error.message);
  }
}
