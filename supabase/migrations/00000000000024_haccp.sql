-- HACCP (Hazard Analysis Critical Control Point — sécurité alimentaire). Un plan par
-- produit/procédé, décliné en étapes ordonnées du diagramme de fabrication
-- (haccp_process_steps), chacune porteuse de dangers identifiés (haccp_hazards), dont ceux
-- jugés significatifs donnent lieu à un point critique (haccp_ccps), lui-même surveillé au
-- fil de l'eau (haccp_monitoring_logs). Même relation en cascade parent/enfant que
-- audits -> audit_findings, répétée sur 4 niveaux au lieu d'un seul.
create table haccp_plans (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  title              text not null,
  product_description text,
  scope              text,
  team               text,
  service_id         uuid references services (id) on delete set null,
  status             text not null default 'draft' check (status in ('draft', 'active', 'under_review', 'archived')),
  created_by         uuid references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table haccp_process_steps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  plan_id     uuid not null references haccp_plans (id) on delete cascade,
  step_number integer not null,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (plan_id, step_number)
);

-- likelihood/severity et risk_score generated : même principe que risks.risk_score (jamais
-- désynchronisé d'une mise à jour partielle). is_significant + justification tiennent lieu,
-- pour l'instant, de l'arbre de décision Codex Alimentarius complet (les 4 questions
-- classiques) — une évaluation manuelle documentée plutôt qu'un assistant guidé, en V1.
create table haccp_hazards (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  step_id           uuid not null references haccp_process_steps (id) on delete cascade,
  hazard_type       text not null check (hazard_type in ('biological', 'chemical', 'physical', 'allergen')),
  description       text not null,
  existing_controls text,
  likelihood        integer not null check (likelihood between 1 and 5),
  severity          integer not null check (severity between 1 and 5),
  risk_score        integer generated always as (likelihood * severity) stored,
  is_significant    boolean not null default false,
  justification     text,
  -- Traçabilité : ce danger vient-il d'une suggestion IA acceptée telle quelle (ou modifiée)
  -- plutôt que d'une saisie manuelle.
  ai_generated      boolean not null default false,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table haccp_ccps (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references tenants (id) on delete cascade,
  hazard_id                   uuid not null references haccp_hazards (id) on delete cascade,
  ccp_number                  text,
  critical_limits             text not null,
  monitoring_procedure        text not null,
  monitoring_frequency        text,
  monitoring_responsible      uuid references users (id) on delete set null,
  corrective_action_procedure text,
  verification_procedure      text,
  verification_frequency      text,
  record_keeping_procedure    text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Relevés de surveillance réels contre un CCP. linked_capa_id : même principe miroir que
-- risks.linked_capa_id — une dérive (within_limits = false) peut donner lieu à une CAPA sans
-- que ce soit systématique.
create table haccp_monitoring_logs (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  ccp_id                 uuid not null references haccp_ccps (id) on delete cascade,
  recorded_value         text not null,
  within_limits          boolean not null,
  corrective_action_taken text,
  linked_capa_id         uuid references capas (id) on delete set null,
  recorded_by            uuid references users (id) on delete set null,
  recorded_at            timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

-- Relevé de surveillance à l'origine de cette CAPA (voir aussi
-- haccp_monitoring_logs.linked_capa_id, l'inverse) — même principe miroir que
-- risks.linked_capa_id / capas.risk_id.
alter table capas add column haccp_monitoring_log_id uuid references haccp_monitoring_logs (id) on delete set null;

alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan'
  )
);

alter table haccp_plans add column category_id uuid references categories (id) on delete set null;

create index idx_haccp_plans_tenant_id on haccp_plans (tenant_id);
create index idx_haccp_plans_status on haccp_plans (status);
create index idx_haccp_plans_service_id on haccp_plans (service_id);

create index idx_haccp_process_steps_tenant_id on haccp_process_steps (tenant_id);
create index idx_haccp_process_steps_plan_id on haccp_process_steps (plan_id);

create index idx_haccp_hazards_tenant_id on haccp_hazards (tenant_id);
create index idx_haccp_hazards_step_id on haccp_hazards (step_id);

create index idx_haccp_ccps_tenant_id on haccp_ccps (tenant_id);
create index idx_haccp_ccps_hazard_id on haccp_ccps (hazard_id);

create index idx_haccp_monitoring_logs_tenant_id on haccp_monitoring_logs (tenant_id);
create index idx_haccp_monitoring_logs_ccp_id on haccp_monitoring_logs (ccp_id);
create index idx_haccp_monitoring_logs_recorded_at on haccp_monitoring_logs (recorded_at);

create trigger trg_haccp_plans_updated_at before update on haccp_plans
  for each row execute function set_updated_at();

create trigger trg_haccp_process_steps_updated_at before update on haccp_process_steps
  for each row execute function set_updated_at();

create trigger trg_haccp_hazards_updated_at before update on haccp_hazards
  for each row execute function set_updated_at();

create trigger trg_haccp_ccps_updated_at before update on haccp_ccps
  for each row execute function set_updated_at();

alter table haccp_plans enable row level security;
alter table haccp_process_steps enable row level security;
alter table haccp_hazards enable row level security;
alter table haccp_ccps enable row level security;
alter table haccp_monitoring_logs enable row level security;

create policy haccp_plans_isolation on haccp_plans
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_process_steps_isolation on haccp_process_steps
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_hazards_isolation on haccp_hazards
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_ccps_isolation on haccp_ccps
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_monitoring_logs_isolation on haccp_monitoring_logs
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
