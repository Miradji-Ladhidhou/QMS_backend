-- Ni actor_id ni target_id n'ont de contrainte FK : même raisonnement que
-- document_audit_log (00000000000012) — une FK ON DELETE ici déclencherait une cascade
-- UPDATE/DELETE bloquée par le trigger immuable ci-dessous, empêchant la suppression de
-- tout tenant/utilisateur ayant déjà une action journalisée à son nom.
create table super_admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create index idx_super_admin_audit_log_created_at on super_admin_audit_log (created_at desc);
create index idx_super_admin_audit_log_target on super_admin_audit_log (target_type, target_id);

create or replace function auth_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_super_admin from public.users where id = auth.uid()), false);
$$;

create or replace function super_admin_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'super_admin_audit_log est immuable : aucune modification ni suppression autorisée.';
end;
$$;

create trigger trg_super_admin_audit_log_immutable
  before update or delete on super_admin_audit_log
  for each row execute function super_admin_audit_log_immutable();

alter table super_admin_audit_log enable row level security;

create policy super_admin_audit_log_select on super_admin_audit_log
  for select
  using (auth_is_super_admin());

create policy super_admin_audit_log_insert on super_admin_audit_log
  for insert
  with check (auth_is_super_admin());
