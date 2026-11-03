alter table guest_shares drop constraint if exists guest_shares_resource_type_check;
alter table guest_shares
  add constraint guest_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

alter table record_shares drop constraint if exists record_shares_resource_type_check;
alter table record_shares
  add constraint record_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

alter table guest_shares alter column code_expires_at drop not null;
alter table guest_shares
  add column if not exists code_sends integer not null default 0 check (code_sends between 0 and 3),
  add column if not exists code_sent_at timestamptz;
