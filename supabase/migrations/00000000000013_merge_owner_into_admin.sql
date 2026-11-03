-- Fusionne le rôle 'owner' dans 'admin' : les 4 niveaux (owner/admin/manager/member)
-- deviennent 3 (admin/manager/member). Conséquence assumée : il n'existe plus de rôle
-- unique/protégé par tenant — n'importe quel admin peut désormais gérer n'importe quel
-- autre admin. Le transfert de propriété n'a donc plus de sens et est retiré.

update users set role = 'admin' where role = 'owner';

alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'manager', 'member'));

update document_categories set required_approver_role = 'admin' where required_approver_role = 'owner';

alter table document_categories drop constraint document_categories_required_approver_role_check;
alter table document_categories add constraint document_categories_required_approver_role_check
  check (required_approver_role in ('admin', 'manager', 'member'));

drop function if exists transfer_ownership(uuid, uuid, uuid);

create or replace function search_documents(
  p_tenant_id uuid,
  p_user_id uuid,
  p_user_role text,
  p_query text,
  p_limit integer default 20
)
returns table (
  id uuid,
  number text,
  title text,
  status text,
  category_id uuid,
  rank real,
  snippet text,
  match_location text
)
language sql
stable
as $$
  select
    d.id,
    d.number,
    d.title,
    d.status,
    d.category_id,
    ts_rank(d.search_vector, query) as rank,
    ts_headline(
      'french',
      coalesce(d.title, '') || '. ' || coalesce(d.description, '') || '. ' || coalesce(d.extracted_text, ''),
      query,
      'MaxWords=30, MinWords=15, ShortWord=3, HighlightAll=false, MaxFragments=1, StartSel=<mark>, StopSel=</mark>'
    ) as snippet,
    case
      when to_tsvector('french', coalesce(d.title, '')) @@ query then 'title'
      else 'content'
    end as match_location
  from documents d
  left join document_categories dc on dc.id = d.category_id
  cross join websearch_to_tsquery('french', p_query) query
  where d.tenant_id = p_tenant_id
    and d.search_vector @@ query
    and (
      p_user_role = 'admin'
      or d.category_id is null
      or coalesce(dc.is_restricted, false) = false
      or exists (
        select 1
        from category_permissions cp
        where cp.category_id = d.category_id
          and cp.can_view = true
          and (
            (cp.subject_type = 'user' and cp.subject_id = p_user_id)
            or (
              cp.subject_type = 'group'
              and cp.subject_id in (select gm.group_id from group_members gm where gm.user_id = p_user_id)
            )
          )
      )
    )
  order by rank desc
  limit p_limit;
$$;
