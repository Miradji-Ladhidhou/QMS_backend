create table if not exists qms_evidence_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  module_key text not null check (module_key in ('accidents', 'nonconforming-outputs', 'audits', 'complaints', 'capas', 'haccp')),
  record_id uuid not null,
  drive_file_id text not null,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  file_size integer not null check (file_size > 0),
  caption text,
  uploaded_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_qms_evidence_record on qms_evidence_attachments (tenant_id, module_key, record_id, created_at);
create unique index if not exists idx_qms_evidence_drive_file on qms_evidence_attachments (tenant_id, drive_file_id);

alter table qms_evidence_attachments enable row level security;

drop policy if exists qms_evidence_attachments_isolation on qms_evidence_attachments;
create policy qms_evidence_attachments_isolation on qms_evidence_attachments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
