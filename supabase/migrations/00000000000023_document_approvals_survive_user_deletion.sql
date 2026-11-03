-- Jusqu'ici, supprimer définitivement un compte utilisateur effaçait aussi TOUTES ses lignes
-- document_approvals (ON DELETE CASCADE) — decision, signature_hash, date de décision : toute
-- la preuve d'approbation disparaissait avec le compte. Pour une app QMS (traçabilité ISO
-- 9001), c'est la trace elle-même (qui a approuvé quoi et quand) qui doit survivre à la
-- suppression d'un compte, même si l'identité de l'approbateur ne peut alors plus être
-- résolue. Contrairement à document_audit_log (voir migration 12, qui a dû retirer la FK
-- entièrement à cause de son trigger d'immuabilité), document_approvals n'a pas ce trigger :
-- ON DELETE SET NULL suffit, pas besoin de retirer la contrainte.
alter table document_approvals alter column approver_id drop not null;
alter table document_approvals drop constraint document_approvals_approver_id_fkey;
alter table document_approvals
  add constraint document_approvals_approver_id_fkey
  foreign key (approver_id) references users (id) on delete set null;
