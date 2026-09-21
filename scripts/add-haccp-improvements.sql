-- HACCP : limites critiques chiffrées et intervalle de surveillance par CCP (rappels de relevé,
-- verdict automatique, courbe), valeur numérique des relevés, revue annuelle et versions d'un plan,
-- liens d'un plan avec fournisseurs / formations / procédures, interrupteur des alertes HACCP.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.
-- Aucune donnée existante n'est modifiée : les nouvelles colonnes sont vides (nullables) tant que
-- personne ne les renseigne ; les CCP existants continuent de fonctionner comme avant.

begin;

-- Limites critiques chiffrées d'un CCP (bornes incluses) : permettent le verdict automatique
-- « dans / hors limites » d'un relevé et le tracé de la courbe. Le texte critical_limits reste la
-- référence lisible. Au moins une borne pour activer le verdict automatique.
alter table haccp_ccps add column if not exists limit_min numeric;
alter table haccp_ccps add column if not exists limit_max numeric;
alter table haccp_ccps add column if not exists limit_unit text;
-- Intervalle de surveillance en heures (ex. 12 = deux fois par jour) : sert au rappel « relevé en
-- retard ». Vide = pas de rappel (surveillance en continu, par lot...).
alter table haccp_ccps add column if not exists monitoring_interval_hours numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'haccp_ccps_limits_order_check') then
    alter table haccp_ccps add constraint haccp_ccps_limits_order_check
      check (limit_min is null or limit_max is null or limit_min <= limit_max);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'haccp_ccps_interval_check') then
    alter table haccp_ccps add constraint haccp_ccps_interval_check
      check (monitoring_interval_hours is null or monitoring_interval_hours > 0);
  end if;
end $$;

-- Valeur numérique d'un relevé (quand le CCP a des limites chiffrées) ; recorded_value reste le texte affiché.
alter table haccp_monitoring_logs add column if not exists numeric_value numeric;
create index if not exists idx_haccp_monitoring_logs_ccp_recorded on haccp_monitoring_logs (ccp_id, recorded_at desc);

-- Revue annuelle du plan (principe 6 : validation).
alter table haccp_plans add column if not exists review_date date;
alter table haccp_plans add column if not exists last_reviewed_at timestamptz;
alter table haccp_plans add column if not exists last_reviewed_by uuid references users (id) on delete set null;

-- Alertes HACCP par email (relevé en retard, dérives répétées, revue du plan à venir).
alter table user_notification_preferences add column if not exists email_haccp_alerts boolean not null default true;

-- Versions d'un plan : instantané complet (étapes, dangers, CCP) à chaque revue, activation ou
-- enregistrement manuel — l'historique dont un auditeur a besoin pour voir ce qui a changé et quand.
create table if not exists haccp_plan_revisions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  plan_id         uuid not null references haccp_plans (id) on delete cascade,
  revision_number integer not null,
  kind            text not null check (kind in ('manual', 'review', 'activation')),
  reason          text,
  snapshot        jsonb not null,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (plan_id, revision_number)
);

create index if not exists idx_haccp_plan_revisions_tenant_id on haccp_plan_revisions (tenant_id);
create index if not exists idx_haccp_plan_revisions_plan_id on haccp_plan_revisions (plan_id);

-- Liens d'un plan avec un fournisseur (matières premières), une formation requise ou une procédure.
create table if not exists haccp_plan_links (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  plan_id      uuid not null references haccp_plans (id) on delete cascade,
  supplier_id  uuid references suppliers (id) on delete cascade,
  training_id  uuid references trainings (id) on delete cascade,
  procedure_id uuid references procedures (id) on delete cascade,
  created_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now(),
  check (num_nonnulls(supplier_id, training_id, procedure_id) = 1)
);

create index if not exists idx_haccp_plan_links_tenant_id on haccp_plan_links (tenant_id);
create index if not exists idx_haccp_plan_links_plan_id on haccp_plan_links (plan_id);
create unique index if not exists uq_haccp_plan_links_supplier on haccp_plan_links (plan_id, supplier_id) where supplier_id is not null;
create unique index if not exists uq_haccp_plan_links_training on haccp_plan_links (plan_id, training_id) where training_id is not null;
create unique index if not exists uq_haccp_plan_links_procedure on haccp_plan_links (plan_id, procedure_id) where procedure_id is not null;

alter table haccp_plan_revisions enable row level security;
alter table haccp_plan_links enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'haccp_plan_revisions' and policyname = 'haccp_plan_revisions_isolation') then
    create policy haccp_plan_revisions_isolation on haccp_plan_revisions
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
  if not exists (select 1 from pg_policies where tablename = 'haccp_plan_links' and policyname = 'haccp_plan_links_isolation') then
    create policy haccp_plan_links_isolation on haccp_plan_links
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
