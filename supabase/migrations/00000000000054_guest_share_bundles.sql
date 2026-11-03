begin;

alter table public.guest_shares
  alter column resource_type drop not null,
  alter column resource_id drop not null,
  add column title text,
  add constraint guest_shares_bundle_shape check (
    (resource_type is not null and resource_id is not null)
    or (resource_type is null and resource_id is null and length(trim(title)) > 0 and title is not null)
  ),
  add constraint guest_shares_tenant_id_id_key unique (tenant_id, id);

create table public.guest_share_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  guest_share_id uuid not null,
  resource_type text not null check (resource_type in (
    'document', 'capa', 'complaint', 'qqoqccp', 'procedure', 'accident', 'pdca', 'audit',
    'management_review', 'risk', 'haccp_plan', 'supplier', 'nonconforming_output',
    'customer_satisfaction', 'employee', 'training', 'kpi', 'task', 'service', 'quality_policy'
  )),
  resource_id uuid not null,
  label text not null,
  foreign key (tenant_id, guest_share_id) references public.guest_shares(tenant_id, id) on delete cascade,
  unique (guest_share_id, resource_type, resource_id)
);

create index idx_guest_share_items_tenant_share on public.guest_share_items(tenant_id, guest_share_id);
alter table public.guest_share_items enable row level security;
revoke all on public.guest_share_items from anon, authenticated;
grant select, insert, update, delete on public.guest_share_items to service_role;
grant select, insert, update, delete on public.guest_shares to service_role;

create function public.create_guest_share_bundle(
  p_tenant_id uuid, p_created_by uuid, p_title text, p_email text,
  p_token_hash text, p_expires_at timestamptz, p_items jsonb
) returns public.guest_shares
language plpgsql
set search_path = public
as $$
declare
  created_share public.guest_shares;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Guest bundle items must be an array';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'Guest bundle must contain at least one item';
  end if;
  if not exists (select 1 from public.users where id = p_created_by and tenant_id = p_tenant_id) then
    raise exception 'Guest bundle creator must belong to the tenant';
  end if;
  insert into public.guest_shares(tenant_id, created_by, title, email, token_hash, expires_at)
  values (p_tenant_id, p_created_by, p_title, p_email, p_token_hash, p_expires_at)
  returning * into created_share;
  insert into public.guest_share_items(tenant_id, guest_share_id, resource_type, resource_id, label)
  select p_tenant_id, created_share.id, item.resource_type, item.resource_id, item.label
  from jsonb_to_recordset(p_items) as item(resource_type text, resource_id uuid, label text);
  return created_share;
end;
$$;
revoke all on function public.create_guest_share_bundle(uuid, uuid, text, text, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.create_guest_share_bundle(uuid, uuid, text, text, text, timestamptz, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
