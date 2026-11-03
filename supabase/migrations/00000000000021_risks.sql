create table risks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  title               text not null,
  type                text not null default 'risk' check (type in ('risk', 'opportunity')),
  category            text,
  description         text,
  service_id          uuid references services (id) on delete set null,
  owner               uuid references users (id) on delete set null,
  likelihood          integer not null check (likelihood between 1 and 5),
  impact              integer not null check (impact between 1 and 5),
  risk_score          integer generated always as (likelihood * impact) stored,
  current_controls    text,
  treatment_plan      text,
  residual_likelihood integer check (residual_likelihood between 1 and 5),
  residual_impact     integer check (residual_impact between 1 and 5),
  residual_score      integer generated always as (residual_likelihood * residual_impact) stored,
  status              text not null default 'identified' check (status in ('identified', 'treating', 'treated', 'accepted', 'closed')),
  review_date         date,
  linked_capa_id      uuid references capas (id) on delete set null,
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table capas add column risk_id uuid references risks (id) on delete set null;

create index idx_risks_tenant_id on risks (tenant_id);
create index idx_risks_status on risks (status);
create index idx_risks_service_id on risks (service_id);
create index idx_risks_review_date on risks (review_date);
create index idx_risks_score on risks (risk_score);

create trigger trg_risks_updated_at before update on risks
  for each row execute function set_updated_at();

alter table risks enable row level security;

create policy risks_isolation on risks
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
