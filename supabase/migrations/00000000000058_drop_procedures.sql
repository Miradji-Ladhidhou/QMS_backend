-- Suppression du module Procédures : la page Documents fait désormais office de module pour
-- les procédures internes (fichiers uploadés), le module de contenu structuré/versionné
-- devient redondant. Suppression DÉFINITIVE des données procédures (confirmé) : tables,
-- colonnes miroirs dans les autres modules, types de ressource dans les partages/catégories.
-- Tout est en "if exists" : certaines colonnes (risk_links.procedure_id,
-- haccp_plan_links.procedure_id) n'existent en prod que si les scripts one-off
-- add-risk-improvements.sql / add-haccp-improvements.sql y ont été appliqués.

begin;

-- 1. Détacher ai_generations (migration 48) du journal de génération de procédures.
--    Les lignes d'historique IA sont conservées, seul le lien vers le job disparaît.
alter table if exists ai_generations drop column if exists job_id;

-- 2. Liens des autres modules vers les procédures. Supprimer la colonne détruit
--    automatiquement la contrainte num_nonnulls qui la référence : on purge d'abord les
--    lignes qui ne pointaient QUE vers une procédure, puis on recrée la contrainte sans elle.
--    Blocs conditionnels : la colonne procedure_id n'existe que si les scripts one-off
--    add-risk-improvements.sql / add-haccp-improvements.sql ont été appliqués sur la base.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'risk_links' and column_name = 'procedure_id'
  ) then
    delete from risk_links where procedure_id is not null;
    alter table risk_links drop column procedure_id;
    alter table risk_links add constraint risk_links_single_target_check
      check (num_nonnulls(audit_id, supplier_id, kpi_id) = 1);
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'haccp_plan_links' and column_name = 'procedure_id'
  ) then
    delete from haccp_plan_links where procedure_id is not null;
    alter table haccp_plan_links drop column procedure_id;
    alter table haccp_plan_links add constraint haccp_plan_links_single_target_check
      check (num_nonnulls(supplier_id, training_id) = 1);
  end if;
end $$;

-- 3. Préférence de notification dédiée (rappels de revue de procédure).
alter table user_notification_preferences drop column if exists email_procedure_review;

-- 4. Types de ressource 'procedure' dans les modules transverses : purge des lignes puis
--    recréation des checks sans 'procedure' (mêmes noms de contraintes que les migrations
--    52/53 et que drop-communication-plan.sql pour categories).
delete from categories where resource_type = 'procedure';
alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'accident', 'pdca', 'nonconforming_output',
    'customer_satisfaction', 'employee'
  )
);

delete from record_shares where resource_type = 'procedure';
alter table record_shares drop constraint if exists record_shares_resource_type_check;
alter table record_shares add constraint record_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

delete from guest_shares where resource_type = 'procedure';
alter table guest_shares drop constraint if exists guest_shares_resource_type_check;
alter table guest_shares add constraint guest_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

delete from guest_share_items where resource_type = 'procedure';
alter table guest_share_items drop constraint if exists guest_share_items_resource_type_check;
alter table guest_share_items add constraint guest_share_items_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

-- 5. Fonctions dédiées au module.
drop function if exists search_procedure_ids(uuid, text);
-- Le trigger sur procedure_versions tombe avec la table ; la fonction doit être supprimée
-- explicitement (elle n'appartient à aucune table).
drop function if exists procedure_versions_search_vector_update() cascade;

-- 6. Tables du module. Même ordre que le rollback de la migration 31 : on casse d'abord la
--    référence circulaire procedures.current_version_id -> procedure_versions. cascade :
--    les policies share_api_* posées par la migration 56 sur ces tables tombent avec elles.
alter table if exists procedures drop column if exists current_version_id;
drop table if exists procedure_audit_links cascade;
drop table if exists procedure_capa_links cascade;
drop table if exists procedure_acknowledgments cascade;
drop table if exists procedure_generation_jobs cascade;
drop table if exists procedure_versions cascade;
drop table if exists procedure_templates cascade;
drop table if exists procedures cascade;

commit;
