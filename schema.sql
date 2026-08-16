-- =============================================================================
-- QMS SaaS — Schéma PostgreSQL (Supabase)
-- Multitenant : isolation stricte des données par tenant_id via Row Level Security
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- =============================================================================
-- FONCTIONS UTILITAIRES
-- =============================================================================

-- Timestamp updated_at automatique
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Résout le tenant_id de l'utilisateur authentifié (utilisé par les policies RLS).
-- SECURITY DEFINER + search_path fixe : contourne le RLS de public.users pour
-- éviter une récursion de policy, sans exposer de faille de search_path.
create or replace function auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid();
$$;

-- =============================================================================
-- TABLES
-- =============================================================================

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  plan        text not null default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  logo_url    text,
  capa_counter integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  id          uuid primary key references auth.users (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  full_name   text,
  role        text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table document_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  color       text,
  created_at  timestamptz not null default now()
);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  category_id  uuid references document_categories (id) on delete set null,
  number       text not null,
  title        text not null,
  description  text,
  version      text not null default '1.0',
  status       text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  file_path    text,
  file_name    text,
  created_by   uuid references users (id) on delete set null,
  approved_by  uuid references users (id) on delete set null,
  review_date  date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, number)
);

create table document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents (id) on delete cascade,
  tenant_id    uuid not null references tenants (id) on delete cascade,
  version      text not null,
  file_path    text,
  file_name    text,
  status       text,
  change_note  text,
  changed_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table capas (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  number       text,
  title        text not null,
  origin       text,
  ref_document uuid references documents (id) on delete set null,
  priority     text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status       text not null default 'open' check (status in ('open', 'in_progress', 'pending_verification', 'closed')),
  assigned_to  uuid references users (id) on delete set null,
  due_date     date,
  closed_at    timestamptz,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, number)
);

create table trainings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  title             text not null,
  type              text,
  frequency_months  integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table training_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  training_id    uuid not null references trainings (id) on delete cascade,
  user_id        uuid not null references users (id) on delete cascade,
  completed_at   date not null,
  next_due_date  date,
  certificate_url text,
  created_at     timestamptz not null default now()
);

create table kpis (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  unit        text,
  target      numeric,
  frequency   text check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table kpi_records (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  kpi_id       uuid not null references kpis (id) on delete cascade,
  period_date  date not null,
  value        numeric not null,
  recorded_by  uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (kpi_id, period_date)
);

-- =============================================================================
-- INDEX
-- =============================================================================

create index idx_users_tenant_id on users (tenant_id);

create index idx_document_categories_tenant_id on document_categories (tenant_id);

create index idx_documents_tenant_id on documents (tenant_id);
create index idx_documents_category_id on documents (category_id);
create index idx_documents_status on documents (status);
create index idx_documents_title_trgm on documents using gin (title gin_trgm_ops);

create index idx_document_versions_document_id on document_versions (document_id);
create index idx_document_versions_tenant_id on document_versions (tenant_id);

create index idx_capas_tenant_id on capas (tenant_id);
create index idx_capas_status on capas (status);
create index idx_capas_assigned_to on capas (assigned_to);
create index idx_capas_ref_document on capas (ref_document);

create index idx_trainings_tenant_id on trainings (tenant_id);

create index idx_training_records_tenant_id on training_records (tenant_id);
create index idx_training_records_training_id on training_records (training_id);
create index idx_training_records_user_id on training_records (user_id);
create index idx_training_records_next_due_date on training_records (next_due_date);

create index idx_kpis_tenant_id on kpis (tenant_id);

create index idx_kpi_records_tenant_id on kpi_records (tenant_id);
create index idx_kpi_records_kpi_id on kpi_records (kpi_id);
create index idx_kpi_records_period_date on kpi_records (period_date);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function set_updated_at();

create trigger trg_users_updated_at before update on users
  for each row execute function set_updated_at();

create trigger trg_documents_updated_at before update on documents
  for each row execute function set_updated_at();

create trigger trg_capas_updated_at before update on capas
  for each row execute function set_updated_at();

create trigger trg_trainings_updated_at before update on trainings
  for each row execute function set_updated_at();

create trigger trg_kpis_updated_at before update on kpis
  for each row execute function set_updated_at();

-- Numérotation auto-incrémentée des CAPA par tenant (ex : CAPA-00001)
create or replace function set_capa_number()
returns trigger
language plpgsql
as $$
declare
  next_seq integer;
begin
  update tenants set capa_counter = capa_counter + 1
    where id = new.tenant_id
    returning capa_counter into next_seq;

  new.number := 'CAPA-' || lpad(next_seq::text, 5, '0');
  return new;
end;
$$;

create trigger trg_set_capa_number before insert on capas
  for each row when (new.number is null) execute function set_capa_number();

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

alter table tenants enable row level security;
alter table users enable row level security;
alter table document_categories enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table capas enable row level security;
alter table trainings enable row level security;
alter table training_records enable row level security;
alter table kpis enable row level security;
alter table kpi_records enable row level security;

-- tenants : un utilisateur ne voit que son propre tenant
create policy tenants_isolation on tenants
  for all
  using (id = auth_tenant_id())
  with check (id = auth_tenant_id());

-- users : visibles/modifiables uniquement au sein du même tenant
create policy users_isolation on users
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_categories_isolation on document_categories
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy documents_isolation on documents
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_versions_isolation on document_versions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capas_isolation on capas
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy trainings_isolation on trainings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy training_records_isolation on training_records
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpis_isolation on kpis
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_records_isolation on kpi_records
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
