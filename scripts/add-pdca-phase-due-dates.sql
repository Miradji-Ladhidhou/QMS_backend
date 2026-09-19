-- Ajoute une échéance par phase (plan/do/check/act) à pdca_projects — jusqu'ici seule
-- target_date (une échéance globale unique) existait, et *_completed_at ne enregistre qu'une
-- date de fin déjà passée, jamais une date à venir à planifier. Permet au planning
-- (services/planningItems.js#fetchPdcaItems) d'afficher l'échéance de la phase EN COURS,
-- en plus de l'échéance globale du projet.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table pdca_projects
  add column if not exists plan_due_date  date,
  add column if not exists do_due_date    date,
  add column if not exists check_due_date date,
  add column if not exists act_due_date   date;

commit;
