-- Résumé de formation + QCM réutilisable + passages de QCM par lien email (valable 48 h).
--  - trainings.summary : texte de résumé lu par la personne avant le QCM.
--  - training_quizzes : un QCM par formation (questions/réponses en jsonb, seuil de réussite en %),
--    modifiable et réutilisable pour toutes les sessions.
--  - training_quiz_attempts : un passage = un lien envoyé à une personne pour une réalisation.
--    quiz_snapshot fige le QCM tel qu'il était à l'envoi (modifier le QCM ensuite ne réécrit
--    jamais un passage déjà fait — pièce d'audit). Seul le hash du jeton est stocké.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table trainings add column if not exists summary text;

create table if not exists training_quizzes (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  training_id    uuid not null unique references trainings (id) on delete cascade,
  pass_threshold integer not null default 80 check (pass_threshold between 1 and 100),
  questions      jsonb not null default '[]'::jsonb,
  updated_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists training_quiz_attempts (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  training_id           uuid not null references trainings (id) on delete cascade,
  record_id             uuid not null references training_records (id) on delete cascade,
  token_hash            text not null unique,
  email                 text not null,
  person_name           text,
  quiz_snapshot         jsonb not null,
  pass_threshold        integer not null,
  sent_by               uuid references users (id) on delete set null,
  sent_at               timestamptz not null default now(),
  expires_at            timestamptz not null,
  failed_email_attempts integer not null default 0,
  completed_at          timestamptz,
  answers               jsonb,
  correct_count         integer,
  total_count           integer,
  score_percent         numeric(5, 2),
  passed                boolean
);

create index if not exists idx_training_quizzes_tenant_id on training_quizzes (tenant_id);
create index if not exists idx_training_quiz_attempts_tenant_id on training_quiz_attempts (tenant_id);
create index if not exists idx_training_quiz_attempts_training_id on training_quiz_attempts (training_id);
create index if not exists idx_training_quiz_attempts_record_id on training_quiz_attempts (record_id);

alter table training_quizzes enable row level security;
alter table training_quiz_attempts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'training_quizzes' and policyname = 'training_quizzes_isolation') then
    create policy training_quizzes_isolation on training_quizzes
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'training_quiz_attempts' and policyname = 'training_quiz_attempts_isolation') then
    create policy training_quiz_attempts_isolation on training_quiz_attempts
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;
