import { supabase } from './supabase.js';

// Journal d'activité plateforme complet — connexions/déconnexions, mot de passe, CRUD sur
// tous les modules métier, transitions de workflow, exports (voir activity_log dans
// schema.sql, le plan de refonte "journal d'activité plateforme"). Réservé au super admin
// (GET /api/super-admin/activity-log, SuperAdmin.jsx). Coexiste avec document_audit_log
// (exigence ISO/FDA, scopé aux documents, voir services/auditLog.js) et
// super_admin_audit_log (actions DU super admin, voir services/superAdminAudit.js) — ne
// remplace ni l'un ni l'autre, superAdmin.js écrit désormais dans les deux tables.
//
// Best-effort comme les deux services ci-dessus : un échec d'écriture ne doit jamais bloquer
// l'action métier qu'elle enregistre — jamais de throw (l'erreur est seulement journalisée en
// console). Toujours `await`é au point d'appel malgré tout, comme les 19 appels existants à
// logAudit()/logSuperAdminAction() dans documents.js/superAdmin.js : l'await ne sert pas à
// propager un échec (il n'y en a jamais), seulement à garder l'ordre d'écriture prévisible.
export async function logActivity({ tenantId, actorId, actorEmail, action, entityType, entityId, metadata, req }) {
  const { error } = await supabase.from('activity_log').insert({
    tenant_id: tenantId || null,
    actor_id: actorId || null,
    actor_email: actorEmail || null,
    action,
    entity_type: entityType,
    entity_id: entityId || null,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
    ip_address: req?.ip || null,
    user_agent: req?.headers?.['user-agent'] || null,
  });

  if (error) {
    console.error(`[activity-log] Échec de journalisation (${action}) :`, error.message);
  }
}

// 3 enveloppes pour le geste create/update/delete, qui couvre la quasi-totalité des routes de
// l'app — action dérivée automatiquement de `entity` (chaîne libre, ex. 'capa', 'procedure',
// jamais une constante nommée à la main par module — voir le plan : ~30 modules rendrait
// l'approche "une fonction par entité" ingérable). tenantId/actorId/actorEmail viennent
// systématiquement de req.tenantId/req.user (déjà peuplés par requireAuth) — jamais du
// contexte AsyncLocalStorage (services/requestContext.js), qui reste réservé aux cas où aucun
// req de la bonne requête n'est directement accessible (voir son propre commentaire : pas un
// substitut à req.tenantId en logique métier normale).
export function logCreate({ req, entity, entityId, label, metadata }) {
  return logActivity({
    tenantId: req.tenantId,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `${entity.toUpperCase()}_CREATED`,
    entityType: entity,
    entityId,
    metadata: { ...(label && { label }), ...metadata },
    req,
  });
}

// changedFields : juste les noms de champs modifiés (déjà calculés par la boucle PATCH de
// chaque route, jamais un snapshot avant/après complet — ça tournerait à chaque écriture de
// l'appli). statusFrom/statusTo : { status: { from, to } } ajouté au metadata UNIQUEMENT
// quand status fait partie des champs modifiés — le seul champ qu'un auditeur regarde
// systématiquement, presque gratuit puisque la ligne existante est déjà chargée pour le
// contrôle d'accès dans chaque handler PATCH.
export function logUpdate({ req, entity, entityId, label, changedFields, statusFrom, statusTo, metadata }) {
  const statusChanged = statusFrom !== undefined && statusTo !== undefined && statusFrom !== statusTo;
  return logActivity({
    tenantId: req.tenantId,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `${entity.toUpperCase()}_UPDATED`,
    entityType: entity,
    entityId,
    metadata: {
      ...(label && { label }),
      ...(changedFields?.length && { changed_fields: changedFields }),
      ...(statusChanged && { status: { from: statusFrom, to: statusTo } }),
      ...metadata,
    },
    req,
  });
}

export function logDelete({ req, entity, entityId, label, metadata }) {
  return logActivity({
    tenantId: req.tenantId,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `${entity.toUpperCase()}_DELETED`,
    entityType: entity,
    entityId,
    metadata: { ...(label && { label }), ...metadata },
    req,
  });
}

// 4e enveloppe, pour les transitions de workflow ISO-critiques (soumettre/valider/rejeter/
// approuver/rendre obsolète) et les clôtures de boucle qualité (CAPA/PDCA/QQOQCCP) — un verbe
// au lieu du triplet created/updated/deleted, même dérivation automatique de l'action.
export function logTransition({ req, entity, verb, entityId, label, metadata }) {
  return logActivity({
    tenantId: req.tenantId,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `${entity.toUpperCase()}_${verb.toUpperCase()}`,
    entityType: entity,
    entityId,
    metadata: { ...(label && { label }), ...metadata },
    req,
  });
}

// Une ligne par LOT, pas une par enregistrement affecté (voir le plan : évite qu'une
// suppression en masse de 200 lignes noie le journal du jour ; un geste en masse reste un
// geste d'admin/manager, pas un événement de cycle de vie par enregistrement — chaque
// enregistrement garde de toute façon son propre historique create/update/delete).
export function logBulk({ req, entity, verb, ids, metadata }) {
  return logActivity({
    tenantId: req.tenantId,
    actorId: req.user.id,
    actorEmail: req.user.email,
    action: `${entity.toUpperCase()}_BULK_${verb.toUpperCase()}`,
    entityType: entity,
    entityId: null,
    metadata: { ids, count: ids.length, ...metadata },
    req,
  });
}
