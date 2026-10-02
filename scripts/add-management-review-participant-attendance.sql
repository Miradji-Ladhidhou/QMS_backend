-- Présence des participants aux revues de direction.
-- À exécuter sur les bases existantes avant de déployer le backend correspondant.
-- Déjà appliqué sur la base locale de dev/tests.
--
-- Idempotent : ne modifie pas les revues existantes et peut être rejoué sans risque.

begin;

alter table management_reviews
  add column if not exists participant_attendance jsonb not null default '{}'::jsonb;

commit;