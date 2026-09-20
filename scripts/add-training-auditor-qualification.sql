-- Formation qualifiante pour les auditeurs internes (ISO 9001 §9.2 : auditeurs choisis pour leur
-- compétence). Une formation cochée « qualifie les auditeurs internes » sert de référence à la page
-- Audits : l'auditeur désigné est signalé qualifié, à recycler ou non qualifié selon sa dernière
-- réalisation de cette formation (échéance de recyclage, résultat d'évaluation/QCM).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table trainings add column if not exists qualifies_internal_auditor boolean not null default false;

commit;
