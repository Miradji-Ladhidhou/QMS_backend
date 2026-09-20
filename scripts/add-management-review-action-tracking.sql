-- Suivi des actions décidées en revue de direction (ISO 9001 §9.3.3) : jusqu'ici une action n'avait
-- qu'un texte et une CAPA éventuelle. Ajoute un responsable, une échéance (qui alimente le planning),
-- un statut de suivi et l'origine de l'action (saisie à la main ou proposée par l'IA puis validée).
-- Permet aussi de reprendre automatiquement, à la revue suivante, l'état des actions de la précédente
-- (§9.3.2 a).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table management_review_actions
  add column if not exists owner        uuid references users (id) on delete set null,
  add column if not exists due_date     date,
  add column if not exists status       text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  add column if not exists completed_at timestamptz,
  add column if not exists source       text not null default 'manual' check (source in ('manual', 'ai'));

create index if not exists idx_management_review_actions_owner on management_review_actions (owner);
create index if not exists idx_management_review_actions_due_date on management_review_actions (due_date);

commit;
