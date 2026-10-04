begin;
alter table public.tenants add column if not exists ai_modules jsonb not null default '{}'::jsonb
  check (
    jsonb_typeof(ai_modules) = 'object'
    and ai_modules - array['capas','qqoqccp','pdca','risks','haccp','audits','management_reviews','procedures','kpis']::text[] = '{}'::jsonb
    and not jsonb_path_exists(ai_modules, '$.* ? (@.type() != "boolean")')
  );
create or replace function public.protect_tenant_ai_modules()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin') then
    if (tg_op = 'INSERT' and new.ai_modules <> '{}'::jsonb)
      or (tg_op = 'UPDATE' and new.ai_modules is distinct from old.ai_modules) then
      raise exception 'AI module settings can only be changed by the backend' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists protect_tenant_ai_modules on public.tenants;
create trigger protect_tenant_ai_modules before insert or update on public.tenants
  for each row execute function public.protect_tenant_ai_modules();
notify pgrst, 'reload schema';
commit;
