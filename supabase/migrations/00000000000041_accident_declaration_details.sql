alter table accidents
  add column if not exists incident_type text not null default 'accident',
  add column if not exists occurred_time time,
  add column if not exists injury_type text,
  add column if not exists injury_location text,
  add column if not exists witness_name text;

alter table accidents drop constraint if exists accidents_incident_type_check;
alter table accidents add constraint accidents_incident_type_check
  check (incident_type in ('accident', 'near_miss'));