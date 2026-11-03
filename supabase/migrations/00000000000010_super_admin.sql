-- Applique en local, de façon incrémentale, le même changement que schema.sql (backend/) :
-- espace super admin transverse aux tenants (liste/suspension), voir routes/superAdmin.js.

alter table tenants add column if not exists is_suspended boolean not null default false;
alter table users add column if not exists is_super_admin boolean not null default false;
