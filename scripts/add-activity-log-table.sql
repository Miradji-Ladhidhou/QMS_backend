-- Ajoute activity_log : journal d'activité plateforme complet (connexions/déconnexions,
-- échecs de connexion, mot de passe, CRUD sur tous les modules métier, transitions de
-- workflow, exports) — réservé au super admin. Voir services/activityLog.js et
-- GET /api/super-admin/activity-log. Coexiste avec document_audit_log (exigence ISO/FDA,
-- scopé aux documents) et super_admin_audit_log (actions DU super admin, conservé tel quel) :
-- ne remplace ni l'un ni l'autre.
--
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Idempotent : chaque étape vérifie si elle a déjà été appliquée.

begin;

create table if not exists activity_log (
  id          uuid primary key default gen_random_uuid(),
  -- Pas de FK sur tenant_id/actor_id (même raisonnement que super_admin_audit_log/job_runs/
  -- ai_call_failures) : une ligne journalisée ici ne doit jamais bloquer la suppression d'un
  -- tenant ou d'un utilisateur.
  tenant_id   uuid,
  actor_id    uuid,
  -- Capturé indépendamment de actor_id : reste lisible même si le compte est supprimé
  -- ensuite, et c'est la seule identité disponible pour login_failed (email inconnu du
  -- système, donc jamais de actor_id résolu).
  actor_email text,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  metadata    jsonb,
  ip_address  text,
  user_agent  text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_activity_log_created_at on activity_log (created_at desc);
create index if not exists idx_activity_log_tenant_id on activity_log (tenant_id, created_at desc);
create index if not exists idx_activity_log_actor_id on activity_log (actor_id, created_at desc);
create index if not exists idx_activity_log_entity on activity_log (entity_type, entity_id);
create index if not exists idx_activity_log_action on activity_log (action);

alter table activity_log enable row level security;

-- Immuable, même garantie que document_audit_log/super_admin_audit_log : une piste d'audit
-- ne se corrige jamais après coup, elle se complète.
create or replace function activity_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'activity_log est immuable : aucune modification ni suppression autorisée.';
end;
$$;

drop trigger if exists trg_activity_log_immutable on activity_log;
create trigger trg_activity_log_immutable
  before update or delete on activity_log
  for each row execute function activity_log_immutable();

-- Seul le backend (clé service_role, qui contourne RLS) écrit dans cette table.
drop policy if exists activity_log_select on activity_log;
create policy activity_log_select on activity_log
  for select
  using (auth_is_super_admin());

-- Résout tenant_id/user_id à partir d'un email AVANT toute session (login_failed,
-- password_reset_requested) — public.users n'a pas de colonne email, elle vit dans
-- auth.users (schéma Supabase Auth). security definer + search_path épinglé, EXECUTE retiré
-- à anon/authenticated : cette fonction ne doit jamais devenir un oracle d'énumération
-- d'emails, réservée au backend (service_role).
create or replace function lookup_user_by_email(p_email text)
returns table(user_id uuid, tenant_id uuid)
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id, u.tenant_id
  from public.users u
  join auth.users au on au.id = u.id
  where au.email = lower(p_email)
  limit 1;
$$;

revoke all on function lookup_user_by_email(text) from public;
revoke execute on function lookup_user_by_email(text) from anon, authenticated;
grant execute on function lookup_user_by_email(text) to service_role;

commit;
