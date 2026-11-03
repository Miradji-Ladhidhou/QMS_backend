-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql (backend/)
-- pour remplacer la condition unique (filter_column/filter_value, seulement pour ratio) par
-- un tableau de conditions (filters, combinables en ET/OU) applicable à toute agrégation,
-- et ajouter min/max aux agrégations possibles.

alter table kpi_calculation_configs drop constraint if exists kpi_calculation_configs_calc_type_check;
alter table kpi_calculation_configs add constraint kpi_calculation_configs_calc_type_check
  check (calc_type in ('ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped'));

alter table kpi_calculation_configs add column if not exists filters jsonb not null default '[]'::jsonb;
alter table kpi_calculation_configs add column if not exists filter_logic text not null default 'all';
alter table kpi_calculation_configs drop constraint if exists kpi_calculation_configs_filter_logic_check;
alter table kpi_calculation_configs add constraint kpi_calculation_configs_filter_logic_check
  check (filter_logic in ('all', 'any'));

-- Migre les recettes ratio existantes (filter_column/filter_value uniques) vers le nouveau
-- tableau filters, puis retire les anciennes colonnes.
update kpi_calculation_configs
set filters = jsonb_build_array(jsonb_build_object('column', filter_column, 'operator', 'equals', 'value', filter_value))
where filter_column is not null and filter_value is not null and filters = '[]'::jsonb;

alter table kpi_calculation_configs drop column if exists filter_column;
alter table kpi_calculation_configs drop column if exists filter_value;
