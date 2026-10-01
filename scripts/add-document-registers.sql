create table if not exists document_registers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  title text not null,
  description text,
  folder text,
  columns jsonb not null default '[]'::jsonb,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table document_registers add column if not exists folder text;

create table if not exists document_register_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  register_id uuid not null references document_registers (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  planning_date date,
  planning_title text,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_document_registers_tenant on document_registers(tenant_id);
create index if not exists idx_document_register_rows_tenant on document_register_rows(tenant_id);
create index if not exists idx_document_register_rows_register on document_register_rows(register_id);
create index if not exists idx_document_register_rows_planning_date on document_register_rows(planning_date) where planning_date is not null;

drop trigger if exists trg_document_registers_updated_at on document_registers;
create trigger trg_document_registers_updated_at before update on document_registers
  for each row execute function set_updated_at();

drop trigger if exists trg_document_register_rows_updated_at on document_register_rows;
create trigger trg_document_register_rows_updated_at before update on document_register_rows
  for each row execute function set_updated_at();

alter table document_registers enable row level security;
alter table document_register_rows enable row level security;

drop policy if exists document_registers_isolation on document_registers;
create policy document_registers_isolation on document_registers
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());

drop policy if exists document_register_rows_isolation on document_register_rows;
create policy document_register_rows_isolation on document_register_rows
  for all using (tenant_id = auth_tenant_id()) with check (tenant_id = auth_tenant_id());

notify pgrst, 'reload schema';