-- Apply after add-ai-quotas.sql and before deploying the backend and frontend.
-- Deployment equivalent of supabase/migrations/00000000000048_ai_generations.sql.
-- Saved results are private to tenant + author and accessible only through the API.
-- Reads and manual edits do not call AI; explicit regeneration preserves versions.
begin;

create table if not exists public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  module text not null,
  endpoint text not null,
  scope_key text not null,
  request_id uuid not null,
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'deleted')),
  input jsonb not null default '{}'::jsonb,
  result jsonb,
  origin text not null default 'ai' check (origin in ('ai', 'manual')),
  previous_id uuid references public.ai_generations(id) on delete set null,
  quota_action_id uuid,
  job_id uuid references public.procedure_generation_jobs(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, request_id),
  check (status <> 'completed' or result is not null)
);
alter table public.ai_generations add column if not exists input jsonb not null default '{}'::jsonb;
alter table public.ai_generations add column if not exists job_id uuid
  references public.procedure_generation_jobs(id) on delete set null;
create unique index if not exists ai_generations_running on public.ai_generations(tenant_id, user_id, scope_key)
  where status = 'running';
create index if not exists ai_generations_latest on public.ai_generations(tenant_id, user_id, scope_key, created_at desc);
create unique index if not exists ai_generations_manual_revision on public.ai_generations(previous_id) where origin = 'manual';
alter table public.ai_generations enable row level security;
revoke all on public.ai_generations from anon, authenticated;
grant select, insert, update, delete on public.ai_generations to service_role;

do $$
begin
  if to_regclass('public.ai_quota_actions') is not null
    and not exists (
      select 1 from pg_constraint
      where conrelid = 'public.ai_generations'::regclass
        and conname = 'ai_generations_quota_action_fkey'
    ) then
    alter table public.ai_generations add constraint ai_generations_quota_action_fkey
      foreign key (quota_action_id) references public.ai_quota_actions(id) on delete set null;
  end if;
end $$;

commit;
