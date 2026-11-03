create table suppliers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  name                  text not null,
  category              text,
  contact_name          text,
  contact_email         text,
  contact_phone         text,
  criticality           text not null default 'medium' check (criticality in ('low', 'medium', 'high', 'critical')),
  status                text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  service_id            uuid references services (id) on delete set null,
  next_evaluation_date  date,
  created_by            uuid references users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table supplier_evaluations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete cascade,
  supplier_id          uuid not null references suppliers (id) on delete cascade,
  evaluation_date      date not null,
  quality_score        integer not null check (quality_score between 1 and 5),
  delivery_score       integer not null check (delivery_score between 1 and 5),
  price_score          integer not null check (price_score between 1 and 5),
  responsiveness_score integer not null check (responsiveness_score between 1 and 5),
  overall_score        numeric generated always as (
    round((quality_score + delivery_score + price_score + responsiveness_score)::numeric / 4, 2)
  ) stored,
  decision             text not null default 'maintained' check (decision in ('maintained', 'under_watch', 'to_replace')),
  comment              text,
  linked_capa_id       uuid references capas (id) on delete set null,
  evaluated_by         uuid references users (id) on delete set null,
  created_at           timestamptz not null default now()
);

alter table capas add column supplier_evaluation_id uuid references supplier_evaluations (id) on delete set null;

create index idx_suppliers_tenant_id on suppliers (tenant_id);
create index idx_suppliers_status on suppliers (status);
create index idx_suppliers_service_id on suppliers (service_id);
create index idx_suppliers_next_evaluation_date on suppliers (next_evaluation_date);

create index idx_supplier_evaluations_tenant_id on supplier_evaluations (tenant_id);
create index idx_supplier_evaluations_supplier_id on supplier_evaluations (supplier_id);

create trigger trg_suppliers_updated_at before update on suppliers
  for each row execute function set_updated_at();

alter table suppliers enable row level security;
alter table supplier_evaluations enable row level security;

create policy suppliers_isolation on suppliers
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy supplier_evaluations_isolation on supplier_evaluations
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
