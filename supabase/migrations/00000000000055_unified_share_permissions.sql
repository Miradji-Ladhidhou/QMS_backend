begin;

alter table public.record_shares
  add column can_edit boolean,
  add column can_export boolean,
  add column title text;
alter table public.guest_shares add column can_export boolean not null default false;

create function public.create_internal_share_batch(
  p_tenant_id uuid, p_created_by uuid, p_title text, p_subject_type text,
  p_subject_id text, p_can_edit boolean, p_can_export boolean, p_items jsonb
) returns integer
language plpgsql
set search_path = public
as $$
declare
  total integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Items must be an array';
  end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'No items selected'; end if;
  if not exists (select 1 from public.users where id = p_created_by and tenant_id = p_tenant_id and role in ('admin', 'manager')) then
    raise exception 'Invalid share creator';
  end if;
  if p_subject_type = 'user' then
    if not exists (select 1 from public.users where id::text = p_subject_id and tenant_id = p_tenant_id and role <> 'admin') then
      raise exception 'Invalid recipient';
    end if;
  elsif p_subject_type <> 'role' or p_subject_id not in ('manager', 'member') then
    raise exception 'Invalid recipient';
  end if;
  insert into public.record_shares(tenant_id, resource_type, resource_id, subject_type, subject_id, created_by, title, can_edit, can_export)
  select p_tenant_id, item.resource_type, item.resource_id, p_subject_type, p_subject_id, p_created_by, p_title, p_can_edit, p_can_export
  from jsonb_to_recordset(p_items) as item(resource_type text, resource_id uuid)
  on conflict (tenant_id, resource_type, resource_id, subject_type, subject_id)
  do update set can_edit = excluded.can_edit, can_export = excluded.can_export, title = excluded.title;
  get diagnostics total = row_count;
  return total;
end;
$$;
revoke all on function public.create_internal_share_batch(uuid, uuid, text, text, text, boolean, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.create_internal_share_batch(uuid, uuid, text, text, text, boolean, boolean, jsonb) to service_role;

-- The backend is the only reader/writer of protected document objects.
update storage.buckets set public = false where id = 'qms-documents';
create policy qms_document_objects_backend_only on storage.objects
  as restrictive for all to anon, authenticated
  using (bucket_id <> 'qms-documents')
  with check (bucket_id <> 'qms-documents');

notify pgrst, 'reload schema';
commit;
