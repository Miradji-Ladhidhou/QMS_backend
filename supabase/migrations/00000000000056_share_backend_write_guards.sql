begin;

-- Business mutations must pass through the API's record, workflow and sharing checks.
do $$
declare
  target regclass;
begin
  for target in
    with recursive protected(oid) as (
      select oid from pg_class
      where relnamespace = 'public'::regnamespace and relname in (
        'documents', 'capas', 'complaints', 'qqoqccp_analyses', 'procedures',
        'accidents', 'pdca_projects', 'audits', 'management_reviews', 'risks',
        'haccp_plans', 'suppliers', 'nonconforming_outputs',
        'customer_satisfaction_surveys', 'employees', 'trainings', 'kpis',
        'tasks', 'services', 'quality_policy_versions', 'record_shares',
        'guest_shares'
      )
      union
      select fk.conrelid from pg_constraint fk join protected p on fk.confrelid = p.oid
      where fk.contype = 'f' and fk.connamespace = 'public'::regnamespace
    )
    select oid::regclass from protected
  loop
    execute format('alter table %s enable row level security', target);
    execute format('create policy share_api_insert_only on %s as restrictive for insert to anon, authenticated with check (false)', target);
    execute format('create policy share_api_update_only on %s as restrictive for update to anon, authenticated using (false) with check (false)', target);
    execute format('create policy share_api_delete_only on %s as restrictive for delete to anon, authenticated using (false)', target);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
