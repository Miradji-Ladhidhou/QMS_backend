-- Les réglages globaux passent uniquement par le backend service_role.
alter table platform_settings enable row level security;
revoke all on platform_settings from anon, authenticated;
grant all on platform_settings to service_role;
