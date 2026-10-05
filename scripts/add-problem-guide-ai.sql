-- Run after add-ai-commercial-settings.sql. No business data is changed.
begin;

alter table public.tenants drop constraint if exists tenants_ai_modules_check;
alter table public.tenants add constraint tenants_ai_modules_check check (
  jsonb_typeof(ai_modules) = 'object'
  and ai_modules - array['capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis','problem_guide']::text[] = '{}'::jsonb
  and not jsonb_path_exists(ai_modules, '$.* ? (@.type() != "boolean")')
);
alter table public.ai_plans drop constraint if exists ai_plans_modules_check;
alter table public.ai_plans add constraint ai_plans_modules_check check (
  jsonb_typeof(modules) = 'object'
  and modules - array['capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis','problem_guide']::text[] = '{}'::jsonb
  and not jsonb_path_exists(modules, '$.* ? (@.type() != "boolean")')
);
alter table public.ai_quota_actions drop constraint if exists ai_quota_actions_module_check;
alter table public.ai_quota_actions add constraint ai_quota_actions_module_check check (
  module in ('capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis','problem_guide')
);

create or replace function public.reserve_ai_module_action(p_tenant_id uuid, p_user_id uuid, p_module text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_modules jsonb; v_result jsonb;
begin
  if p_module is null or p_module not in ('capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis','problem_guide') then
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
revoke all on function public.reserve_ai_module_action(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_ai_module_action(uuid, uuid, text) to service_role;
notify pgrst, 'reload schema';
commit;
