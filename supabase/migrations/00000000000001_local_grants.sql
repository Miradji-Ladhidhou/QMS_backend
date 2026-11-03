-- Local dev only : les CLI Supabase récentes n'exposent plus automatiquement les
-- nouvelles tables du schéma public aux rôles anon/authenticated/service_role
-- (auto_expose_new_tables=false par défaut). Sur un vrai projet Supabase hébergé, ces
-- grants sont posés par la plateforme elle-même — schema.sql (backend/) n'en a donc
-- jamais eu besoin. Ce fichier ne concerne que l'environnement local.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to anon, authenticated, service_role;
