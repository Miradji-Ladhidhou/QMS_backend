-- Registre des risques : historique de cotation, seuil d'acceptabilité par entreprise, dernière
-- revue, liens vers audits / fournisseurs / KPI / procédures, et interrupteur du rappel de revue.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.
-- Aucune donnée existante n'est modifiée : les risques déjà saisis reçoivent seulement une
-- première ligne d'historique reprenant leur cotation actuelle.

begin;

-- Seuil à partir duquel le risque résiduel est jugé inacceptable (score = probabilité × gravité,
-- de 1 à 25). 10 = valeur appliquée jusqu'ici en dur (« élevé » ou « critique »).
alter table tenants add column if not exists risk_unacceptable_score integer not null default 10;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_risk_unacceptable_score_check') then
    alter table tenants add constraint tenants_risk_unacceptable_score_check check (risk_unacceptable_score between 2 and 25);
  end if;
end $$;

-- Dernière revue du risque (réévaluation ou « revu, inchangé »).
alter table risks add column if not exists last_reviewed_at timestamptz;
alter table risks add column if not exists last_reviewed_by uuid references users (id) on delete set null;

-- Rappel email au responsable quand la date de revue d'un risque arrive.
alter table user_notification_preferences add column if not exists email_risk_review boolean not null default true;

-- Historique de cotation : une ligne à chaque fois que la cotation, la cotation résiduelle ou le
-- statut d'un risque change (ou qu'il est revu). Sert à la courbe d'évolution et à l'avant/après
-- traitement.
create table if not exists risk_assessments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  risk_id             uuid not null references risks (id) on delete cascade,
  likelihood          integer not null check (likelihood between 1 and 5),
  impact              integer not null check (impact between 1 and 5),
  score               integer generated always as (likelihood * impact) stored,
  residual_likelihood integer check (residual_likelihood between 1 and 5),
  residual_impact     integer check (residual_impact between 1 and 5),
  residual_score      integer generated always as (residual_likelihood * residual_impact) stored,
  status              text not null,
  reason              text,
  assessed_by         uuid references users (id) on delete set null,
  assessed_at         timestamptz not null default now()
);

create index if not exists idx_risk_assessments_tenant_id on risk_assessments (tenant_id);
create index if not exists idx_risk_assessments_risk_id on risk_assessments (risk_id, assessed_at);

-- Première ligne d'historique des risques existants (une seule fois : seulement ceux qui n'en ont pas).
insert into risk_assessments (tenant_id, risk_id, likelihood, impact, residual_likelihood, residual_impact, status, reason, assessed_by, assessed_at)
select r.tenant_id, r.id, r.likelihood, r.impact, r.residual_likelihood, r.residual_impact, r.status,
       'Cotation en vigueur à l''activation de l''historique', r.created_by, r.updated_at
from risks r
where not exists (select 1 from risk_assessments a where a.risk_id = r.id);

-- Liens d'un risque avec un audit, un fournisseur, un KPI ou une procédure (un seul objet par ligne).
create table if not exists risk_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  risk_id      uuid not null references risks (id) on delete cascade,
  audit_id     uuid references audits (id) on delete cascade,
  supplier_id  uuid references suppliers (id) on delete cascade,
  kpi_id       uuid references kpis (id) on delete cascade,
  procedure_id uuid references procedures (id) on delete cascade,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  check (num_nonnulls(audit_id, supplier_id, kpi_id, procedure_id) = 1)
);

create index if not exists idx_risk_links_tenant_id on risk_links (tenant_id);
create index if not exists idx_risk_links_risk_id on risk_links (risk_id);
create unique index if not exists uq_risk_links_audit on risk_links (risk_id, audit_id) where audit_id is not null;
create unique index if not exists uq_risk_links_supplier on risk_links (risk_id, supplier_id) where supplier_id is not null;
create unique index if not exists uq_risk_links_kpi on risk_links (risk_id, kpi_id) where kpi_id is not null;
create unique index if not exists uq_risk_links_procedure on risk_links (risk_id, procedure_id) where procedure_id is not null;

alter table risk_assessments enable row level security;
alter table risk_links enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'risk_assessments' and policyname = 'risk_assessments_isolation') then
    create policy risk_assessments_isolation on risk_assessments
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'risk_links' and policyname = 'risk_links_isolation') then
    create policy risk_links_isolation on risk_links
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
