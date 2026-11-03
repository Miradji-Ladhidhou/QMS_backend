-- Rollback de 00000000000058_drop_procedures.sql : recrée la STRUCTURE du module Procédures
-- (tables, colonnes miroirs, checks, fonctions, triggers, index, RLS) telle qu'avant la
-- suppression. Les DONNÉES supprimées (procédures, versions, liens, partages, catégories
-- 'procedure') ne sont pas restaurables — restaurer une sauvegarde pour les retrouver.

begin;

-- 1. Tables du module (définitions issues de schema.sql avant suppression).
create table procedures (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  source_document_id uuid references documents (id) on delete set null,
  number            text not null,
  title             text not null,
  process           text,
  status            text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  next_review_date  date,
  created_by        uuid references users (id) on delete set null,
  obsolete_reason   text,
  obsoleted_at      timestamptz,
  obsoleted_by      uuid references users (id) on delete set null,
  category_id       uuid references categories (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, number)
);

create table procedure_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  version       text not null,
  content       jsonb not null default '{}',
  ai_generated  boolean not null default false,
  author_id     uuid references users (id) on delete set null,
  validator_id  uuid references users (id) on delete set null,
  submitted_at  timestamptz,
  validated_at  timestamptz,
  status        text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  comment       text,
  attachment_file_path      text,
  attachment_file_name      text,
  attachment_storage_provider text,
  distribution_sheet jsonb,
  search_vector tsvector,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table procedures add column current_version_id uuid references procedure_versions (id) on delete set null;

create table procedure_templates (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete cascade unique,
  section_structure    jsonb not null default '[]',
  fixed_instructions   text,
  accent_color         text not null default '#44546A',
  visual_options       jsonb not null default '{"band": false, "bulletStyle": "dash", "calloutStyle": "left-border"}',
  render_style         jsonb,
  active_preset_id     text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table procedure_generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  created_by          uuid references users (id) on delete set null,
  subject             text not null,
  template_snapshot   jsonb not null,
  status              text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  total_steps         integer,
  completed_steps     integer not null default 0,
  current_step_label  text,
  result              jsonb,
  failed_subsections  jsonb not null default '[]',
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table procedure_acknowledgments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  procedure_version_id  uuid not null references procedure_versions (id) on delete cascade,
  user_id               uuid not null references users (id) on delete cascade,
  acknowledged_at       timestamptz not null default now(),
  unique (procedure_version_id, user_id)
);

create table procedure_capa_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  capa_id       uuid not null references capas (id) on delete cascade,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (procedure_id, capa_id)
);

create table procedure_audit_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  audit_id      uuid not null references audits (id) on delete cascade,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (procedure_id, audit_id)
);

-- 2. Colonnes miroirs dans les autres modules.
alter table if exists ai_generations add column if not exists job_id uuid references procedure_generation_jobs (id) on delete set null;

alter table risk_links drop constraint if exists risk_links_single_target_check;
alter table risk_links add column procedure_id uuid references procedures (id) on delete cascade;
alter table risk_links add check (num_nonnulls(audit_id, supplier_id, kpi_id, procedure_id) = 1);
create unique index uq_risk_links_procedure on risk_links (risk_id, procedure_id) where procedure_id is not null;

alter table haccp_plan_links drop constraint if exists haccp_plan_links_single_target_check;
alter table haccp_plan_links add column procedure_id uuid references procedures (id) on delete cascade;
alter table haccp_plan_links add check (num_nonnulls(supplier_id, training_id, procedure_id) = 1);
create unique index uq_haccp_plan_links_procedure on haccp_plan_links (plan_id, procedure_id) where procedure_id is not null;

alter table user_notification_preferences add column email_procedure_review boolean not null default true;

-- 3. Réintroduction du type de ressource 'procedure' dans les checks transverses.
alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'procedure', 'accident', 'pdca', 'nonconforming_output',
    'customer_satisfaction', 'employee'
  )
);

alter table record_shares drop constraint if exists record_shares_resource_type_check;
alter table record_shares add constraint record_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

alter table guest_shares drop constraint if exists guest_shares_resource_type_check;
alter table guest_shares add constraint guest_shares_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

alter table guest_share_items drop constraint if exists guest_share_items_resource_type_check;
alter table guest_share_items add constraint guest_share_items_resource_type_check
  check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  ));

-- 4. Fonctions et triggers.
create or replace function procedure_versions_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector(
    'french',
    coalesce(new.content->>'objet', '') || ' ' ||
    coalesce(new.content->>'domaine_application', '') || ' ' ||
    coalesce(new.content->>'responsabilites', '') || ' ' ||
    coalesce(
      (select string_agg(section->>'content', ' ') from jsonb_array_elements(coalesce(new.content->'sections', '[]'::jsonb)) as section),
      ''
    )
  );
  return new;
end;
$$;

create trigger trg_procedure_versions_search_vector before insert or update on procedure_versions
  for each row execute function procedure_versions_search_vector_update();

create or replace function search_procedure_ids(p_tenant_id uuid, p_query text)
returns table (id uuid)
language sql
stable
as $$
  select p.id
  from procedures p
  left join procedure_versions pv on pv.id = p.current_version_id
  where p.tenant_id = p_tenant_id
    and (
      p.number ilike '%' || p_query || '%'
      or p.title ilike '%' || p_query || '%'
      or (pv.search_vector is not null and pv.search_vector @@ websearch_to_tsquery('french', p_query))
    );
$$;

create trigger trg_procedures_updated_at before update on procedures
  for each row execute function set_updated_at();
create trigger trg_procedure_versions_updated_at before update on procedure_versions
  for each row execute function set_updated_at();
create trigger trg_procedure_templates_updated_at before update on procedure_templates
  for each row execute function set_updated_at();
create trigger trg_procedure_generation_jobs_updated_at before update on procedure_generation_jobs
  for each row execute function set_updated_at();

-- 5. Index.
create index idx_procedures_tenant_id on procedures (tenant_id);
create unique index idx_procedures_source_document_id
  on procedures (tenant_id, source_document_id)
  where source_document_id is not null;
create index idx_procedure_versions_tenant_id on procedure_versions (tenant_id);
create index idx_procedure_versions_procedure_id on procedure_versions (procedure_id);
create index idx_procedure_versions_search_vector on procedure_versions using gin (search_vector);
create index idx_procedure_templates_tenant_id on procedure_templates (tenant_id);
create index idx_procedure_generation_jobs_tenant_id on procedure_generation_jobs (tenant_id);
create index idx_procedure_generation_jobs_tenant_created_at on procedure_generation_jobs (tenant_id, created_at);
create index idx_procedure_acknowledgments_tenant_id on procedure_acknowledgments (tenant_id);
create index idx_procedure_acknowledgments_procedure_version_id on procedure_acknowledgments (procedure_version_id);
create index idx_procedure_capa_links_tenant_id on procedure_capa_links (tenant_id);
create index idx_procedure_capa_links_procedure_id on procedure_capa_links (procedure_id);
create index idx_procedure_capa_links_capa_id on procedure_capa_links (capa_id);
create index idx_procedure_audit_links_tenant_id on procedure_audit_links (tenant_id);
create index idx_procedure_audit_links_procedure_id on procedure_audit_links (procedure_id);
create index idx_procedure_audit_links_audit_id on procedure_audit_links (audit_id);

-- 6. RLS : isolation par tenant + guards d'écriture des partages (migration 56).
alter table procedures enable row level security;
alter table procedure_versions enable row level security;
alter table procedure_templates enable row level security;
alter table procedure_generation_jobs enable row level security;
alter table procedure_acknowledgments enable row level security;
alter table procedure_capa_links enable row level security;
alter table procedure_audit_links enable row level security;

create policy procedures_isolation on procedures
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_versions_isolation on procedure_versions
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_templates_isolation on procedure_templates
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_generation_jobs_isolation on procedure_generation_jobs
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_acknowledgments_isolation on procedure_acknowledgments
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_capa_links_isolation on procedure_capa_links
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());
create policy procedure_audit_links_isolation on procedure_audit_links
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());

do $$
declare
  target regclass;
begin
  for target in
    select unnest(array[
      'procedures', 'procedure_versions', 'procedure_templates', 'procedure_generation_jobs',
      'procedure_acknowledgments', 'procedure_capa_links', 'procedure_audit_links'
    ]::regclass[])
  loop
    execute format('create policy share_api_insert_only on %s as restrictive for insert to anon, authenticated with check (false)', target);
    execute format('create policy share_api_update_only on %s as restrictive for update to anon, authenticated using (false) with check (false)', target);
    execute format('create policy share_api_delete_only on %s as restrictive for delete to anon, authenticated using (false)', target);
  end loop;
end $$;

commit;
