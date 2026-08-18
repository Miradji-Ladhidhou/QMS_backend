-- =============================================================================
-- QMS SaaS — Schéma PostgreSQL (Supabase)
-- Multitenant : isolation stricte des données par tenant_id via Row Level Security
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- =============================================================================
-- FONCTIONS UTILITAIRES
-- =============================================================================

-- Timestamp updated_at automatique
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- TABLES
-- =============================================================================

create table tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text not null unique,
  plan          text not null default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  logo_url      text,
  -- Géré depuis l'espace super admin (voir routes/superAdmin.js) : un tenant suspendu ne
  -- peut plus être utilisé (requireAuth le bloque), sans supprimer aucune de ses données.
  is_suspended  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table users (
  id              uuid primary key references auth.users (id) on delete cascade,
  tenant_id       uuid not null references tenants (id) on delete cascade,
  -- Transverse à tous les tenants, indépendant de role/tenant_id — un super admin gère la
  -- plateforme (liste des tenants, suspension...), pas les données d'un tenant en particulier.
  -- Ne se modifie qu'en base : aucune UI ne permet de se l'auto-attribuer.
  is_super_admin  boolean not null default false,
  full_name       text,
  role            text not null default 'member' check (role in ('owner', 'admin', 'manager', 'member')),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table document_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  color       text,
  required_approver_role text check (required_approver_role in ('owner', 'admin', 'manager', 'member')),
  -- false (défaut) : comportement actuel inchangé, visible par tout le tenant.
  -- true : accès réservé aux sujets ayant une entrée dans category_permissions.
  is_restricted boolean not null default false,
  created_at  timestamptz not null default now()
);

create table documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  category_id  uuid references document_categories (id) on delete set null,
  number       text not null,
  title        text not null,
  description  text,
  version      text not null default '1.0',
  status       text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  file_path    text,
  file_name    text,
  extracted_text text,
  search_vector tsvector,
  created_by   uuid references users (id) on delete set null,
  approved_by  uuid references users (id) on delete set null,
  review_date  date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, number)
);

create table document_versions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references documents (id) on delete cascade,
  tenant_id    uuid not null references tenants (id) on delete cascade,
  version      text not null,
  file_path    text,
  file_name    text,
  status       text,
  change_note  text,
  changed_by   uuid references users (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table capas (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants (id) on delete cascade,
  number                  text,
  title                   text not null,
  service                 text,
  description             text,
  origin                  text,
  ref_document            uuid references documents (id) on delete set null,
  severity                text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  priority                text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status                  text not null default 'open' check (status in ('open', 'in_progress', 'pending_verification', 'closed', 'overdue')),
  assigned_to             uuid references users (id) on delete set null,
  due_date                date,
  root_cause              text,
  corrective_action       text,
  preventive_action       text,
  -- null = pas encore vérifiée, true/false = verdict de la vérification d'efficacité
  effectiveness_verified  boolean,
  effectiveness_notes     text,
  comment                 text,
  closed_at               timestamptz,
  created_by              uuid references users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (tenant_id, number)
);

-- Compteur de numérotation des CAPA, par tenant et par année (CAPA-2026-001)
create table capa_counters (
  tenant_id  uuid not null references tenants (id) on delete cascade,
  year       integer not null,
  counter    integer not null default 0,
  primary key (tenant_id, year)
);

-- Délai de traitement (en jours, depuis la création) par niveau de priorité, paramétrable
-- par tenant. Une priorité sans ligne ici retombe sur un défaut côté application (voir
-- DEFAULT_PRIORITY_DELAYS dans capas.js) : haut/critique plus courts que bas/moyen.
create table capa_priority_delays (
  tenant_id   uuid not null references tenants (id) on delete cascade,
  priority    text not null check (priority in ('low', 'medium', 'high', 'critical')),
  delay_days  integer not null check (delay_days > 0),
  primary key (tenant_id, priority)
);

create table capa_comments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  capa_id     uuid not null references capas (id) on delete cascade,
  user_id     uuid references users (id) on delete set null,
  comment     text not null,
  created_at  timestamptz not null default now()
);

create table qqoqccp_analyses (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  title                  text not null,
  qui                    text,
  quoi                   text,
  -- "ou" et "quand" seuls entreraient en conflit avec les mots-clés SQL OR/quand-réservés
  -- selon le contexte : suffixés d'un underscore, et gardés cohérents partout dans le code.
  ou_                    text,
  quand_                 text,
  -- "comment" est déjà utilisé ailleurs dans le projet (capa_comments.comment) : suffixé
  -- d'un underscore ici pour éviter toute confusion de copier-coller entre les deux.
  comment_               text,
  combien                text,
  pourquoi               text,
  ai_synthesis           text,
  ai_suggested_actions   jsonb,
  status                 text not null default 'draft' check (status in ('draft', 'ai_generated', 'validated')),
  -- CAPA créée à partir de cette analyse (voir aussi capas.qqoqccp_analysis_id, l'inverse) —
  -- nullable : une analyse peut rester autonome sans jamais donner lieu à une CAPA.
  linked_capa_id         uuid references capas (id) on delete set null,
  created_by             uuid references users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- Analyse QQOQCCP à l'origine de cette CAPA (voir aussi qqoqccp_analyses.linked_capa_id,
-- l'inverse). Ajoutée après coup via alter table plutôt qu'inline dans capas ci-dessus :
-- qqoqccp_analyses est définie plus bas dans ce fichier, donc pas encore créée à ce stade.
alter table capas add column qqoqccp_analysis_id uuid references qqoqccp_analyses (id) on delete set null;

create table trainings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  title             text not null,
  type              text,
  frequency_months  integer,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table training_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  training_id    uuid not null references trainings (id) on delete cascade,
  user_id        uuid not null references users (id) on delete cascade,
  completed_at   date not null,
  next_due_date  date,
  certificate_url text,
  created_at     timestamptz not null default now()
);

-- Classement arborescent des KPI (ex : "Contrôle commande" > "Contrôle 2026" > les KPI de
-- 2026) — parent_id nul = dossier racine. on delete cascade sur parent_id : supprimer un
-- dossier supprime ses sous-dossiers, mais pas les KPI qu'il contenait (voir kpis.folder_id
-- ci-dessous, qui repasse à null plutôt que d'être supprimé).
create table kpi_folders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  parent_id   uuid references kpi_folders (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table kpis (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  folder_id   uuid references kpi_folders (id) on delete set null,
  name        text not null,
  unit        text,
  target      numeric,
  target_direction text not null default 'min' check (target_direction in ('min', 'max')),
  frequency   text check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'yearly')),
  -- 'manual' : valeur saisie directement. 'import' : calculée depuis un import générique
  -- (kpi_raw_imports/kpi_raw_rows). Le type de calcul précis (ratio, sum, average, count,
  -- count_grouped) n'est pas dupliqué ici : il vit uniquement dans kpi_calculation_configs
  -- .calc_type, pour éviter deux colonnes à garder synchronisées.
  calculation_type text not null default 'manual' check (calculation_type in ('manual', 'import')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Import générique : un fichier peut avoir n'importe quelle structure de colonnes, donc
-- on ne fige rien au niveau du schéma. kpi_id est nullable le temps de l'import initial :
-- on peut déposer un fichier, voir les colonnes qu'il contient, puis choisir ensuite à
-- quel KPI le rattacher et quelle recette de calcul lui appliquer (kpi_calculation_configs).
-- Doit exister avant kpi_records, qui y fait référence (source_import_id).
create table kpi_raw_imports (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid references kpis (id) on delete cascade,
  file_name         text,
  imported_by       uuid references users (id) on delete set null,
  imported_at       timestamptz not null default now(),
  -- En-têtes détectées dans le fichier (ex: ["Numéro", "Résultat", "Utilisateur"]) —
  -- affichées à l'utilisateur pour construire la recette de calcul sans deviner les noms.
  detected_columns  jsonb not null default '[]'::jsonb,
  row_count         integer not null default 0
);

-- La "recette" de calcul appliquée aux lignes brutes d'un KPI pour produire une valeur
-- (kpi_records.value) à chaque période. Un KPI peut porter plusieurs recettes ("séries",
-- label) affichées ensemble sur le même graphique — ex : "Conforme" et "Non conforme" sur
-- deux courbes distinctes, pour les comparer visuellement sur la même période plutôt que
-- de créer deux KPI séparés. calc_type est l'agrégation appliquée aux lignes retenues :
-- ratio (leur part parmi le total), sum/average/min/max d'une colonne numérique
-- (source_column), count (leur nombre), count_grouped (comptage par valeur distincte de
-- group_by_column). filters (jsonb, tableau de {column, operator, value}) sélectionne ces
-- lignes — combinées selon filter_logic ('all' = ET, 'any' = OU) — et s'applique à TOUTE
-- agrégation, pas seulement ratio (ex : moyenne d'une colonne restreinte aux lignes où un
-- autre champ vaut une valeur donnée). period_column est vide quand la période n'est pas
-- déductible du fichier et doit être précisée manuellement à chaque import plutôt que lue
-- colonne par colonne. Doit exister avant kpi_records, qui y fait référence (config_id).
create table kpi_calculation_configs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid not null references kpis (id) on delete cascade,
  label             text not null default 'Principal',
  calc_type         text not null check (calc_type in ('ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped')),
  source_column     text,
  filters           jsonb not null default '[]'::jsonb,
  filter_logic      text not null default 'all' check (filter_logic in ('all', 'any')),
  group_by_column   text,
  period_column     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- config_id identifie la série qui a produit la valeur (nul pour une saisie manuelle, qui
-- n'a pas de recette). unique (config_id, period_date) autorise plusieurs séries à avoir
-- chacune leur valeur sur la même période (comparaison sur un même graphique) ; les NULL
-- n'entrent jamais en conflit entre eux (sémantique standard d'une contrainte unique), donc
-- cette contrainte ne régit que les séries — l'unicité par KPI des saisies manuelles est
-- assurée séparément par l'index partiel idx_kpi_records_manual_period ci-dessous.
create table kpi_records (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid not null references kpis (id) on delete cascade,
  config_id         uuid references kpi_calculation_configs (id) on delete cascade,
  period_date       date not null,
  value             numeric not null,
  comment           text,
  -- 'manual' : saisie directe. 'import' : calculée depuis un import générique (CSV/Excel,
  -- kpi_raw_imports/kpi_raw_rows) — repasse à 'manual' si un humain modifie ensuite la
  -- valeur (voir PATCH .../records/:id).
  source            text not null default 'manual' check (source in ('manual', 'import')),
  source_import_id  uuid references kpi_raw_imports (id) on delete set null,
  recorded_by       uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (config_id, period_date)
);

create unique index idx_kpi_records_manual_period on kpi_records (kpi_id, period_date) where config_id is null;

-- Chaque ligne du fichier importé, telle quelle : row_data porte une clé par colonne du
-- fichier (ex: {"Numéro": "114...", "Résultat": "Conforme", "Utilisateur": "LADHIDHOU"}).
-- Stocker en JSONB plutôt que dans des colonnes typées évite une migration de schéma à
-- chaque nouvelle structure de fichier — c'est la ligne brute qui sert de preuve d'audit,
-- et la base sur laquelle kpi_calculation_configs applique sa recette pour produire la
-- valeur agrégée de kpi_records.
create table kpi_raw_rows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  import_id   uuid not null references kpi_raw_imports (id) on delete cascade,
  row_index   integer not null,
  row_data    jsonb not null
);

-- Workflow d'approbation tracé (remplace le simple champ status en donnant une
-- preuve auditable de qui devait approuver et de l'état de chacun).
create table document_workflows (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  document_id         uuid not null references documents (id) on delete cascade,
  required_approvers  uuid[] not null,
  current_step        integer not null default 0,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Une ligne par approbateur requis, créée dès la soumission (decision='pending'),
-- puis mise à jour par cet approbateur (jamais par un autre) quand il décide.
create table document_approvals (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  workflow_id     uuid not null references document_workflows (id) on delete cascade,
  approver_id     uuid not null references users (id) on delete cascade,
  decision        text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  comment         text,
  decided_at      timestamptz,
  signature_hash  text,
  ip_address      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workflow_id, approver_id)
);

-- Piste d'audit exigée par ISO 9001 / FDA 21 CFR Part 11 : INSERT uniquement,
-- jamais de UPDATE/DELETE (voir le trigger document_audit_log_immutable plus bas).
-- Aucune des trois colonnes de référence (tenant_id, document_id, user_id) n'est une clé
-- étrangère : ce journal doit survivre à la suppression du tenant, du document ou de
-- l'utilisateur qu'il documente. Une FK ON DELETE (CASCADE ou SET NULL) aurait déclenché
-- une cascade UPDATE/DELETE sur ces lignes, bloquée par le trigger immuable — ce qui aurait
-- empêché toute suppression d'un tenant/document/utilisateur ayant déjà un historique
-- (bug réel rencontré : DELETE /api/tenant et DELETE /api/documents/:id échouaient dès
-- qu'un document avait au moins une entrée d'audit).
create table document_audit_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  document_id uuid not null,
  user_id     uuid,
  action      text not null,
  details     jsonb,
  created_at  timestamptz not null default now()
);

create table user_notification_preferences (
  user_id                   uuid primary key references users (id) on delete cascade,
  tenant_id                 uuid not null references tenants (id) on delete cascade,
  email_documents_to_review boolean not null default true,
  email_capa_overdue        boolean not null default true,
  email_training_renewal    boolean not null default true,
  email_approval_requests   boolean not null default true,
  digest_frequency          text not null default 'daily' check (digest_frequency in ('immediate', 'daily', 'weekly')),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Trace chaque email envoyé (job planifié ou déclenchement immédiat) : sert au debug
-- et, via la contrainte unique ci-dessous, empêche physiquement de renvoyer la même
-- alerte deux fois le même jour au même utilisateur.
create table notification_log (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  user_id            uuid not null references users (id) on delete cascade,
  notification_type  text not null,
  reference_id       uuid,
  sent_date          date not null default current_date,
  created_at         timestamptz not null default now(),
  unique (user_id, notification_type, reference_id, sent_date)
);

-- Notifications visibles dans l'application (cloche), en complément de l'email :
-- une ligne par alerte générée, indépendamment du succès de l'envoi email.
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  user_id     uuid not null references users (id) on delete cascade,
  type        text not null,
  title       text not null,
  message     text,
  link        text,
  read        boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Groupes métier (ex: "RH", "Direction", "Qualité") pour attribuer des permissions
-- sans avoir à gérer chaque utilisateur individuellement.
create table groups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table group_members (
  group_id  uuid not null references groups (id) on delete cascade,
  user_id   uuid not null references users (id) on delete cascade,
  primary key (group_id, user_id)
);

-- Permissions par catégorie restreinte, accordées à un utilisateur ou un groupe.
-- subject_id n'a volontairement pas de contrainte FK : il pointe vers users(id) ou
-- groups(id) selon subject_type (association polymorphe). Une entrée orpheline après
-- suppression d'un utilisateur/groupe reste possible mais inerte (aucun sujet réel ne
-- correspond) ; un nettoyage périodique ou un trigger pourra être ajouté plus tard si besoin.
create table category_permissions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  category_id  uuid not null references document_categories (id) on delete cascade,
  subject_type text not null check (subject_type in ('user', 'group')),
  subject_id   uuid not null,
  can_view     boolean not null default true,
  can_edit     boolean not null default false,
  can_approve  boolean not null default false,
  can_delete   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (category_id, subject_type, subject_id)
);

-- Résout le tenant_id de l'utilisateur authentifié (utilisé par les policies RLS).
-- SECURITY DEFINER + search_path fixe : contourne le RLS de public.users pour
-- éviter une récursion de policy, sans exposer de faille de search_path.
create or replace function auth_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.users where id = auth.uid();
$$;

-- Transfère le rôle owner d'un tenant à un autre membre en une seule transaction,
-- pour ne jamais laisser un tenant sans owner ou avec deux owners en cas d'échec partiel.
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

-- =============================================================================
-- INDEX
-- =============================================================================

create index idx_users_tenant_id on users (tenant_id);

create index idx_document_categories_tenant_id on document_categories (tenant_id);

create index idx_documents_tenant_id on documents (tenant_id);
create index idx_documents_category_id on documents (category_id);
create index idx_documents_status on documents (status);
create index idx_documents_title_trgm on documents using gin (title gin_trgm_ops);
create index idx_documents_search_vector on documents using gin (search_vector);

create index idx_document_versions_document_id on document_versions (document_id);
create index idx_document_versions_tenant_id on document_versions (tenant_id);

create index idx_capas_tenant_id on capas (tenant_id);
create index idx_capas_status on capas (status);
create index idx_capas_assigned_to on capas (assigned_to);
create index idx_capas_ref_document on capas (ref_document);
create index idx_capas_due_date on capas (due_date);

create index idx_capa_comments_tenant_id on capa_comments (tenant_id);
create index idx_capa_comments_capa_id on capa_comments (capa_id);

create index idx_qqoqccp_analyses_tenant_id on qqoqccp_analyses (tenant_id);

create index idx_trainings_tenant_id on trainings (tenant_id);

create index idx_training_records_tenant_id on training_records (tenant_id);
create index idx_training_records_training_id on training_records (training_id);
create index idx_training_records_user_id on training_records (user_id);
create index idx_training_records_next_due_date on training_records (next_due_date);

create index idx_kpi_folders_tenant_id on kpi_folders (tenant_id);
create index idx_kpi_folders_parent_id on kpi_folders (parent_id);

create index idx_kpis_tenant_id on kpis (tenant_id);
create index idx_kpis_folder_id on kpis (folder_id);

create index idx_kpi_records_tenant_id on kpi_records (tenant_id);
create index idx_kpi_records_kpi_id on kpi_records (kpi_id);
create index idx_kpi_records_period_date on kpi_records (period_date);
create index idx_kpi_records_source_import_id on kpi_records (source_import_id);
create index idx_kpi_records_config_id on kpi_records (config_id);

create index idx_kpi_raw_imports_tenant_id on kpi_raw_imports (tenant_id);
create index idx_kpi_raw_imports_kpi_id on kpi_raw_imports (kpi_id);

create index idx_kpi_raw_rows_tenant_id on kpi_raw_rows (tenant_id);
create index idx_kpi_raw_rows_import_id on kpi_raw_rows (import_id);
-- Interroger row_data par clé (ex: filtrer sur "Résultat") est le principal accès du
-- moteur de calcul générique : un index GIN accélère ces recherches JSONB.
create index idx_kpi_raw_rows_row_data on kpi_raw_rows using gin (row_data);

create index idx_kpi_calculation_configs_tenant_id on kpi_calculation_configs (tenant_id);
create index idx_kpi_calculation_configs_kpi_id on kpi_calculation_configs (kpi_id);

create index idx_document_workflows_tenant_id on document_workflows (tenant_id);
create index idx_document_workflows_document_id on document_workflows (document_id);
create index idx_document_workflows_status on document_workflows (status);

create index idx_document_approvals_tenant_id on document_approvals (tenant_id);
create index idx_document_approvals_workflow_id on document_approvals (workflow_id);
create index idx_document_approvals_approver_id on document_approvals (approver_id);

create index idx_document_audit_log_tenant_id on document_audit_log (tenant_id);
create index idx_document_audit_log_document_id on document_audit_log (document_id);
create index idx_document_audit_log_created_at on document_audit_log (created_at);

create index idx_user_notification_preferences_tenant_id on user_notification_preferences (tenant_id);

create index idx_notification_log_tenant_id on notification_log (tenant_id);
create index idx_notification_log_user_id on notification_log (user_id);
create index idx_notification_log_sent_date on notification_log (sent_date);

create index idx_notifications_tenant_id on notifications (tenant_id);
create index idx_notifications_user_id on notifications (user_id);
create index idx_notifications_user_read on notifications (user_id, read);

create index idx_groups_tenant_id on groups (tenant_id);

create index idx_group_members_user_id on group_members (user_id);

create index idx_category_permissions_tenant_id on category_permissions (tenant_id);
create index idx_category_permissions_category_id on category_permissions (category_id);
create index idx_category_permissions_subject on category_permissions (subject_type, subject_id);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

create trigger trg_tenants_updated_at before update on tenants
  for each row execute function set_updated_at();

create trigger trg_users_updated_at before update on users
  for each row execute function set_updated_at();

create trigger trg_documents_updated_at before update on documents
  for each row execute function set_updated_at();

-- Recherche plein texte (français) : title poids A, description poids B, extracted_text poids C
create or replace function documents_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('french', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('french', coalesce(new.description, '')), 'B') ||
    setweight(to_tsvector('french', coalesce(new.extracted_text, '')), 'C');
  return new;
end;
$$;

create trigger trg_documents_search_vector before insert or update on documents
  for each row execute function documents_search_vector_update();

create trigger trg_capas_updated_at before update on capas
  for each row execute function set_updated_at();

create trigger trg_trainings_updated_at before update on trainings
  for each row execute function set_updated_at();

create trigger trg_kpis_updated_at before update on kpis
  for each row execute function set_updated_at();

create trigger trg_document_workflows_updated_at before update on document_workflows
  for each row execute function set_updated_at();

create trigger trg_document_approvals_updated_at before update on document_approvals
  for each row execute function set_updated_at();

-- document_audit_log est une piste d'audit : aucune modification ni suppression
-- n'est autorisée, quel que soit le rôle (y compris service_role), uniquement des INSERT.
create or replace function document_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'document_audit_log est immuable : aucune modification ni suppression autorisée.';
end;
$$;

create trigger trg_document_audit_log_immutable
  before update or delete on document_audit_log
  for each row execute function document_audit_log_immutable();

create trigger trg_user_notification_preferences_updated_at before update on user_notification_preferences
  for each row execute function set_updated_at();
-- Numérotation auto-incrémentée des CAPA par tenant et par année (ex : CAPA-2026-001)
create or replace function set_capa_number()
returns trigger
language plpgsql
as $$
declare
  capa_year integer := extract(year from now())::integer;
  next_seq integer;
begin
  insert into capa_counters (tenant_id, year, counter)
    values (new.tenant_id, capa_year, 1)
    on conflict (tenant_id, year)
    do update set counter = capa_counters.counter + 1
    returning counter into next_seq;

  new.number := 'CAPA-' || capa_year || '-' || lpad(next_seq::text, 3, '0');
  return new;
end;
$$;

create trigger trg_set_capa_number before insert on capas
  for each row when (new.number is null) execute function set_capa_number();

-- =============================================================================
-- RECHERCHE
-- =============================================================================

-- Recherche plein texte sur les documents : classement par pertinence (ts_rank),
-- extrait mis en évidence (ts_headline), et localisation de la correspondance
-- (titre vs contenu) pour l'indicateur visuel côté frontend.
--
-- p_user_id / p_user_role (obligatoires, pas de valeur par défaut) appliquent les
-- permissions granulaires du Chantier 4 : un document dans une catégorie restreinte
-- (is_restricted) n'apparaît dans les résultats que si l'appelant est owner/admin, ou
-- dispose d'une entrée category_permissions.can_view (directement ou via un groupe).
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
      p_user_role in ('owner', 'admin')
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

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

alter table tenants enable row level security;
alter table users enable row level security;
alter table document_categories enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table capas enable row level security;
alter table capa_counters enable row level security;
alter table capa_priority_delays enable row level security;
alter table capa_comments enable row level security;
alter table qqoqccp_analyses enable row level security;
alter table trainings enable row level security;
alter table training_records enable row level security;
alter table kpi_folders enable row level security;
alter table kpis enable row level security;
alter table kpi_records enable row level security;
alter table kpi_raw_imports enable row level security;
alter table kpi_raw_rows enable row level security;
alter table kpi_calculation_configs enable row level security;
alter table document_workflows enable row level security;
alter table document_approvals enable row level security;
alter table document_audit_log enable row level security;
alter table user_notification_preferences enable row level security;
alter table notification_log enable row level security;
alter table notifications enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table category_permissions enable row level security;

-- tenants : un utilisateur ne voit que son propre tenant
create policy tenants_isolation on tenants
  for all
  using (id = auth_tenant_id())
  with check (id = auth_tenant_id());

-- users : visibles/modifiables uniquement au sein du même tenant
create policy users_isolation on users
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_categories_isolation on document_categories
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy documents_isolation on documents
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_versions_isolation on document_versions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capas_isolation on capas
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capa_counters_isolation on capa_counters
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capa_priority_delays_isolation on capa_priority_delays
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy capa_comments_isolation on capa_comments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy qqoqccp_analyses_isolation on qqoqccp_analyses
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy trainings_isolation on trainings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy training_records_isolation on training_records
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_folders_isolation on kpi_folders
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpis_isolation on kpis
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_records_isolation on kpi_records
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_raw_imports_isolation on kpi_raw_imports
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_raw_rows_isolation on kpi_raw_rows
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy kpi_calculation_configs_isolation on kpi_calculation_configs
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_workflows_isolation on document_workflows
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy document_approvals_isolation on document_approvals
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

-- Lecture seule via RLS (en plus du trigger d'immuabilité) : même un accès authentifié
-- direct ne peut qu'insérer/lire, jamais modifier ou supprimer une entrée d'audit.
create policy document_audit_log_select on document_audit_log
  for select
  using (tenant_id = auth_tenant_id());

create policy document_audit_log_insert on document_audit_log
  for insert
  with check (tenant_id = auth_tenant_id());

create policy user_notification_preferences_isolation on user_notification_preferences
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy notification_log_isolation on notification_log
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy notifications_isolation on notifications
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy groups_isolation on groups
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

-- group_members n'a pas de tenant_id propre (fidèle au schéma demandé) : l'isolation
-- passe par le tenant du groupe parent.
create policy group_members_isolation on group_members
  for all
  using (exists (select 1 from groups g where g.id = group_members.group_id and g.tenant_id = auth_tenant_id()))
  with check (exists (select 1 from groups g where g.id = group_members.group_id and g.tenant_id = auth_tenant_id()));

create policy category_permissions_isolation on category_permissions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
