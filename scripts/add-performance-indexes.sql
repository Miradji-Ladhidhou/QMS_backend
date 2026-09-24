-- Index composites pour les listes et historiques les plus consultés.
-- À exécuter une fois dans Supabase SQL Editor.

create index if not exists idx_kpi_records_kpi_period
  on kpi_records (kpi_id, period_date desc);

create index if not exists idx_kpi_records_config_period
  on kpi_records (config_id, period_date desc);

create index if not exists idx_kpi_raw_imports_tenant_imported
  on kpi_raw_imports (tenant_id, imported_at desc);

create index if not exists idx_kpi_raw_rows_import_row
  on kpi_raw_rows (import_id, row_index);

create index if not exists idx_document_versions_document_created
  on document_versions (document_id, created_at desc);

create index if not exists idx_training_records_training_completed
  on training_records (training_id, completed_at desc);

create index if not exists idx_users_tenant_name
  on users (tenant_id, full_name);

create index if not exists idx_capas_tenant_created
  on capas (tenant_id, created_at desc);

create index if not exists idx_documents_tenant_created
  on documents (tenant_id, created_at desc);

notify pgrst, 'reload schema';
