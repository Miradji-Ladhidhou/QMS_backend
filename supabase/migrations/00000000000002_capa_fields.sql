-- Applique en local, de façon incrémentale, les mêmes changements que schema.sql
-- (backend/) pour la table capas déjà créée par la migration 00000000000000.
alter table capas add column if not exists service text;
alter table capas add column if not exists description text;
alter table capas add column if not exists severity text not null default 'medium';
alter table capas add constraint capas_severity_check check (severity in ('low', 'medium', 'high', 'critical'));
alter table capas add column if not exists root_cause text;
alter table capas add column if not exists corrective_action text;
alter table capas add column if not exists preventive_action text;
alter table capas add column if not exists effectiveness_verified boolean;
alter table capas add column if not exists effectiveness_notes text;
alter table capas add column if not exists comment text;

create table if not exists capa_priority_delays (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  priority    text not null check (priority in ('low', 'medium', 'high', 'critical')),
  delay_days  integer not null check (delay_days > 0),
  primary key (tenant_id, priority)
);

alter table capa_priority_delays enable row level security;

create policy capa_priority_delays_isolation on capa_priority_delays
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

grant all on capa_priority_delays to anon, authenticated, service_role;
