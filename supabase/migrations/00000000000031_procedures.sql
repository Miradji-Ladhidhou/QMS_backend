-- Module Procédures : contenu structuré (jsonb), versionné, avec gabarit par tenant et
-- accusés de lecture — distinct du module Documents (fichiers uploadés) : ici le contenu est
-- édité/généré (IA) directement dans l'app, pas un fichier binaire. Noms de colonnes en
-- anglais et valeurs de statut en anglais, comme le reste du schéma (documents.status,
-- capas.status...) — seuls les commentaires SQL et les libellés affichés restent en français.

create table procedures (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  number            text not null,
  title             text not null,
  process           text,
  status            text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  next_review_date  date,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, number)
);

-- Contrairement à documents/document_versions (où la version COURANTE vit sur documents lui-
-- même et document_versions n'archive que les versions passées), ici TOUTES les versions —
-- y compris la courante — sont des lignes procedure_versions à part entière ;
-- procedures.current_version_id n'est qu'un pointeur vers celle qui fait foi actuellement.
create table procedure_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  version       text not null,
  content       jsonb not null default '{}',
  ai_generated  boolean not null default false,
  author_id     uuid references users (id) on delete set null,
  validator_id  uuid references users (id) on delete set null,
  submitted_at  timestamptz,
  validated_at  timestamptz,
  status        text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Ajouté après coup (comme capas.qqoqccp_analysis_id après qqoqccp_analyses, voir schema.sql) :
-- procedure_versions référence déjà procedures, donc procedures ne peut pas encore référencer
-- procedure_versions au moment de sa propre création — référence circulaire résolue en deux temps.
alter table procedures add column current_version_id uuid references procedure_versions (id) on delete set null;

-- Un seul gabarit par tenant n'est pas imposé ici (pas de contrainte unique sur tenant_id) :
-- rien dans la demande n'exclut plusieurs gabarits pour différents types de procédures, et une
-- contrainte à une seule ligne serait plus difficile à assouplir plus tard qu'à ajouter.
create table procedure_templates (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  section_structure  jsonb not null default '[]',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Accusé de lecture par VERSION (chaque procedure_versions est déjà une ligne stable et
-- immuable une fois publiée, contrairement à documents qui mute en place) — plus simple que
-- document_acknowledgments, qui doit lui matcher un numéro de version texte faute de ligne
-- dédiée par version courante.
create table procedure_acknowledgments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  procedure_version_id  uuid not null references procedure_versions (id) on delete cascade,
  user_id               uuid not null references users (id) on delete cascade,
  acknowledged_at       timestamptz not null default now(),
  unique (procedure_version_id, user_id)
);

create index idx_procedures_tenant_id on procedures (tenant_id);
create index idx_procedure_versions_tenant_id on procedure_versions (tenant_id);
create index idx_procedure_versions_procedure_id on procedure_versions (procedure_id);
create index idx_procedure_templates_tenant_id on procedure_templates (tenant_id);
create index idx_procedure_acknowledgments_tenant_id on procedure_acknowledgments (tenant_id);
create index idx_procedure_acknowledgments_procedure_version_id on procedure_acknowledgments (procedure_version_id);

create trigger trg_procedures_updated_at before update on procedures
  for each row execute function set_updated_at();
create trigger trg_procedure_versions_updated_at before update on procedure_versions
  for each row execute function set_updated_at();
create trigger trg_procedure_templates_updated_at before update on procedure_templates
  for each row execute function set_updated_at();

alter table procedures enable row level security;
alter table procedure_versions enable row level security;
alter table procedure_templates enable row level security;
alter table procedure_acknowledgments enable row level security;

create policy procedures_isolation on procedures
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_versions_isolation on procedure_versions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_templates_isolation on procedure_templates
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_acknowledgments_isolation on procedure_acknowledgments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
