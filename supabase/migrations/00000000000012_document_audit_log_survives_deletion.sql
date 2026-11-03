-- L'audit log est censé être immuable et insert-only (voir le trigger
-- trg_document_audit_log_immutable). Mais tant que tenant_id/document_id/user_id référencent
-- leurs tables respectives avec ON DELETE CASCADE / SET NULL, supprimer un tenant, un
-- document ou un utilisateur ayant un historique déclenche une cascade UPDATE/DELETE sur ses
-- lignes de journal — ce qui fait échouer le trigger immuable (il bloque tout UPDATE/DELETE,
-- y compris ceux déclenchés par une cascade) et donc bloque la suppression de l'objet
-- lui-même. On retire les trois contraintes : les colonnes restent renseignées (valeurs
-- historiques), mais ne sont plus des clés étrangères — le journal doit précisément
-- survivre à la suppression des objets qu'il documente.
alter table document_audit_log drop constraint document_audit_log_document_id_fkey;
alter table document_audit_log drop constraint document_audit_log_tenant_id_fkey;
alter table document_audit_log drop constraint document_audit_log_user_id_fkey;
