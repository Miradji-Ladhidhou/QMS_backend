-- Ajoute la récurrence annuelle aux tâches du planning (voir tasks.recurrence, migration 28).

alter table tasks drop constraint tasks_recurrence_check;
alter table tasks add constraint tasks_recurrence_check
  check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly'));
