create table guest_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  resource_type text not null check (resource_type in ('document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit', 'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output', 'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy')),
  resource_id uuid not null,
  email text not null,
  token_hash text not null unique,
  code_hash text,
  code_expires_at timestamptz,
  code_sends integer not null default 0 check (code_sends between 0 and 3),
  code_sent_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  access_token_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index idx_guest_shares_tenant_resource on guest_shares (tenant_id, resource_type, resource_id);
create index idx_guest_shares_expiry on guest_shares (expires_at) where revoked_at is null;
alter table guest_shares enable row level security;

alter table record_shares drop constraint if exists record_shares_resource_type_check;
alter table record_shares add constraint record_shares_resource_type_check
  check (resource_type in ('document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit', 'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output', 'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'));
