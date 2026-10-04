-- Run after add-ai-commercial-settings.sql.
begin;

alter table public.tenants add column if not exists app_modules jsonb not null default '{}'::jsonb
  check (
    jsonb_typeof(app_modules) = 'object'
    and app_modules - array[
      'dashboard','planning','documents','capas','complaints','trainings','kpis','qqoqccp',
      'audits','risks','haccp','suppliers','management-reviews','procedures','accidents',
      'pdca','nonconforming-outputs','customer-satisfaction','my-approvals','services','employees'
    ]::text[] = '{}'::jsonb
    and not jsonb_path_exists(app_modules, '$.* ? (@.type() != "boolean")')
  );

alter table public.ai_plans add column if not exists app_modules jsonb not null default '{}'::jsonb
  check (
    jsonb_typeof(app_modules) = 'object'
    and app_modules - array[
      'dashboard','planning','documents','capas','complaints','trainings','kpis','qqoqccp',
      'audits','risks','haccp','suppliers','management-reviews','procedures','accidents',
      'pdca','nonconforming-outputs','customer-satisfaction','my-approvals','services','employees'
    ]::text[] = '{}'::jsonb
    and not jsonb_path_exists(app_modules, '$.* ? (@.type() != "boolean")')
  );

create or replace function public.protect_tenant_app_modules()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if (tg_op = 'INSERT' and new.app_modules <> '{}'::jsonb)
      or (tg_op = 'UPDATE' and new.app_modules is distinct from old.app_modules) then
      raise exception 'Application module settings can only be changed by the backend' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_tenant_app_modules on public.tenants;
create trigger protect_tenant_app_modules before insert or update on public.tenants
  for each row execute function public.protect_tenant_app_modules();

create or replace function public.apply_ai_plan(p_tenant_id uuid, p_plan_key text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_plan ai_plans%rowtype; v_tenant tenants%rowtype;
begin
  select * into v_plan from ai_plans where key = p_plan_key for share;
  if not found or not v_plan.configured then raise exception 'AI plan not configured'; end if;
  select * into v_tenant from tenants where id = p_tenant_id for update;
  if not found then raise exception 'Tenant not found'; end if;
  update tenants set ai_plan_key = v_plan.key, ai_modules = v_plan.modules,
    app_modules = v_plan.app_modules,
    ai_monthly_limit = v_plan.monthly_limit, ai_default_user_limit = v_plan.default_user_limit
    where id = p_tenant_id;
  return jsonb_build_object('ai_plan_key', v_plan.key, 'ai_modules', v_plan.modules,
    'app_modules', v_plan.app_modules,
    'ai_monthly_limit', v_plan.monthly_limit, 'ai_default_user_limit', v_plan.default_user_limit);
end $$;

revoke all on function public.apply_ai_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.apply_ai_plan(uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
