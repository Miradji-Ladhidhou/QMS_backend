-- Évaluation fournisseurs : réglages par entreprise (fréquences selon la criticité, seuils de décision,
-- pondération des critères), note globale pondérée et décision proposée conservées avec chaque évaluation,
-- responsable du suivi d'un fournisseur, certificats et pièces avec date d'expiration, interrupteur des alertes.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.
-- Aucune donnée existante n'est modifiée : les évaluations déjà saisies gardent leur note globale (moyenne
-- simple) ; les nouvelles colonnes sont vides tant que personne ne les renseigne.

begin;

-- Réglages : { frequency_months: {low, medium, high, critical}, thresholds: {watch, replace},
-- weights: {<criticité>: {quality, delivery, price, responsiveness}}, auto_suspend_on_replace }.
-- Vide = valeurs par défaut de l'application (services/supplierPolicy.js).
alter table tenants add column if not exists supplier_settings jsonb not null default '{}'::jsonb;

-- Responsable du suivi du fournisseur : c'est lui que les rappels préviennent (à défaut, celui qui l'a créé).
alter table suppliers add column if not exists owner uuid references users (id) on delete set null;

-- Note globale PONDÉRÉE de l'évaluation (poids en vigueur à la date de l'évaluation, conservés dans `weights`)
-- et décision qu'aurait proposée l'application. overall_score reste la moyenne simple d'origine.
alter table supplier_evaluations add column if not exists weighted_score numeric;
alter table supplier_evaluations add column if not exists weights jsonb;
alter table supplier_evaluations add column if not exists suggested_decision text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'supplier_evaluations_suggested_decision_check') then
    alter table supplier_evaluations add constraint supplier_evaluations_suggested_decision_check
      check (suggested_decision is null or suggested_decision in ('maintained', 'under_watch', 'to_replace'));
  end if;
end $$;

-- Alertes fournisseurs par email (évaluation à faire, certificat qui expire).
alter table user_notification_preferences add column if not exists email_supplier_alerts boolean not null default true;

-- Certificats et pièces d'un fournisseur (certificat qualité ou sécurité des aliments, agrément sanitaire,
-- assurance, contrat...) avec leur date d'expiration ; le fichier est facultatif.
create table if not exists supplier_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  supplier_id uuid not null references suppliers (id) on delete cascade,
  kind        text not null default 'other' check (kind in ('quality_certificate', 'food_safety_certificate', 'sanitary_approval', 'insurance', 'contract', 'other')),
  title       text not null,
  reference   text,
  issuer      text,
  issued_on   date,
  expires_on  date,
  notes       text,
  file_path   text,
  file_name   text,
  uploaded_by uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_supplier_documents_tenant_id on supplier_documents (tenant_id);
create index if not exists idx_supplier_documents_supplier_id on supplier_documents (supplier_id);
create index if not exists idx_supplier_documents_expires_on on supplier_documents (expires_on);

alter table supplier_documents enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'supplier_documents' and policyname = 'supplier_documents_isolation') then
    create policy supplier_documents_isolation on supplier_documents
      for all
      using (tenant_id = auth_tenant_id())
      with check (tenant_id = auth_tenant_id());
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_supplier_documents_updated_at') then
    create trigger trg_supplier_documents_updated_at before update on supplier_documents
      for each row execute function set_updated_at();
  end if;
end $$;

commit;

notify pgrst, 'reload schema';
