  -- Apply before deploying the quota backend. All limits default to unlimited.
  begin;

  alter table public.tenants add column if not exists ai_monthly_limit integer check (ai_monthly_limit >= 0);
  alter table public.users add column if not exists ai_monthly_limit integer check (ai_monthly_limit >= 0);
  create or replace function public.protect_ai_quota_limit()
  returns trigger language plpgsql set search_path = public as $$
  begin
    if current_user not in ('postgres', 'service_role', 'supabase_admin') then
      if (tg_op = 'INSERT' and new.ai_monthly_limit is not null)
        or (tg_op = 'UPDATE' and new.ai_monthly_limit is distinct from old.ai_monthly_limit) then
        raise exception 'AI quota limits can only be changed by the backend' using errcode = '42501';
      end if;
    end if;
    return new;
  end $$;
  drop trigger if exists protect_tenant_ai_quota on public.tenants;
  create trigger protect_tenant_ai_quota before insert or update on public.tenants
    for each row execute function public.protect_ai_quota_limit();
  drop trigger if exists protect_user_ai_quota on public.users;
  create trigger protect_user_ai_quota before insert or update on public.users
    for each row execute function public.protect_ai_quota_limit();

  alter table public.ai_call_failures drop constraint if exists ai_call_failures_category_check;
  alter table public.ai_call_failures add constraint ai_call_failures_category_check
    check (category in ('rate_limit', 'auth', 'timeout', 'network', 'empty_response', 'malformed_response', 'unexpected', 'invalid_contract', 'generation_limit'));
  create table if not exists public.ai_quota_actions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.tenants(id) on delete cascade,
    user_id uuid references public.users(id) on delete set null,
    month date not null,
    status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '1 hour'
  );
  alter table public.ai_quota_actions alter column user_id drop not null;
  alter table public.ai_quota_actions drop constraint if exists ai_quota_actions_user_id_fkey;
  alter table public.ai_quota_actions add constraint ai_quota_actions_user_id_fkey
    foreign key (user_id) references public.users(id) on delete set null;
  create index if not exists ai_quota_actions_month on public.ai_quota_actions(tenant_id, month, user_id);
  alter table public.ai_quota_actions enable row level security;
  alter table public.procedure_generation_jobs add column if not exists ai_quota_action_id uuid references public.ai_quota_actions(id) on delete set null;

  create or replace function public.ai_quota_snapshot(p_tenant_id uuid, p_user_id uuid default null)
  returns jsonb language plpgsql security definer set search_path = public as $$
  declare
    v_month date := date_trunc('month', now() at time zone 'UTC')::date;
    v_tenant_limit integer;
    v_tenant_used integer;
    v_tenant_pending integer;
    v_users jsonb;
  begin
    select ai_monthly_limit into v_tenant_limit from tenants where id = p_tenant_id;
    if not found then raise exception 'Tenant not found'; end if;
    if p_user_id is not null and not exists (select 1 from users where id = p_user_id and tenant_id = p_tenant_id) then
      raise exception 'User does not belong to tenant';
    end if;
    select count(*) filter (where status = 'succeeded'),
      count(*) filter (where status = 'pending' and expires_at > now())
      into v_tenant_used, v_tenant_pending from ai_quota_actions
      where tenant_id = p_tenant_id and month = v_month;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', u.id, 'full_name', u.full_name, 'limit', u.ai_monthly_limit,
      'used', counts.used, 'pending', counts.pending,
      'remaining', case when u.ai_monthly_limit is null then null else greatest(0, u.ai_monthly_limit - counts.used - counts.pending) end
    ) order by u.full_name), '[]'::jsonb) into v_users
    from users u
    cross join lateral (
      select count(*) filter (where status = 'succeeded')::integer as used,
        count(*) filter (where status = 'pending' and expires_at > now())::integer as pending
      from ai_quota_actions where user_id = u.id and tenant_id = p_tenant_id and month = v_month
    ) counts
    where u.tenant_id = p_tenant_id and (p_user_id is null or u.id = p_user_id);
    return jsonb_build_object(
      'month', v_month,
      'reset_at', (v_month + interval '1 month') at time zone 'UTC',
      'tenant', jsonb_build_object('limit', v_tenant_limit, 'used', v_tenant_used, 'pending', v_tenant_pending,
        'remaining', case when v_tenant_limit is null then null else greatest(0, v_tenant_limit - v_tenant_used - v_tenant_pending) end),
      'user', case when p_user_id is null then null else v_users->0 end,
      'users', case when p_user_id is null then v_users else '[]'::jsonb end
    );
  end $$;

  create or replace function public.reserve_ai_action(p_tenant_id uuid, p_user_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
  declare
    v_snapshot jsonb;
    v_id uuid;
  begin
    -- Serialize all reservations for an enterprise, including requests on other servers.
    perform 1 from tenants where id = p_tenant_id for update;
    if not found then raise exception 'Tenant not found'; end if;
    perform 1 from users where id = p_user_id and tenant_id = p_tenant_id for update;
    if not found then raise exception 'User does not belong to tenant'; end if;
    v_snapshot := ai_quota_snapshot(p_tenant_id, p_user_id);
    if (v_snapshot->'tenant'->>'remaining')::integer = 0 then
      return jsonb_build_object('allowed', false, 'scope', 'tenant', 'quota', v_snapshot);
    end if;
    if (v_snapshot->'user'->>'remaining')::integer = 0 then
      return jsonb_build_object('allowed', false, 'scope', 'user', 'quota', v_snapshot);
    end if;
    insert into ai_quota_actions(tenant_id, user_id, month)
      values (p_tenant_id, p_user_id, date_trunc('month', now() at time zone 'UTC')::date)
      returning id into v_id;
    return jsonb_build_object('allowed', true, 'action_id', v_id);
  end $$;

  create or replace function public.settle_ai_action(p_action_id uuid, p_success boolean)
  returns void language plpgsql security definer set search_path = public as $$
  declare v_action ai_quota_actions%rowtype;
  begin
    select * into v_action from ai_quota_actions where id = p_action_id for update;
    if not found then raise exception 'Action not found'; end if;
    if v_action.status <> 'pending' then return; end if;
    if p_success and v_action.expires_at <= now() then raise exception 'Action reservation expired'; end if;
    update ai_quota_actions set status = case when p_success then 'succeeded' else 'failed' end where id = p_action_id;
  end $$;

  revoke all on function public.ai_quota_snapshot(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.reserve_ai_action(uuid, uuid) from public, anon, authenticated;
  revoke all on function public.settle_ai_action(uuid, boolean) from public, anon, authenticated;
  grant execute on function public.ai_quota_snapshot(uuid, uuid) to service_role;
  grant execute on function public.reserve_ai_action(uuid, uuid) to service_role;
  grant execute on function public.settle_ai_action(uuid, boolean) to service_role;
  notify pgrst, 'reload schema';
  commit;
