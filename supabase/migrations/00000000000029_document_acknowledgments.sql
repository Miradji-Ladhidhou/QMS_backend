-- Accusé de lecture ISO 9001 sur les documents (voir schema.sql pour la justification
-- complète) : requires_acknowledgment est un opt-in par document (admin/manager), et
-- document_acknowledgments trace qui a lu quelle VERSION, quand.

alter table documents add column requires_acknowledgment boolean not null default false;

create table document_acknowledgments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  document_id     uuid not null references documents (id) on delete cascade,
  version         text not null,
  user_id         uuid not null references users (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (document_id, user_id, version)
);

create index idx_document_acknowledgments_tenant_id on document_acknowledgments (tenant_id);
create index idx_document_acknowledgments_document_id on document_acknowledgments (document_id);

alter table document_acknowledgments enable row level security;

create policy document_acknowledgments_isolation on document_acknowledgments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
