-- Signatures du QCM de formation :
--  - training_instructor_signatures : image de la signature du formateur, enregistrée une fois par
--    formation (« Modifier la formation »). Table à part plutôt qu'une colonne de trainings : la liste
--    des formations (lue par tous les membres) ne doit ni embarquer ni exposer cette image.
--  - training_quiz_attempts.employee_signature : signature dessinée par le salarié en fin de QCM.
--  - training_quiz_attempts.instructor_signature : copie de la signature du formateur figée au moment
--    d'une réussite (jamais réécrite ensuite si le formateur change sa signature).
--  - training_quiz_attempts.training_info : objet/contenu et formateur tels qu'ils étaient à l'envoi
--    (pièce d'audit, comme quiz_snapshot pour les questions).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

create table if not exists training_instructor_signatures (
  training_id uuid primary key references trainings (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  image       text not null,
  updated_by  uuid references users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

create index if not exists idx_training_instructor_signatures_tenant_id on training_instructor_signatures (tenant_id);

alter table training_quiz_attempts
  add column if not exists employee_signature   text,
  add column if not exists instructor_signature text,
  add column if not exists training_info        jsonb;

alter table training_instructor_signatures enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'training_instructor_signatures' and policyname = 'training_instructor_signatures_isolation') then
    create policy training_instructor_signatures_isolation on training_instructor_signatures
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;
