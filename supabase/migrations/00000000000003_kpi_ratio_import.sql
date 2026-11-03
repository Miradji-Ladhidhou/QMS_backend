-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql
-- (backend/) pour le calcul de KPI par ratio + import CSV de détail.
alter table kpis add column if not exists calculation_type text not null default 'manual';
alter table kpis add constraint kpis_calculation_type_check check (calculation_type in ('manual', 'ratio'));

create table if not exists kpi_import_batches (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  kpi_id        uuid not null references kpis (id) on delete cascade,
  file_name     text,
  imported_by   uuid references users (id) on delete set null,
  imported_at   timestamptz not null default now(),
  rows_total    integer not null default 0,
  rows_valid    integer not null default 0,
  rows_rejected integer not null default 0
);

alter table kpi_records add column if not exists source text not null default 'manual';
alter table kpi_records add constraint kpi_records_source_check check (source in ('manual', 'import_csv'));
alter table kpi_records add column if not exists import_batch_id uuid references kpi_import_batches (id) on delete set null;

create table if not exists kpi_detail_records (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  kpi_id          uuid not null references kpis (id) on delete cascade,
  period_date     date not null,
  item_reference  text not null,
  is_compliant    boolean not null,
  comment         text,
  import_batch_id uuid references kpi_import_batches (id) on delete cascade,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_kpi_records_import_batch_id on kpi_records (import_batch_id);
create index if not exists idx_kpi_import_batches_tenant_id on kpi_import_batches (tenant_id);
create index if not exists idx_kpi_import_batches_kpi_id on kpi_import_batches (kpi_id);
create index if not exists idx_kpi_detail_records_tenant_id on kpi_detail_records (tenant_id);
create index if not exists idx_kpi_detail_records_kpi_id on kpi_detail_records (kpi_id);
create index if not exists idx_kpi_detail_records_period_date on kpi_detail_records (period_date);
create index if not exists idx_kpi_detail_records_import_batch_id on kpi_detail_records (import_batch_id);

alter table kpi_import_batches enable row level security;
alter table kpi_detail_records enable row level security;

create policy kpi_import_batches_isolation on kpi_import_batches
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_detail_records_isolation on kpi_detail_records
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

grant all on kpi_import_batches, kpi_detail_records to anon, authenticated, service_role;
