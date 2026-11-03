create table management_reviews (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants (id) on delete cascade,
  title                    text not null,
  review_date              date not null,
  status                   text not null default 'draft' check (status in ('draft', 'completed')),
  participants             text,
  previous_actions_status  text,
  context_changes          text,
  resource_adequacy        text,
  improvement_opportunities text,
  conclusions              text,
  snapshot                 jsonb,
  created_by               uuid references users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table management_review_actions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  review_id      uuid not null references management_reviews (id) on delete cascade,
  description    text not null,
  linked_capa_id uuid references capas (id) on delete set null,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table capas add column management_review_action_id uuid references management_review_actions (id) on delete set null;

create index idx_management_reviews_tenant_id on management_reviews (tenant_id);
create index idx_management_reviews_review_date on management_reviews (review_date);

create index idx_management_review_actions_tenant_id on management_review_actions (tenant_id);
create index idx_management_review_actions_review_id on management_review_actions (review_id);

create trigger trg_management_reviews_updated_at before update on management_reviews
  for each row execute function set_updated_at();

create trigger trg_management_review_actions_updated_at before update on management_review_actions
  for each row execute function set_updated_at();

alter table management_reviews enable row level security;
alter table management_review_actions enable row level security;

create policy management_reviews_isolation on management_reviews
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy management_review_actions_isolation on management_review_actions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
