-- Annule 00000000000059_registers_app_module.sql : retire 'registers' de la liste blanche.
-- Attention : échoue si des configurations contiennent déjà la clé 'registers' — les purger
-- d'abord (update ... set app_modules = app_modules - 'registers').

begin;

update public.tenants set app_modules = app_modules - 'registers'
  where app_modules ? 'registers';
update public.ai_plans set app_modules = app_modules - 'registers'
  where app_modules ? 'registers';

alter table public.tenants drop constraint if exists tenants_app_modules_check;
alter table public.tenants add constraint tenants_app_modules_check
  check (
    jsonb_typeof(app_modules) = 'object'
    and app_modules - array[
      'dashboard','planning','documents','capas','complaints','trainings','kpis','qqoqccp',
      'audits','risks','haccp','suppliers','management-reviews','procedures','accidents',
      'pdca','nonconforming-outputs','customer-satisfaction','my-approvals','services','employees'
    ]::text[] = '{}'::jsonb
    and not jsonb_path_exists(app_modules, '$.* ? (@.type() != "boolean")')
  );

alter table public.ai_plans drop constraint if exists ai_plans_app_modules_check;
alter table public.ai_plans add constraint ai_plans_app_modules_check
  check (
    jsonb_typeof(app_modules) = 'object'
    and app_modules - array[
      'dashboard','planning','documents','capas','complaints','trainings','kpis','qqoqccp',
      'audits','risks','haccp','suppliers','management-reviews','procedures','accidents',
      'pdca','nonconforming-outputs','customer-satisfaction','my-approvals','services','employees'
    ]::text[] = '{}'::jsonb
    and not jsonb_path_exists(app_modules, '$.* ? (@.type() != "boolean")')
  );

commit;
