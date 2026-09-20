-- Revue de direction : validation signée, envoi (convocation / compte rendu) et fréquence.
--  - management_reviews.validated_by/validated_at : la direction a validé et signé la revue ; le document
--    est alors verrouillé (seul le suivi des actions reste modifiable). Rouvrir efface la validation.
--  - management_review_signatures : image de la signature manuscrite, table à part pour que la liste
--    des revues (lue par tous) n'embarque jamais l'image.
--  - management_review_mailings : trace des convocations et des comptes rendus envoyés (qui, quand, à qui).
--  - tenants.management_review_frequency_months : intervalle prévu entre deux revues (§9.3.1 « à
--    intervalles planifiés ») — alimente le rappel « revue à programmer » du planning.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table management_reviews
  add column if not exists validated_by uuid references users (id) on delete set null,
  add column if not exists validated_at timestamptz;

create table if not exists management_review_signatures (
  review_id  uuid primary key references management_reviews (id) on delete cascade,
  tenant_id  uuid not null references tenants (id) on delete cascade,
  image      text not null,
  signed_by  uuid references users (id) on delete set null,
  signed_at  timestamptz not null default now()
);

create table if not exists management_review_mailings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants (id) on delete cascade,
  review_id  uuid not null references management_reviews (id) on delete cascade,
  kind       text not null check (kind in ('convocation', 'minutes')),
  subject    text not null,
  recipients jsonb not null default '[]'::jsonb,
  sent_by    uuid references users (id) on delete set null,
  sent_at    timestamptz not null default now()
);

alter table tenants add column if not exists management_review_frequency_months integer check (management_review_frequency_months is null or management_review_frequency_months > 0);

create index if not exists idx_management_review_signatures_tenant_id on management_review_signatures (tenant_id);
create index if not exists idx_management_review_mailings_tenant_id on management_review_mailings (tenant_id);
create index if not exists idx_management_review_mailings_review_id on management_review_mailings (review_id);

alter table management_review_signatures enable row level security;
alter table management_review_mailings enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'management_review_signatures' and policyname = 'management_review_signatures_isolation') then
    create policy management_review_signatures_isolation on management_review_signatures
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'management_review_mailings' and policyname = 'management_review_mailings_isolation') then
    create policy management_review_mailings_isolation on management_review_mailings
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;
