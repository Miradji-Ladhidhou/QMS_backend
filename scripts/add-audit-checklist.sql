-- Check-list (QCM) d'audit : questions posées par l'auditeur pendant l'audit, chacune avec une réponse
-- Conforme / Non conforme / Sans objet et une observation. Questions saisies à la main ou générées
-- par l'IA (source), puis relues avant enregistrement. Le taux de conformité de l'audit se calcule
-- sur les réponses données (les « sans objet » sont exclues).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

create table if not exists audit_checklist_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  audit_id    uuid not null references audits (id) on delete cascade,
  position    integer not null,
  question    text not null,
  answer      text check (answer in ('conform', 'nonconform', 'na')),
  observation text,
  answered_by uuid references users (id) on delete set null,
  answered_at timestamptz,
  source      text not null default 'manual' check (source in ('manual', 'ai')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_audit_checklist_items_tenant_id on audit_checklist_items (tenant_id);
create index if not exists idx_audit_checklist_items_audit_id on audit_checklist_items (audit_id);

alter table audit_checklist_items enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'audit_checklist_items' and policyname = 'audit_checklist_items_isolation') then
    create policy audit_checklist_items_isolation on audit_checklist_items
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;
