-- Ajoute la notion de session de formation : un événement collectif (une date, un groupe de
-- personnes formées ensemble) qui regroupe des training_records — jusqu'ici seule
-- training_records.completed_at partagée entre plusieurs lignes distinguait implicitement
-- "cette réalisation faisait partie du même événement", sans aucune ligne pour le matérialiser
-- ni le nommer. session_id sur training_records est nullable : les réalisations déjà en base
-- restent "sans session" jusqu'à un déplacement explicite (voir PATCH /trainings/:id/records/:id).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

create table if not exists training_sessions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  training_id  uuid not null references trainings (id) on delete cascade,
  session_date date not null,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table training_records add column if not exists session_id uuid references training_sessions (id) on delete set null;

create index if not exists idx_training_sessions_tenant_id on training_sessions (tenant_id);
create index if not exists idx_training_sessions_training_id on training_sessions (training_id);
create index if not exists idx_training_records_session_id on training_records (session_id);

alter table training_sessions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'training_sessions' and policyname = 'training_sessions_isolation') then
    create policy training_sessions_isolation on training_sessions
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;
