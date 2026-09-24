-- Outils plateforme : maintenance globale et tickets support.
create table if not exists platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

insert into platform_settings (key, value)
values ('maintenance', '{"enabled": false, "message": "Maintenance en cours. Revenez dans quelques instants."}'::jsonb)
on conflict (key) do nothing;

create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  subject text not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  admin_note text,
  assigned_to uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_support_tickets_tenant on support_tickets(tenant_id);
create index if not exists idx_support_tickets_status on support_tickets(status);

create trigger support_tickets_updated_at before update on support_tickets
for each row execute function set_updated_at();
