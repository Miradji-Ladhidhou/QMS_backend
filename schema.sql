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

-- =============================================================================
-- TABLES
-- =============================================================================

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  plan        text not null default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table users (
  id          uuid primary key references auth.users (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  full_name   text,
  role        text not null default 'member' check (role in ('owner', 'admin', 'manager', 'member')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table document_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  color       text,
  required_approver_role text check (required_approver_role in ('owner', 'admin', 'manager', 'member')),
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
  extracted_text text,
  search_vector tsvector,
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
  status       text not null default 'open' check (status in ('open', 'in_progress', 'pending_verification', 'closed', 'overdue')),
  assigned_to  uuid references users (id) on delete set null,
  due_date     date,
  closed_at    timestamptz,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, number)
);

-- Compteur de numérotation des CAPA, par tenant et par année (CAPA-2026-001)
create table capa_counters (
  tenant_id  uuid not null references tenants (id) on delete cascade,
  year       integer not null,
  counter    integer not null default 0,
  primary key (tenant_id, year)
);

create table capa_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  capa_id     uuid not null references capas (id) on delete cascade,
  user_id     uuid references users (id) on delete set null,
  comment     text not null,
  created_at  timestamptz not null default now()
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
  target_direction text not null default 'min' check (target_direction in ('min', 'max')),
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

-- Workflow d'approbation tracé (remplace le simple champ status en donnant une
-- preuve auditable de qui devait approuver et de l'état de chacun).
create table document_workflows (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  document_id         uuid not null references documents (id) on delete cascade,
  required_approvers  uuid[] not null,
  current_step        integer not null default 0,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Une ligne par approbateur requis, créée dès la soumission (decision='pending'),
-- puis mise à jour par cet approbateur (jamais par un autre) quand il décide.
create table document_approvals (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  workflow_id     uuid not null references document_workflows (id) on delete cascade,
  approver_id     uuid not null references users (id) on delete cascade,
  decision        text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  comment         text,
  decided_at      timestamptz,
  signature_hash  text,
  ip_address      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workflow_id, approver_id)
);

-- Piste d'audit exigée par ISO 9001 / FDA 21 CFR Part 11 : INSERT uniquement,
-- jamais de UPDATE/DELETE (voir le trigger document_audit_log_immutable plus bas).
create table document_audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  document_id uuid not null references documents (id) on delete cascade,
  user_id     uuid references users (id) on delete set null,
  action      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create table user_notification_preferences (
  user_id                   uuid primary key references users (id) on delete cascade,
  tenant_id                 uuid not null references tenants (id) on delete cascade,
  email_documents_to_review boolean not null default true,
  email_capa_overdue        boolean not null default true,
  email_training_renewal    boolean not null default true,
  email_approval_requests   boolean not null default true,
  digest_frequency          text not null default 'daily' check (digest_frequency in ('immediate', 'daily', 'weekly')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Trace chaque email envoyé (job planifié ou déclenchement immédiat) : sert au debug
-- et, via la contrainte unique ci-dessous, empêche physiquement de renvoyer la même
-- alerte deux fois le même jour au même utilisateur.
create table notification_log (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  user_id            uuid not null references users (id) on delete cascade,
  notification_type  text not null,
  reference_id       uuid,
  sent_date          date not null default current_date,
  created_at         timestamptz not null default now(),
  unique (user_id, notification_type, reference_id, sent_date)
);

-- Notifications visibles dans l'application (cloche), en complément de l'email :
-- une ligne par alerte générée, indépendamment du succès de l'envoi email.
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  type        text not null,
  title       text not null,
  message     text,
  link        text,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

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
-- INDEX
-- =============================================================================

create index idx_users_tenant_id on users (tenant_id);

create index idx_document_categories_tenant_id on document_categories (tenant_id);

create index idx_documents_tenant_id on documents (tenant_id);
create index idx_documents_category_id on documents (category_id);
create index idx_documents_status on documents (status);
create index idx_documents_title_trgm on documents using gin (title gin_trgm_ops);
create index idx_documents_search_vector on documents using gin (search_vector);

create index idx_document_versions_document_id on document_versions (document_id);
create index idx_document_versions_tenant_id on document_versions (tenant_id);

create index idx_capas_tenant_id on capas (tenant_id);
create index idx_capas_status on capas (status);
create index idx_capas_assigned_to on capas (assigned_to);
create index idx_capas_ref_document on capas (ref_document);
create index idx_capas_due_date on capas (due_date);

create index idx_capa_comments_tenant_id on capa_comments (tenant_id);
create index idx_capa_comments_capa_id on capa_comments (capa_id);

create index idx_trainings_tenant_id on trainings (tenant_id);

create index idx_training_records_tenant_id on training_records (tenant_id);
create index idx_training_records_training_id on training_records (training_id);
create index idx_training_records_user_id on training_records (user_id);
create index idx_training_records_next_due_date on training_records (next_due_date);

create index idx_kpis_tenant_id on kpis (tenant_id);

create index idx_kpi_records_tenant_id on kpi_records (tenant_id);
create index idx_kpi_records_kpi_id on kpi_records (kpi_id);
create index idx_kpi_records_period_date on kpi_records (period_date);

create index idx_document_workflows_tenant_id on document_workflows (tenant_id);
create index idx_document_workflows_document_id on document_workflows (document_id);
create index idx_document_workflows_status on document_workflows (status);

create index idx_document_approvals_tenant_id on document_approvals (tenant_id);
create index idx_document_approvals_workflow_id on document_approvals (workflow_id);
create index idx_document_approvals_approver_id on document_approvals (approver_id);

create index idx_document_audit_log_tenant_id on document_audit_log (tenant_id);
create index idx_document_audit_log_document_id on document_audit_log (document_id);
create index idx_document_audit_log_created_at on document_audit_log (created_at);

create index idx_user_notification_preferences_tenant_id on user_notification_preferences (tenant_id);

create index idx_notification_log_tenant_id on notification_log (tenant_id);
create index idx_notification_log_user_id on notification_log (user_id);
create index idx_notification_log_sent_date on notification_log (sent_date);

create index idx_notifications_tenant_id on notifications (tenant_id);
create index idx_notifications_user_id on notifications (user_id);
create index idx_notifications_user_read on notifications (user_id, read);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function set_updated_at();

create trigger trg_users_updated_at before update on users
  for each row execute function set_updated_at();

create trigger trg_documents_updated_at before update on documents
  for each row execute function set_updated_at();

-- Recherche plein texte (français) : title poids A, description poids B, extracted_text poids C
create or replace function documents_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('french', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('french', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('french', coalesce(new.extracted_text, '')), 'C');
  return new;
end;
$$;

create trigger trg_documents_search_vector before insert or update on documents
  for each row execute function documents_search_vector_update();

create trigger trg_capas_updated_at before update on capas
  for each row execute function set_updated_at();

create trigger trg_trainings_updated_at before update on trainings
  for each row execute function set_updated_at();

create trigger trg_kpis_updated_at before update on kpis
  for each row execute function set_updated_at();

create trigger trg_document_workflows_updated_at before update on document_workflows
  for each row execute function set_updated_at();

create trigger trg_document_approvals_updated_at before update on document_approvals
  for each row execute function set_updated_at();

-- document_audit_log est une piste d'audit : aucune modification ni suppression
-- n'est autorisée, quel que soit le rôle (y compris service_role), uniquement des INSERT.
create or replace function document_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'document_audit_log est immuable : aucune modification ni suppression autorisée.';
end;
$$;

create trigger trg_document_audit_log_immutable
  before update or delete on document_audit_log
  for each row execute function document_audit_log_immutable();

create trigger trg_user_notification_preferences_updated_at before update on user_notification_preferences
  for each row execute function set_updated_at();
-- Numérotation auto-incrémentée des CAPA par tenant et par année (ex : CAPA-2026-001)
create or replace function set_capa_number()
returns trigger
language plpgsql
as $$
declare
  capa_year integer := extract(year from now())::integer;
  next_seq integer;
begin
  insert into capa_counters (tenant_id, year, counter)
    values (new.tenant_id, capa_year, 1)
    on conflict (tenant_id, year)
    do update set counter = capa_counters.counter + 1
    returning counter into next_seq;

  new.number := 'CAPA-' || capa_year || '-' || lpad(next_seq::text, 3, '0');
  return new;
end;
$$;

create trigger trg_set_capa_number before insert on capas
  for each row when (new.number is null) execute function set_capa_number();

-- =============================================================================
-- RECHERCHE
-- =============================================================================

-- Recherche plein texte sur les documents : classement par pertinence (ts_rank),
-- extrait mis en évidence (ts_headline), et localisation de la correspondance
-- (titre vs contenu) pour l'indicateur visuel côté frontend.
create or replace function search_documents(p_tenant_id uuid, p_query text, p_limit integer default 20)
returns table (
  id uuid,
  number text,
  title text,
  status text,
  category_id uuid,
  rank real,
  snippet text,
  match_location text
)
language sql
stable
as $$
  select
    d.id,
    d.number,
    d.title,
    d.status,
    d.category_id,
    ts_rank(d.search_vector, query) as rank,
    ts_headline(
      'french',
      coalesce(d.title, '') || '. ' || coalesce(d.description, '') || '. ' || coalesce(d.extracted_text, ''),
      query,
      'MaxWords=30, MinWords=15, ShortWord=3, HighlightAll=false, MaxFragments=1, StartSel=<mark>, StopSel=</mark>'
    ) as snippet,
    case
      when to_tsvector('french', coalesce(d.title, '')) @@ query then 'title'
      else 'content'
    end as match_location
  from documents d, websearch_to_tsquery('french', p_query) query
  where d.tenant_id = p_tenant_id
    and d.search_vector @@ query
  order by rank desc
  limit p_limit;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

alter table tenants enable row level security;
alter table users enable row level security;
alter table document_categories enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table capas enable row level security;
alter table capa_counters enable row level security;
alter table capa_comments enable row level security;
alter table trainings enable row level security;
alter table training_records enable row level security;
alter table kpis enable row level security;
alter table kpi_records enable row level security;
alter table document_workflows enable row level security;
alter table document_approvals enable row level security;
alter table document_audit_log enable row level security;
alter table user_notification_preferences enable row level security;
alter table notification_log enable row level security;
alter table notifications enable row level security;

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

create policy capa_counters_isolation on capa_counters
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capa_comments_isolation on capa_comments
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

create policy document_workflows_isolation on document_workflows
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_approvals_isolation on document_approvals
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

-- Lecture seule via RLS (en plus du trigger d'immuabilité) : même un accès authentifié
-- direct ne peut qu'insérer/lire, jamais modifier ou supprimer une entrée d'audit.
create policy document_audit_log_select on document_audit_log
  for select
  using (tenant_id = auth_tenant_id());

create policy document_audit_log_insert on document_audit_log
  for insert
  with check (tenant_id = auth_tenant_id());

create policy user_notification_preferences_isolation on user_notification_preferences
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy notification_log_isolation on notification_log
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy notifications_isolation on notifications
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
