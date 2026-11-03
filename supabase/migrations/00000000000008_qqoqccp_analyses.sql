-- Applique en local, de façon incrémentale, le même changement que schema.sql (backend/) :
-- table de base pour l'analyse QQOQCCP assistée par IA, isolée par tenant_id selon le même
-- modèle RLS que capas. Pas de colonne de liaison vers capas dans cette migration (prévu
-- séparément).

create table if not exists qqoqccp_analyses (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  title                  text not null,
  qui                    text,
  quoi                   text,
  ou_                    text,
  quand_                 text,
  comment_               text,
  combien                text,
  pourquoi               text,
  ai_synthesis           text,
  ai_suggested_actions   jsonb,
  status                 text not null default 'draft' check (status in ('draft', 'ai_generated', 'validated')),
  created_by             uuid references users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists idx_qqoqccp_analyses_tenant_id on qqoqccp_analyses (tenant_id);

alter table qqoqccp_analyses enable row level security;

drop policy if exists qqoqccp_analyses_isolation on qqoqccp_analyses;
create policy qqoqccp_analyses_isolation on qqoqccp_analyses
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
