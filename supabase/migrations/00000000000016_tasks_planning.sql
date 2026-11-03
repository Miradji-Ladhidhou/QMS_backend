-- Suivi manuel de tâches (voir schema.sql pour la justification complète) — alimente le
-- planning aux côtés des échéances CAPA/documents/formations déjà existantes.

create table tasks (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  title                 text not null,
  description           text,
  due_date              date not null,
  status                text not null default 'todo' check (status in ('todo', 'done')),
  assigned_to           uuid references users (id) on delete set null,
  assigned_employee_id  uuid references employees (id) on delete set null,
  created_by            uuid references users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint tasks_assignee_check check (not (assigned_to is not null and assigned_employee_id is not null))
);

create trigger trg_tasks_updated_at before update on tasks
  for each row execute function set_updated_at();

create index idx_tasks_tenant_id on tasks (tenant_id);
create index idx_tasks_due_date on tasks (due_date);
create index idx_tasks_assigned_to on tasks (assigned_to);
create index idx_tasks_assigned_employee_id on tasks (assigned_employee_id);

alter table tasks enable row level security;

create policy tasks_isolation on tasks
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
