-- Ajoute l'imbrication de dossiers (parent_id) à categories et document_categories — à
-- exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude ; ce script
-- n'est nécessaire que pour la prod, non joignable depuis cet environnement (pas de route
-- réseau vers db.<projet>.supabase.co).
--
-- Vérification préalable recommandée avant d'exécuter (doit renvoyer 0 ligne — sinon
-- l'index unique racine ci-dessous échouera à la création) :
--   select tenant_id, resource_type, name, count(*) from categories
--   where owner_user_id is null group by 1,2,3 having count(*) > 1;

begin;

alter table document_categories
  add column parent_id uuid references document_categories (id) on delete cascade;
create index idx_document_categories_parent_id on document_categories (parent_id);

alter table categories
  add column parent_id uuid references categories (id) on delete cascade;
alter table categories
  add constraint categories_personal_never_nested check (owner_user_id is null or parent_id is null);
create index idx_categories_parent_id on categories (parent_id);

drop index categories_admin_name_unique;
create unique index categories_admin_name_unique_root on categories (tenant_id, resource_type, name)
  where owner_user_id is null and parent_id is null;
create unique index categories_admin_name_unique_nested on categories (tenant_id, resource_type, parent_id, name)
  where owner_user_id is null and parent_id is not null;

commit;
