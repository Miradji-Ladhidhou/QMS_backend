-- Rattrapage documentaire : les tables accidents/pdca_projects ont été appliquées en
-- production via un script SQL collé manuellement (pas de fichier de migration créé sur le
-- coup). Ce fichier ne fait que consigner ce qui est déjà en place, pour que l'historique des
-- migrations reste complet — écrit en `if not exists` partout pour rester sans effet si
-- rejoué sur une base qui a déjà ces objets.

create table if not exists accidents (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  title               text not null,
  occurred_at         date not null,
  location            text,
  injured_user_id     uuid references users (id) on delete set null,
  injured_employee_id uuid references employees (id) on delete set null,
  service_id          uuid references services (id) on delete set null,
  description         text,
  immediate_cause     text,
  immediate_actions   text,
  root_cause          text,
  severity            text not null default 'minor' check (severity in ('minor', 'moderate', 'severe', 'fatal')),
  with_lost_time      boolean not null default false,
  lost_days           integer,
  status              text not null default 'open' check (status in ('open', 'investigating', 'closed')),
  category_id         uuid references categories (id) on delete set null,
  linked_capa_id      uuid references capas (id) on delete set null,
  closed_at           timestamptz,
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_accidents_tenant_id on accidents (tenant_id);

alter table capas add column if not exists accident_id uuid references accidents (id) on delete set null;

create table if not exists pdca_projects (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  title              text not null,
  description        text,
  service_id         uuid references services (id) on delete set null,
  owner              uuid references users (id) on delete set null,
  target_date        date,
  status             text not null default 'plan' check (status in ('plan', 'do', 'check', 'act', 'closed')),
  plan_content       text,
  plan_completed_at  date,
  do_content         text,
  do_completed_at    date,
  check_content      text,
  check_completed_at date,
  act_content        text,
  act_completed_at   date,
  category_id        uuid references categories (id) on delete set null,
  closed_at          timestamptz,
  created_by         uuid references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_pdca_projects_tenant_id on pdca_projects (tenant_id);

alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'procedure', 'accident', 'pdca'
  )
);

drop trigger if exists trg_accidents_updated_at on accidents;
create trigger trg_accidents_updated_at before update on accidents
  for each row execute function set_updated_at();

drop trigger if exists trg_pdca_projects_updated_at on pdca_projects;
create trigger trg_pdca_projects_updated_at before update on pdca_projects
  for each row execute function set_updated_at();

alter table accidents enable row level security;
alter table pdca_projects enable row level security;

drop policy if exists accidents_isolation on accidents;
create policy accidents_isolation on accidents
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

drop policy if exists pdca_projects_isolation on pdca_projects;
create policy pdca_projects_isolation on pdca_projects
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
