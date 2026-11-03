-- Les réglages globaux, dont les liens utiles, passent par les routes backend protégées.
-- Le backend utilise service_role ; aucun accès direct des clients n'est nécessaire.
alter table platform_settings enable row level security;
revoke all on platform_settings from anon, authenticated;
grant all on platform_settings to service_role;
