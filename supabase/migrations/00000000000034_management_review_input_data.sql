-- Panneau "données d'entrée" des revues de direction : période choisie à la création
-- (period_start/period_end) et son snapshot agrégé figé (input_snapshot), distinct du
-- `snapshot` existant qui reste réservé à l'état du SMQ à la CLÔTURE — voir le commentaire dans
-- schema.sql au-dessus de `create table management_reviews` pour le détail de la distinction.

alter table management_reviews add column if not exists period_start date;
alter table management_reviews add column if not exists period_end date;
alter table management_reviews add column if not exists input_snapshot jsonb;

alter table management_reviews drop constraint if exists management_reviews_period_order_check;
alter table management_reviews add constraint management_reviews_period_order_check
  check (period_start is null or period_end is null or period_end >= period_start);
