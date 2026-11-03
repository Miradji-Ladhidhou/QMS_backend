-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql (backend/)
-- pour permettre de ranger les KPI dans des dossiers imbriqués (ex : "Contrôle commande" >
-- "Contrôle 2026" > les KPI de 2026, "Contrôle 2027" > les KPI de 2027) au lieu d'une liste
-- plate.

create table if not exists kpi_folders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  parent_id   uuid references kpi_folders (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table kpis add column if not exists folder_id uuid references kpi_folders (id) on delete set null;

create index if not exists idx_kpi_folders_tenant_id on kpi_folders (tenant_id);
create index if not exists idx_kpi_folders_parent_id on kpi_folders (parent_id);
create index if not exists idx_kpis_folder_id on kpis (folder_id);

alter table kpi_folders enable row level security;

drop policy if exists kpi_folders_isolation on kpi_folders;
create policy kpi_folders_isolation on kpi_folders
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
