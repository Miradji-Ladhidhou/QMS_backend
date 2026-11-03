-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql (backend/)
-- pour permettre à un KPI de porter plusieurs "séries" (recettes de calcul nommées),
-- affichées ensemble sur le même graphique — ex : "Conforme" et "Non conforme" comparées
-- sur la même période, plutôt que deux KPI séparés.

-- 1. kpi_calculation_configs : ajoute un nom de série, retire la limite à une seule recette
-- par KPI.
alter table kpi_calculation_configs add column if not exists label text not null default 'Principal';
alter table kpi_calculation_configs drop constraint if exists kpi_calculation_configs_kpi_id_key;

-- 2. kpi_records : config_id identifie quelle série a produit la valeur (nul pour une
-- saisie manuelle, qui n'a pas de recette).
alter table kpi_records add column if not exists config_id uuid references kpi_calculation_configs (id) on delete cascade;

-- Chaque KPI n'avait jusqu'ici qu'une seule recette (contrainte unique(kpi_id) qu'on vient
-- de retirer) : les valeurs déjà calculées par import s'y rattachaient donc sans ambiguïté.
update kpi_records
set config_id = (select id from kpi_calculation_configs c where c.kpi_id = kpi_records.kpi_id limit 1)
where source = 'import' and config_id is null;

-- 3. Remplace l'unicité (kpi_id, period_date) — qui empêcherait deux séries d'avoir chacune
-- leur valeur sur la même période — par (config_id, period_date) pour les séries (les NULL
-- ne se bloquent jamais entre eux dans une contrainte unique standard, donc celle-ci ne
-- régit que les lignes avec un config_id) et un index partiel dédié à l'unicité par KPI des
-- saisies manuelles (config_id null).
alter table kpi_records drop constraint if exists kpi_records_kpi_id_period_date_key;
alter table kpi_records add constraint kpi_records_config_id_period_date_key unique (config_id, period_date);
create unique index if not exists idx_kpi_records_manual_period on kpi_records (kpi_id, period_date) where config_id is null;

create index if not exists idx_kpi_records_config_id on kpi_records (config_id);
