create table audits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  title          text not null,
  audit_type     text not null default 'process' check (audit_type in ('process', 'product', 'system')),
  scope          text,
  service_id     uuid references services (id) on delete set null,
  lead_auditor   uuid references users (id) on delete set null,
  planned_date   date not null,
  completed_date date,
  status         text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'closed')),
  conclusion     text,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table audit_findings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  audit_id       uuid not null references audits (id) on delete cascade,
  type           text not null check (type in ('major_nc', 'minor_nc', 'observation', 'strength')),
  description    text not null,
  linked_capa_id uuid references capas (id) on delete set null,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table capas add column audit_finding_id uuid references audit_findings (id) on delete set null;

create index idx_audits_tenant_id on audits (tenant_id);
create index idx_audits_status on audits (status);
create index idx_audits_planned_date on audits (planned_date);
create index idx_audits_service_id on audits (service_id);

create index idx_audit_findings_tenant_id on audit_findings (tenant_id);
create index idx_audit_findings_audit_id on audit_findings (audit_id);

create trigger trg_audits_updated_at before update on audits
  for each row execute function set_updated_at();

create trigger trg_audit_findings_updated_at before update on audit_findings
  for each row execute function set_updated_at();

alter table audits enable row level security;
alter table audit_findings enable row level security;

create policy audits_isolation on audits
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy audit_findings_isolation on audit_findings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
