-- Suppression du module "Plan de communication" (communication_plan_items) — à exécuter une
-- seule fois sur la base de production (Supabase SQL Editor, ou psql avec DATABASE_URL_PROD).
-- Déjà appliqué sur la base locale de dev/tests par Claude ; ce script n'est nécessaire que
-- pour la prod, non joignable depuis cet environnement (pas de route réseau vers
-- db.<projet>.supabase.co).
--
-- Sans risque de perte si la table est vide (cas confirmé en local) ; si des lignes de plan de
-- communication existent réellement en prod, cette suppression est définitive (drop cascade).
-- Pas de colonne miroir sur capas à retirer ici (communication_plan_items n'a jamais été lié à
-- une CAPA — référentiel de communication, pas un mécanisme de non-conformité).

begin;

alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'procedure', 'accident', 'pdca', 'nonconforming_output',
    'customer_satisfaction', 'employee'
  )
);

drop table if exists communication_plan_items cascade;

commit;
