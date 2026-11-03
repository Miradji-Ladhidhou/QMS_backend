create table complaints (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  customer_name     text not null,
  customer_contact  text,
  received_date     date not null,
  due_date          date,
  description       text not null,
  product_service   text,
  severity          text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  status            text not null default 'received' check (status in ('received', 'investigating', 'resolved', 'closed')),
  service_id        uuid references services (id) on delete set null,
  assigned_to       uuid references users (id) on delete set null,
  root_cause        text,
  resolution        text,
  resolution_date   date,
  customer_satisfied boolean,
  linked_capa_id    uuid references capas (id) on delete set null,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table capas add column complaint_id uuid references complaints (id) on delete set null;

create index idx_complaints_tenant_id on complaints (tenant_id);
create index idx_complaints_status on complaints (status);
create index idx_complaints_assigned_to on complaints (assigned_to);
create index idx_complaints_due_date on complaints (due_date);
create index idx_complaints_service_id on complaints (service_id);

create trigger trg_complaints_updated_at before update on complaints
  for each row execute function set_updated_at();

alter table complaints enable row level security;

create policy complaints_isolation on complaints
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
