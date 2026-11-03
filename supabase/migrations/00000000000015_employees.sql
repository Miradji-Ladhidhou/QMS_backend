-- Personnel suivi pour les formations sans avoir de compte QMS SaaS (voir schema.sql pour
-- la justification complète).

create table employees (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  full_name   text not null,
  email       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table training_records alter column user_id drop not null;
alter table training_records add column employee_id uuid references employees (id) on delete cascade;
alter table training_records add constraint training_records_person_check check (
  (user_id is not null and employee_id is null) or (user_id is null and employee_id is not null)
);

create index idx_employees_tenant_id on employees (tenant_id);
create index idx_training_records_employee_id on training_records (employee_id);

alter table employees enable row level security;

create policy employees_isolation on employees
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
