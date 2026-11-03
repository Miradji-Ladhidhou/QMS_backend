-- Rollback de 00000000000031_procedures.sql — convention nouvelle pour ce module (aucune des
-- 30 migrations précédentes n'a de fichier de rollback), demandée explicitement pour celui-ci.
-- Ordre : on casse d'abord la référence circulaire procedures.current_version_id ->
-- procedure_versions avant de pouvoir supprimer les tables (triggers/policies/index sont
-- supprimés automatiquement avec leur table, pas besoin de DROP explicite).

alter table procedures drop column if exists current_version_id;

drop table if exists procedure_acknowledgments;
drop table if exists procedure_versions;
drop table if exists procedure_templates;
drop table if exists procedures;
