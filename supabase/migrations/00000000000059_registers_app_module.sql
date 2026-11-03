-- Les registres documentaires deviennent un module métier séparé de 'documents'
-- (clé 'registers', voir services/appModules.js et routes/registers.js) : les CHECK
-- de tenants.app_modules et ai_plans.app_modules (posés par add-tenant-app-modules.sql)
-- doivent accepter la nouvelle clé, sinon tout enregistrement d'une configuration
-- complète (PATCH app-modules, forfaits) est rejeté par la base.
-- 'procedures' reste dans la liste : des configurations existantes peuvent encore
-- contenir cette clé historique (module supprimé par la migration 58).

begin;

alter table public.tenants drop constraint if exists tenants_app_modules_check;
alter table public.tenants add constraint tenants_app_modules_check
  check (
    jsonb_typeof(app_modules) = 'object'
    and app_modules - array[
      'dashboard','planning','documents','registers','capas','complaints','trainings','kpis','qqoqccp',
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
      'dashboard','planning','documents','registers','capas','complaints','trainings','kpis','qqoqccp',
      'audits','risks','haccp','suppliers','management-reviews','procedures','accidents',
      'pdca','nonconforming-outputs','customer-satisfaction','my-approvals','services','employees'
    ]::text[] = '{}'::jsonb
    and not jsonb_path_exists(app_modules, '$.* ? (@.type() != "boolean")')
  );

commit;
