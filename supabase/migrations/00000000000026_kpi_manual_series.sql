-- calc_type = 'manual' : même principe de série nommée que les autres calc_type, mais sans
-- recette de calcul — sert à regrouper des valeurs saisies à la main sous plusieurs courbes
-- distinctes d'un même KPI "manuel", au lieu d'un seul point par période.
alter table kpi_calculation_configs drop constraint if exists kpi_calculation_configs_calc_type_check;
alter table kpi_calculation_configs add constraint kpi_calculation_configs_calc_type_check check (
  calc_type in ('ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped', 'manual')
);
