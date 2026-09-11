-- Suppression du module "Revue des exigences avant engagement" (order_reviews) — à exécuter
-- une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude ; ce script
-- n'est nécessaire que pour la prod, non joignable depuis cet environnement (pas de route
-- réseau vers db.<projet>.supabase.co).
--
-- Sans risque de perte si la table est vide (cas confirmé en local) ; si des revues de
-- commande existent réellement en prod, cette suppression est définitive (drop table cascade).
-- Pas de colonne miroir sur capas à retirer ici (order_reviews n'a jamais été lié à une CAPA
-- — voir le commentaire d'origine dans schema.sql : refuser une commande est une décision
-- commerciale, pas une non-conformité).

begin;

alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'procedure', 'accident', 'pdca', 'nonconforming_output',
    'qms_change', 'customer_satisfaction', 'communication_plan', 'employee'
  )
);

drop table if exists order_reviews cascade;

commit;
