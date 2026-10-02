-- Classification accident/presqu'accident et détails utiles à la déclaration initiale.
begin;

alter table accidents
  add column if not exists incident_type text not null default 'accident',
  add column if not exists occurred_time time,
  add column if not exists injury_type text,
  add column if not exists injury_location text,
  add column if not exists witness_name text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'accidents_incident_type_check'
      and conrelid = 'accidents'::regclass
  ) then
    alter table accidents add constraint accidents_incident_type_check
      check (incident_type in ('accident', 'near_miss'));
  end if;
end $$;

notify pgrst, 'reload schema';
commit;