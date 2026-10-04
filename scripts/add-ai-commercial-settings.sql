-- Run after add-ai-quotas.sql, add-groq-limits.sql and add-tenant-ai-modules.sql.
begin;

create table if not exists public.ai_plans (
  key text primary key check (key in ('essential', 'pro', 'premium')),
  name text not null,
  configured boolean not null default false,
  monthly_limit integer check (monthly_limit between 0 and 1000000),
  default_user_limit integer check (default_user_limit between 0 and 1000000),
  modules jsonb not null default '{}'::jsonb check (
    jsonb_typeof(modules) = 'object'
    and modules - array['capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis']::text[] = '{}'::jsonb
    and not jsonb_path_exists(modules, '$.* ? (@.type() != "boolean")')
  ),
  updated_at timestamptz not null default now()
);
alter table public.ai_plans enable row level security;
revoke all on public.ai_plans from anon, authenticated;
grant select, insert, update, delete on public.ai_plans to service_role;
insert into public.ai_plans(key, name) values
  ('essential', 'Essentiel'), ('pro', 'Pro'), ('premium', 'Premium')
  on conflict (key) do nothing;

alter table public.tenants add column if not exists ai_plan_key text references public.ai_plans(key);
alter table public.tenants add column if not exists ai_default_user_limit integer check (ai_default_user_limit between 0 and 1000000);
alter table public.ai_quota_actions add column if not exists module text
  check (module in ('capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis'));
alter table public.groq_quota_calls add column if not exists action_id uuid
  references public.ai_quota_actions(id) on delete set null;
create index if not exists groq_quota_calls_action on public.groq_quota_calls(action_id) where action_id is not null;

create or replace function public.protect_ai_commercial_settings()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if (tg_op = 'INSERT' and (new.ai_plan_key is not null or new.ai_default_user_limit is not null))
      or (tg_op = 'UPDATE' and (new.ai_plan_key is distinct from old.ai_plan_key
        or new.ai_default_user_limit is distinct from old.ai_default_user_limit)) then
      raise exception 'AI commercial settings can only be changed by the backend' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists protect_ai_commercial_settings on public.tenants;
create trigger protect_ai_commercial_settings before insert or update on public.tenants
  for each row execute function public.protect_ai_commercial_settings();

create or replace function public.apply_ai_default_user_limit()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') and new.ai_monthly_limit is null then
    select ai_default_user_limit into new.ai_monthly_limit from tenants where id = new.tenant_id;
  end if;
  return new;
end $$;
drop trigger if exists apply_ai_default_user_limit on public.users;
create trigger apply_ai_default_user_limit before insert on public.users
  for each row execute function public.apply_ai_default_user_limit();

create or replace function public.apply_ai_plan(p_tenant_id uuid, p_plan_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan ai_plans%rowtype; v_tenant tenants%rowtype;
begin
  select * into v_plan from ai_plans where key = p_plan_key for share;
  if not found or not v_plan.configured then raise exception 'AI plan not configured'; end if;
  select * into v_tenant from tenants where id = p_tenant_id for update;
  if not found then raise exception 'Tenant not found'; end if;
  update tenants set ai_plan_key = v_plan.key, ai_modules = v_plan.modules,
    ai_monthly_limit = v_plan.monthly_limit, ai_default_user_limit = v_plan.default_user_limit
    where id = p_tenant_id;
  return jsonb_build_object('ai_plan_key', v_plan.key, 'ai_modules', v_plan.modules,
    'ai_monthly_limit', v_plan.monthly_limit, 'ai_default_user_limit', v_plan.default_user_limit);
end $$;

create or replace function public.reserve_ai_module_action(p_tenant_id uuid, p_user_id uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_modules jsonb; v_result jsonb;
begin
  if p_module is null or p_module not in ('capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis') then
    raise exception 'Invalid AI module';
  end if;
  select ai_modules into v_modules from tenants where id = p_tenant_id for update;
  if not found then raise exception 'Tenant not found'; end if;
  if v_modules->p_module = 'false'::jsonb then
    return jsonb_build_object('allowed', false, 'scope', 'module');
  end if;
  v_result := reserve_ai_action(p_tenant_id, p_user_id);
  if (v_result->>'allowed')::boolean then
    update ai_quota_actions set module = p_module where id = (v_result->>'action_id')::uuid;
  end if;
  return v_result;
end $$;

create or replace function public.reserve_groq_action_call(p_model text, p_token_budget integer, p_action_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_action ai_quota_actions%rowtype;
begin
  select * into v_action from ai_quota_actions where id = p_action_id for share;
  if not found or v_action.status <> 'pending' or v_action.expires_at <= now() then
    raise exception 'AI action reservation not active';
  end if;
  v_result := reserve_groq_call(p_model, p_token_budget);
  if (v_result->>'allowed')::boolean then
    update groq_quota_calls set action_id = p_action_id where id = (v_result->>'call_id')::uuid;
  end if;
  return v_result;
end $$;

create or replace function public.ai_usage_breakdown(p_tenant_id uuid, p_month date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rows jsonb;
begin
  if p_month is null or p_month <> date_trunc('month', p_month)::date then raise exception 'Invalid month'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'Tenant not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(grouped) order by grouped.module, grouped.full_name), '[]'::jsonb)
    into v_rows from (
      select coalesce(a.module, 'untracked') as module, a.user_id,
        coalesce(u.full_name, 'Compte supprimé') as full_name,
        count(*) filter (where a.status = 'succeeded') as succeeded,
        count(*) filter (where a.status = 'failed') as failed,
        count(*) filter (where a.status = 'pending' and a.expires_at > now()) as pending,
        count(*) filter (where a.status = 'pending' and a.expires_at <= now()) as expired,
        coalesce(sum(c.calls), 0) as calls,
        coalesce(sum(c.actual_tokens), 0) as actual_tokens,
        coalesce(sum(c.estimated_tokens), 0) as estimated_tokens,
        coalesce(sum(c.pending_tokens), 0) as pending_tokens
      from ai_quota_actions a
      left join users u on u.id = a.user_id
      left join lateral (
        select count(*) as calls,
          coalesce(sum(tokens) filter (where finished_at is not null and tokens is not null), 0) as actual_tokens,
          coalesce(sum(token_budget) filter (where finished_at is not null and tokens is null), 0) as estimated_tokens,
          coalesce(sum(token_budget) filter (where finished_at is null), 0) as pending_tokens
        from groq_quota_calls where action_id = a.id
      ) c on true
      where a.tenant_id = p_tenant_id and a.month = p_month
      group by a.module, a.user_id, u.full_name
    ) grouped;
  return jsonb_build_object('month', p_month,
    'reset_at', (p_month + interval '1 month') at time zone 'UTC', 'rows', v_rows);
end $$;

create or replace function public.ai_tenant_quota_alerts()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(q) order by q.ratio desc, q.name), '[]'::jsonb)
  from (
    select t.id, t.name, t.ai_monthly_limit as "limit",
      count(a.id) filter (where a.status = 'succeeded') as used,
      count(a.id) filter (where a.status = 'pending' and a.expires_at > now()) as pending,
      case when t.ai_monthly_limit = 0 then 1::numeric
        else (count(a.id) filter (where a.status = 'succeeded' or (a.status = 'pending' and a.expires_at > now())))::numeric / t.ai_monthly_limit end as ratio
    from tenants t left join ai_quota_actions a on a.tenant_id = t.id
      and a.month = date_trunc('month', now() at time zone 'UTC')::date
    where t.ai_monthly_limit is not null
    group by t.id
  ) q where q.ratio >= 0.8;
$$;

revoke all on function public.apply_ai_plan(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_ai_module_action(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_groq_action_call(text, integer, uuid) from public, anon, authenticated;
revoke all on function public.ai_usage_breakdown(uuid, date) from public, anon, authenticated;
revoke all on function public.ai_tenant_quota_alerts() from public, anon, authenticated;
grant execute on function public.apply_ai_plan(uuid, text) to service_role;
grant execute on function public.reserve_ai_module_action(uuid, uuid, text) to service_role;
grant execute on function public.reserve_groq_action_call(text, integer, uuid) to service_role;
grant execute on function public.ai_usage_breakdown(uuid, date) to service_role;
grant execute on function public.ai_tenant_quota_alerts() to service_role;
notify pgrst, 'reload schema';
commit;
