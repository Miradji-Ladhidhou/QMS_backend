alter table management_reviews
  add column if not exists participant_attendance jsonb not null default '{}'::jsonb;