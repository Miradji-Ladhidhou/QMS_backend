-- Liste fermée des services (Prompt B2), en remplacement progressif du champ texte libre
-- capas.service — les deux coexistent, "service" n'est pas encore supprimé.

create table services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table user_services (
  user_id     uuid not null references users (id) on delete cascade,
  service_id  uuid not null references services (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  primary key (user_id, service_id)
);

alter table capas add column service_id uuid references services (id) on delete set null;
comment on column capas.service_id is 'Remplace à terme le champ texte libre "service" — migration progressive, l''ancien champ reste en place pour l''instant.';

create index idx_services_tenant_id on services (tenant_id);
create index idx_user_services_tenant_id on user_services (tenant_id);
create index idx_user_services_user_id on user_services (user_id);
create index idx_user_services_service_id on user_services (service_id);
create index idx_capas_service_id on capas (service_id);

alter table services enable row level security;
alter table user_services enable row level security;

create policy services_isolation on services
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy user_services_isolation on user_services
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
