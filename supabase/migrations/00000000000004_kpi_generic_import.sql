-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql (backend/)
-- pour remplacer l'import CSV à colonnes fixes (kpi_detail_records / kpi_import_batches)
-- par un import générique (kpi_raw_imports / kpi_raw_rows / kpi_calculation_configs), et
-- simplifier kpis.calculation_type à un simple interrupteur 'manual'|'import' : le type de
-- calcul précis (ratio, sum, average, count, count_grouped) vit désormais uniquement dans
-- kpi_calculation_configs.calc_type.

-- 1. kpis.calculation_type : 'ratio' -> 'import', puis contrainte resserrée.
update kpis set calculation_type = 'import' where calculation_type = 'ratio';
alter table kpis drop constraint if exists kpis_calculation_type_check;
alter table kpis add constraint kpis_calculation_type_check check (calculation_type in ('manual', 'import'));

-- 2. kpi_raw_imports doit exister avant que kpi_records puisse y référencer source_import_id.
create table if not exists kpi_raw_imports (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid references kpis (id) on delete cascade,
  file_name         text,
  imported_by       uuid references users (id) on delete set null,
  imported_at       timestamptz not null default now(),
  detected_columns  jsonb not null default '[]'::jsonb,
  row_count         integer not null default 0
);

create table if not exists kpi_raw_rows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  import_id   uuid not null references kpi_raw_imports (id) on delete cascade,
  row_index   integer not null,
  row_data    jsonb not null
);

create table if not exists kpi_calculation_configs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid not null references kpis (id) on delete cascade,
  calc_type         text not null check (calc_type in ('ratio', 'sum', 'average', 'count', 'count_grouped')),
  source_column     text,
  filter_column     text,
  filter_value      text,
  group_by_column   text,
  period_column     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (kpi_id)
);

-- 3. kpi_records : 'import_csv' -> 'import', import_batch_id -> source_import_id (nouvelle
-- cible : kpi_raw_imports au lieu de kpi_import_batches).
update kpi_records set source = 'import' where source = 'import_csv';
alter table kpi_records drop constraint if exists kpi_records_source_check;
alter table kpi_records add constraint kpi_records_source_check check (source in ('manual', 'import'));

alter table kpi_records drop constraint if exists kpi_records_import_batch_id_fkey;
drop index if exists idx_kpi_records_import_batch_id;
alter table kpi_records drop column if exists import_batch_id;
alter table kpi_records add column if not exists source_import_id uuid references kpi_raw_imports (id) on delete set null;
create index if not exists idx_kpi_records_source_import_id on kpi_records (source_import_id);

-- 4. Supprime l'ancien système à colonnes fixes (kpi_detail_records dépend de
-- kpi_import_batches via import_batch_id, donc dans cet ordre).
drop table if exists kpi_detail_records;
drop table if exists kpi_import_batches;

-- 5. Index, RLS, policies, grants pour les nouvelles tables.
create index if not exists idx_kpi_raw_imports_tenant_id on kpi_raw_imports (tenant_id);
create index if not exists idx_kpi_raw_imports_kpi_id on kpi_raw_imports (kpi_id);
create index if not exists idx_kpi_raw_rows_tenant_id on kpi_raw_rows (tenant_id);
create index if not exists idx_kpi_raw_rows_import_id on kpi_raw_rows (import_id);
create index if not exists idx_kpi_raw_rows_row_data on kpi_raw_rows using gin (row_data);
create index if not exists idx_kpi_calculation_configs_tenant_id on kpi_calculation_configs (tenant_id);
create index if not exists idx_kpi_calculation_configs_kpi_id on kpi_calculation_configs (kpi_id);

alter table kpi_raw_imports enable row level security;
alter table kpi_raw_rows enable row level security;
alter table kpi_calculation_configs enable row level security;

create policy kpi_raw_imports_isolation on kpi_raw_imports
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_raw_rows_isolation on kpi_raw_rows
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_calculation_configs_isolation on kpi_calculation_configs
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

grant all on kpi_raw_imports, kpi_raw_rows, kpi_calculation_configs to anon, authenticated, service_role;
