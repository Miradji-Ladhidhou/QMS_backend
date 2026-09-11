-- Suppression du module "Contexte du SMQ" (qms_context_versions) — à exécuter une seule fois
-- sur la base de production (Supabase SQL Editor, ou psql avec DATABASE_URL_PROD). Déjà
-- appliqué sur la base locale de dev/tests par Claude ; ce script n'est nécessaire que pour la
-- prod, non joignable depuis cet environnement (pas de route réseau vers
-- db.<projet>.supabase.co).
--
-- Sans risque de perte si la table est vide (cas confirmé en local) ; si des versions de
-- contexte existent réellement en prod, cette suppression est définitive.
-- Pas de contrainte resource_type à ajuster ici (qms_context_versions n'a jamais fait partie
-- du système de catégories génériques — un seul enregistrement courant par tenant, comme
-- quality_policy_versions).

drop table if exists qms_context_versions cascade;
