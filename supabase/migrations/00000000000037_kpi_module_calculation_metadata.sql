-- Conserve la preuve de calcul des KPI modules pour l'audit et l'export.
alter table kpi_records add column if not exists calculation_metadata jsonb;

notify pgrst, 'reload schema';
