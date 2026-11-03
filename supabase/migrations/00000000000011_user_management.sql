-- Gestion des utilisateurs : désactivation de compte + transfert de propriété.

alter table users add column if not exists is_active boolean not null default true;

create or replace function transfer_ownership(p_tenant_id uuid, p_current_owner_id uuid, p_new_owner_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update users set role = 'owner' where id = p_new_owner_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'Nouveau propriétaire introuvable dans ce tenant.';
  end if;

  update users set role = 'admin' where id = p_current_owner_id and tenant_id = p_tenant_id;
end;
$$;
