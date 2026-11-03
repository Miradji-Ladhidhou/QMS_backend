-- Enrichit les tâches manuelles du planning : priorité, checklist, récurrence, et le
-- préférence de rappel email associée (voir schema.sql pour la justification complète).

alter table tasks
  add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  add column checklist jsonb not null default '[]',
  add column recurrence text not null default 'none' check (recurrence in ('none', 'daily', 'weekly', 'monthly')),
  add column recurrence_interval integer not null default 1 check (recurrence_interval > 0);

alter table user_notification_preferences
  add column email_task_due boolean not null default true;
