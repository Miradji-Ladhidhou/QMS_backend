-- Ajoute job_runs : historique des exécutions des tâches planifiées (notificationJob, backupJob,
-- driveTokenRefreshJob, dashboardSnapshotJob, moduleKpiJob) — jusqu'ici leurs échecs ne
-- partaient qu'en console.error, invisibles nulle part dans l'app (Super Admin devait éplucher
-- les logs bruts de l'hébergeur pour savoir si une tâche avait échoué). Voir SystemTab côté
-- frontend et services/jobRunTracker.js côté backend.
--
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Idempotent : chaque étape vérifie si elle a déjà été appliquée.

begin;

create table if not exists job_runs (
  id          uuid primary key default gen_random_uuid(),
  job_name    text not null,
  started_at  timestamptz not null,
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  summary     text,
  error       text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_job_runs_job_name_started_at on job_runs (job_name, started_at desc);

alter table job_runs enable row level security;

-- Pas de tenant_id (table plateforme, traverse volontairement les tenants) : même raisonnement
-- que super_admin_audit_log. Seul le backend (clé service_role, qui contourne RLS) écrit dans
-- cette table — aucune policy insert/update pour les rôles authentifiés normaux.
drop policy if exists job_runs_select on job_runs;
create policy job_runs_select on job_runs
  for select
  using (auth_is_super_admin());

commit;
