-- Add optional descriptions to company services.
-- Idempotent: safe to run against databases where the column already exists.
alter table services add column if not exists description text not null default '';
