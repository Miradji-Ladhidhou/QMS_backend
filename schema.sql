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
  -- Fuseau IANA (ex. 'Europe/Paris', 'Indian/Reunion') utilisé pour l'affichage date/heure
  -- dans le menu et, à terme, tout formatage de date sensible au fuseau. UTC par défaut :
  -- neutre, ne présuppose rien de la localisation réelle du tenant.
  timezone      text not null default 'UTC',
  -- Fréquence par défaut (en mois) de révision documentaire — voir documents.review_date /
  -- review_frequency_months. Nul = pas de révision périodique automatique (comportement
  -- historique : review_date reste une saisie 100% manuelle).
  document_review_frequency_months integer,
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
  role            text not null default 'member' check (role in ('admin', 'manager', 'member')),
  is_active       boolean not null default true,
  -- Exclusion globale du suivi formations (matrice des compétences, relances d'échéance) —
  -- ex. poste externe/support n'ayant pas les obligations de formation du reste du tenant.
  -- N'affecte que le calcul de conformité : reste sélectionnable pour un enregistrement
  -- manuel ponctuel (voir /trainings/:id/records).
  training_exempt        boolean not null default false,
  training_exempt_reason text,
  -- Affiché sur la fiche de participation (voir attendanceSheetPdf.js) — un intitulé de poste
  -- libre, distinct de role qui n'est qu'un niveau de permission applicatif.
  job_title       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Personnel suivi pour les formations (et la matrice des compétences) sans avoir de compte
-- QMS SaaS — beaucoup de salariés (opérateurs, personnel de terrain...) doivent être
-- qualifiés au sens ISO 9001 sans jamais se connecter à l'application. Volontairement séparé
-- de users : ce dernier est indissociable d'un compte auth.users (voir sa FK), ce qui exclut
-- structurellement toute personne sans accès.
create table employees (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  full_name   text not null,
  email       text,
  is_active   boolean not null default true,
  -- Voir users.training_exempt — même exclusion globale, même sémantique.
  training_exempt        boolean not null default false,
  training_exempt_reason text,
  -- Voir users.job_title — même usage (fiche de participation).
  job_title   text,
  created_at  timestamptz not null default now()
);

create table document_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  color       text,
  required_approver_role text check (required_approver_role in ('admin', 'manager', 'member')),
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
  -- Dérogation à tenants.document_review_frequency_months pour ce document précis (ex. une
  -- procédure critique révisée tous les 6 mois quand le reste du tenant est à 24 mois). Nul =
  -- suit le défaut du tenant.
  review_frequency_months integer,
  -- Stockage alternatif Google Drive, par tenant (voir tenant_storage_settings /
  -- google_drive_connections) — purement additif, n'affecte aucun document existant. null =
  -- stocké sur Supabase Storage (comportement historique, inchangé) ; 'google_drive' = stocké
  -- sur Drive. Dans les deux cas, file_path est réutilisé tel quel : chemin Supabase Storage si
  -- null, id de fichier Google Drive si 'google_drive' — ne jamais interpréter file_path sans
  -- vérifier storage_provider d'abord.
  storage_provider text,
  -- Opt-in par document (admin/manager) : voir document_acknowledgments plus bas pour la trace
  -- réelle des accusés — false par défaut, n'affecte aucun document existant.
  requires_acknowledgment boolean not null default false,
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
  created_at   timestamptz not null default now(),
  -- Même signification que documents.storage_provider (voir Prompt B3/B1), figée au moment de
  -- l'archivage : un tenant qui change de provider en cours de route peut très bien avoir
  -- archivé cette version-là quand elle était encore sur l'autre — sans cette colonne, on
  -- perdrait cette information dès la première nouvelle version après un changement.
  storage_provider text
);

-- Liste fermée des services, en remplacement progressif du champ texte libre
-- capas.service (voir plus bas) — ne pas supprimer ce dernier tant que la migration
-- des données existantes n'est pas faite.
create table services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Rattache un utilisateur (typiquement un manager) à un ou plusieurs services, pour le
-- filtrage de son tableau de bord.
create table user_services (
  user_id     uuid not null references users (id) on delete cascade,
  service_id  uuid not null references services (id) on delete cascade,
  tenant_id   uuid not null references tenants (id) on delete cascade,
  primary key (user_id, service_id)
);

create table capas (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants (id) on delete cascade,
  number                  text,
  title                   text not null,
  -- Remplace progressivement le champ texte libre "service" ci-dessous par une liste
  -- fermée gérée par l'admin (table services) — les deux coexistent le temps de migrer
  -- les données existantes ; "service" n'est pas encore supprimé.
  service_id              uuid references services (id) on delete set null,
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

-- Audits internes (ISO 9001) : planifier un audit, le mener, conclure. service_id désigne le
-- service audité (métadonnée/filtre, pas une restriction d'accès — un audit concerne le SMQ
-- dans son ensemble). lead_auditor est nullable : un audit peut être planifié avant d'avoir
-- désigné qui le mène.
create table audits (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  title          text not null,
  audit_type     text not null default 'process' check (audit_type in ('process', 'product', 'system')),
  scope          text,
  service_id     uuid references services (id) on delete set null,
  lead_auditor   uuid references users (id) on delete set null,
  planned_date   date not null,
  completed_date date,
  status         text not null default 'planned' check (status in ('planned', 'in_progress', 'completed', 'closed')),
  conclusion     text,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Constats d'un audit. linked_capa_id suit le même principe bidirectionnel que
-- qqoqccp_analyses.linked_capa_id / capas.qqoqccp_analysis_id ci-dessus : un constat peut
-- rester autonome (ex. simple remarque) sans jamais donner lieu à une CAPA.
create table audit_findings (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  audit_id       uuid not null references audits (id) on delete cascade,
  type           text not null check (type in ('major_nc', 'minor_nc', 'observation', 'strength')),
  description    text not null,
  linked_capa_id uuid references capas (id) on delete set null,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Constat d'audit à l'origine de cette CAPA (voir aussi audit_findings.linked_capa_id,
-- l'inverse) — même raisonnement que qqoqccp_analysis_id ci-dessus : audit_findings est
-- définie juste au-dessus, donc ajoutée après coup ici plutôt qu'inline dans capas.
alter table capas add column audit_finding_id uuid references audit_findings (id) on delete set null;

-- Revue de direction (ISO 9001 §9.3) : synthèse périodique formalisée. snapshot fige au
-- moment de la clôture (status = 'completed') une photo chiffrée de l'état du SMQ
-- (audits/CAPA/KPI/documents/formations, voir services/qmsSnapshot.js) — un historique de
-- revue doit rester lisible même si les compteurs réels évoluent ensuite ; jsonb plutôt que
-- des colonnes dédiées, la forme du snapshot peut évoluer sans migration.
-- Les 4 champs texte suivent les catégories d'éléments d'entrée de la norme (statut des
-- actions de la revue précédente, évolutions du contexte, adéquation des ressources,
-- opportunités d'amélioration) — la performance du SMQ elle-même (§9.3.2 c) n'est pas un
-- champ texte à remplir à la main, elle vient du snapshot automatique.
create table management_reviews (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references tenants (id) on delete cascade,
  title                    text not null,
  review_date              date not null,
  status                   text not null default 'draft' check (status in ('draft', 'completed')),
  participants             text,
  previous_actions_status  text,
  context_changes          text,
  resource_adequacy        text,
  improvement_opportunities text,
  conclusions              text,
  snapshot                 jsonb,
  created_by               uuid references users (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Actions décidées en sortie de revue (§9.3.3). Même principe bidirectionnel que
-- audit_findings.linked_capa_id ci-dessus : une action peut rester autonome (ex. décision
-- sans CAPA formelle) sans jamais donner lieu à une CAPA.
create table management_review_actions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  review_id      uuid not null references management_reviews (id) on delete cascade,
  description    text not null,
  linked_capa_id uuid references capas (id) on delete set null,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Action de revue de direction à l'origine de cette CAPA (voir aussi
-- management_review_actions.linked_capa_id, l'inverse) — même raisonnement que
-- audit_finding_id ci-dessus.
alter table capas add column management_review_action_id uuid references management_review_actions (id) on delete set null;

-- Réclamations clients. due_date est une échéance de réponse (SLA), pas une date de
-- résolution — elle alimente le planning/le total "en retard" comme les autres outils (voir
-- services/planningItems.js). linked_capa_id suit le même principe bidirectionnel qu'ailleurs
-- dans ce fichier : lien direct (comme qqoqccp_analyses), pas de sous-table de "constats"
-- comme pour les audits — une réclamation est déjà l'unité atomique de ce module.
create table complaints (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  customer_name     text not null,
  customer_contact  text,
  received_date     date not null,
  due_date          date,
  description       text not null,
  product_service   text,
  severity          text not null default 'medium' check (severity in ('low', 'medium', 'high', 'critical')),
  status            text not null default 'received' check (status in ('received', 'investigating', 'resolved', 'closed')),
  service_id        uuid references services (id) on delete set null,
  assigned_to       uuid references users (id) on delete set null,
  root_cause        text,
  resolution        text,
  resolution_date   date,
  customer_satisfied boolean,
  linked_capa_id    uuid references capas (id) on delete set null,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Réclamation à l'origine de cette CAPA (voir aussi complaints.linked_capa_id, l'inverse) —
-- même raisonnement que les autres colonnes miroir ci-dessus.
alter table capas add column complaint_id uuid references complaints (id) on delete set null;

-- Registre des risques et opportunités (ISO 9001:2015 §6.1 — approche par les risques).
-- likelihood/impact sur une échelle 1-5 (matrice 5x5 standard), risk_score = likelihood *
-- impact calculé par la base (generated column) : jamais désynchronisé d'une mise à jour
-- partielle, contrairement à un calcul refait à la main côté application à chaque route.
-- Les colonnes residual_* rejouent la même évaluation après traitement (contrôles/plan
-- d'action) : un registre des risques sert justement à montrer qu'un risque a été réduit,
-- pas seulement qu'il a été identifié — nullables tant que le traitement n'a pas eu lieu.
create table risks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  title               text not null,
  type                text not null default 'risk' check (type in ('risk', 'opportunity')),
  category            text,
  description         text,
  service_id          uuid references services (id) on delete set null,
  owner               uuid references users (id) on delete set null,
  likelihood          integer not null check (likelihood between 1 and 5),
  impact              integer not null check (impact between 1 and 5),
  risk_score          integer generated always as (likelihood * impact) stored,
  current_controls    text,
  treatment_plan      text,
  residual_likelihood integer check (residual_likelihood between 1 and 5),
  residual_impact     integer check (residual_impact between 1 and 5),
  residual_score      integer generated always as (residual_likelihood * residual_impact) stored,
  status              text not null default 'identified' check (status in ('identified', 'treating', 'treated', 'accepted', 'closed')),
  review_date         date,
  linked_capa_id      uuid references capas (id) on delete set null,
  -- Traçabilité : ce risque vient-il d'une suggestion IA acceptée telle quelle (ou modifiée)
  -- plutôt que d'une saisie manuelle — même principe que haccp_hazards.ai_generated.
  ai_generated        boolean not null default false,
  created_by          uuid references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Risque/opportunité à l'origine de cette CAPA (voir aussi risks.linked_capa_id, l'inverse) —
-- même raisonnement que les autres colonnes miroir ci-dessus.
alter table capas add column risk_id uuid references risks (id) on delete set null;

-- HACCP (Hazard Analysis Critical Control Point — sécurité alimentaire). Un plan par
-- produit/procédé, décliné en étapes ordonnées du diagramme de fabrication
-- (haccp_process_steps), chacune porteuse de dangers identifiés (haccp_hazards), dont ceux
-- jugés significatifs donnent lieu à un point critique (haccp_ccps), lui-même surveillé au
-- fil de l'eau (haccp_monitoring_logs). Même relation en cascade parent/enfant que
-- audits -> audit_findings, répétée sur 4 niveaux au lieu d'un seul.
create table haccp_plans (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants (id) on delete cascade,
  title              text not null,
  product_description text,
  scope              text,
  team               text,
  service_id         uuid references services (id) on delete set null,
  status             text not null default 'draft' check (status in ('draft', 'active', 'under_review', 'archived')),
  created_by         uuid references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table haccp_process_steps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants (id) on delete cascade,
  plan_id     uuid not null references haccp_plans (id) on delete cascade,
  step_number integer not null,
  name        text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (plan_id, step_number)
);

-- likelihood/severity et risk_score generated : même principe que risks.risk_score ci-dessus
-- (jamais désynchronisé d'une mise à jour partielle). is_significant + justification tiennent
-- lieu, pour l'instant, de l'arbre de décision Codex Alimentarius complet (les 4 questions
-- classiques) — une évaluation manuelle documentée plutôt qu'un assistant guidé, en V1.
create table haccp_hazards (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  step_id           uuid not null references haccp_process_steps (id) on delete cascade,
  hazard_type       text not null check (hazard_type in ('biological', 'chemical', 'physical', 'allergen')),
  description       text not null,
  existing_controls text,
  likelihood        integer not null check (likelihood between 1 and 5),
  severity          integer not null check (severity between 1 and 5),
  risk_score        integer generated always as (likelihood * severity) stored,
  is_significant    boolean not null default false,
  justification     text,
  -- Traçabilité : ce danger vient-il d'une suggestion IA acceptée telle quelle (ou modifiée)
  -- plutôt que d'une saisie manuelle — utile pour un audit de conformité qui voudrait
  -- distinguer l'analyse humaine de l'assistance IA.
  ai_generated      boolean not null default false,
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table haccp_ccps (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null references tenants (id) on delete cascade,
  hazard_id                   uuid not null references haccp_hazards (id) on delete cascade,
  ccp_number                  text,
  critical_limits             text not null,
  monitoring_procedure        text not null,
  monitoring_frequency        text,
  monitoring_responsible      uuid references users (id) on delete set null,
  corrective_action_procedure text,
  verification_procedure      text,
  verification_frequency      text,
  record_keeping_procedure    text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Relevés de surveillance réels contre un CCP. linked_capa_id : même principe miroir que
-- risks.linked_capa_id — une dérive (within_limits = false) peut donner lieu à une CAPA sans
-- que ce soit systématique (ex. dérive mineure déjà couverte par corrective_action_taken).
create table haccp_monitoring_logs (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants (id) on delete cascade,
  ccp_id                 uuid not null references haccp_ccps (id) on delete cascade,
  recorded_value         text not null,
  within_limits          boolean not null,
  corrective_action_taken text,
  linked_capa_id         uuid references capas (id) on delete set null,
  recorded_by            uuid references users (id) on delete set null,
  recorded_at            timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

-- Relevé de surveillance à l'origine de cette CAPA (voir aussi
-- haccp_monitoring_logs.linked_capa_id, l'inverse) — même principe miroir que
-- risks.linked_capa_id / capas.risk_id ci-dessus.
alter table capas add column haccp_monitoring_log_id uuid references haccp_monitoring_logs (id) on delete set null;

-- Évaluation fournisseurs (ISO 9001 §8.4 — maîtrise des processus/produits/services fournis
-- par des prestataires externes). Un fournisseur (suppliers) porte plusieurs évaluations
-- périodiques dans le temps (supplier_evaluations), même relation parent/enfant que
-- trainings/training_records.
create table suppliers (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  name                  text not null,
  category              text,
  contact_name          text,
  contact_email         text,
  contact_phone         text,
  criticality           text not null default 'medium' check (criticality in ('low', 'medium', 'high', 'critical')),
  status                text not null default 'active' check (status in ('active', 'inactive', 'suspended')),
  service_id            uuid references services (id) on delete set null,
  next_evaluation_date  date,
  created_by            uuid references users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Quatre critères notés 1-5 (qualité, délais, prix, réactivité), pratique courante
-- d'évaluation fournisseur. overall_score est une generated column (moyenne arrondie à 2
-- décimales) — même raisonnement que risks.risk_score : jamais désynchronisée d'une mise à
-- jour partielle des 4 notes.
create table supplier_evaluations (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete cascade,
  supplier_id          uuid not null references suppliers (id) on delete cascade,
  evaluation_date      date not null,
  quality_score        integer not null check (quality_score between 1 and 5),
  delivery_score       integer not null check (delivery_score between 1 and 5),
  price_score          integer not null check (price_score between 1 and 5),
  responsiveness_score integer not null check (responsiveness_score between 1 and 5),
  overall_score        numeric generated always as (
    round((quality_score + delivery_score + price_score + responsiveness_score)::numeric / 4, 2)
  ) stored,
  decision             text not null default 'maintained' check (decision in ('maintained', 'under_watch', 'to_replace')),
  comment              text,
  linked_capa_id       uuid references capas (id) on delete set null,
  evaluated_by         uuid references users (id) on delete set null,
  created_at           timestamptz not null default now()
);

-- Évaluation fournisseur à l'origine de cette CAPA (voir aussi
-- supplier_evaluations.linked_capa_id, l'inverse) — même raisonnement que les autres colonnes
-- miroir ci-dessus.
alter table capas add column supplier_evaluation_id uuid references supplier_evaluations (id) on delete set null;

create table trainings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  title             text not null,
  type              text,
  frequency_months  integer,
  -- Affichés sur la fiche de participation et le certificat (voir attendanceSheetPdf.js et
  -- trainingCertificatePdf.js) — tous libres/texte : une session peut durer "3h30" ou "2
  -- jours", et lieu/formateur n'ont pas de format à contraindre côté base.
  location          text,
  instructor        text,
  duration          text,
  -- Objet/contenu de la formation : sans ce champ, un document imprimé ne dit rien de ce
  -- qu'elle couvre réellement, seulement son titre — insuffisant pour un audit.
  description       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- La personne formée est soit un compte (user_id) soit un salarié sans compte (employee_id),
-- jamais les deux ni aucun des deux — voir la contrainte plus bas.
create table training_records (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  training_id    uuid not null references trainings (id) on delete cascade,
  user_id        uuid references users (id) on delete cascade,
  employee_id    uuid references employees (id) on delete cascade,
  completed_at   date not null,
  next_due_date  date,
  certificate_url text,
  created_at     timestamptz not null default now(),
  constraint training_records_person_check check (
    (user_id is not null and employee_id is null) or (user_id is null and employee_id is not null)
  )
);

-- Empêche d'enregistrer deux fois la même personne pour la même formation à la même date
-- (ex. rouvrir "Enregistrer une réalisation" et re-sélectionner quelqu'un déjà coché) — index
-- partiel plutôt qu'une contrainte unique classique car user_id/employee_id sont mutuellement
-- exclusifs (voir training_records_person_check) et NULL ne collisionne jamais avec NULL.
create unique index training_records_user_unique
  on training_records (tenant_id, training_id, user_id, completed_at)
  where user_id is not null;
create unique index training_records_employee_unique
  on training_records (tenant_id, training_id, employee_id, completed_at)
  where employee_id is not null;

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
-- calc_type = 'manual' : même principe de série nommée, mais sans recette de calcul (pas de
-- source_column/filters/group_by_column/period_column, tous null) — sert uniquement à
-- regrouper des valeurs saisies à la main sous plusieurs courbes distinctes d'un même KPI
-- "manuel", au lieu d'un seul point par période (voir POST /kpis/:id/records, ManualSeries
-- côté frontend).
create table kpi_calculation_configs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  kpi_id            uuid not null references kpis (id) on delete cascade,
  label             text not null default 'Principal',
  calc_type         text not null check (calc_type in ('ratio', 'sum', 'average', 'min', 'max', 'count', 'count_grouped', 'manual')),
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
  -- Nullable + ON DELETE SET NULL (pas CASCADE) : la décision/signature doit survivre à la
  -- suppression définitive d'un compte utilisateur, même si l'identité de l'approbateur ne
  -- peut alors plus être résolue (voir migration 23, document_approvals_survive_user_deletion).
  approver_id     uuid references users (id) on delete set null,
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

-- Accusé de lecture ISO 9001 : qui a lu quelle VERSION d'un document, quand. La contrainte
-- unique fait tout le travail — bumper la version d'un document rend automatiquement tout le
-- monde "pas encore lu" pour la nouvelle version, sans purge ni job, en gardant l'historique
-- complet des anciens accusés. Réservé aux documents où documents.requires_acknowledgment est
-- activé (opt-in admin/manager, voir routes/documents.js).
create table document_acknowledgments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants (id) on delete cascade,
  document_id     uuid not null references documents (id) on delete cascade,
  version         text not null,
  user_id         uuid not null references users (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (document_id, user_id, version)
);

-- Module Procédures : contenu structuré (jsonb), versionné, avec gabarit par tenant et
-- accusés de lecture — distinct du module Documents (fichiers uploadés) : ici le contenu est
-- édité/généré (IA) directement dans l'app, pas un fichier binaire.
create table procedures (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants (id) on delete cascade,
  number            text not null,
  title             text not null,
  process           text,
  status            text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'obsolete')),
  next_review_date  date,
  created_by        uuid references users (id) on delete set null,
  obsolete_reason   text,
  obsoleted_at      timestamptz,
  obsoleted_by      uuid references users (id) on delete set null,
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
  -- Motif de rejet ("retour au rédacteur avec commentaire") — même nom que
  -- document_approvals.comment.
  comment       text,
  -- Pièce jointe optionnelle (procédure officielle déjà mise en forme, PDF/Word) EN
  -- COMPLÉMENT du contenu structuré, jamais à sa place : le contenu structuré garde tous ses
  -- usages (génération IA, vérification de conformité, comparateur de versions), la pièce
  -- jointe est juste le document source que le client possédait déjà. Même mécanisme que
  -- documents.file_path (Google Drive du tenant, voir services/tenantStorage.js) mais
  -- Drive-only ici, pas de repli Supabase : voir le résumé de session pour la justification.
  attachment_drive_file_id  text,
  attachment_file_name      text,
  -- Fiche de diffusion IA (résumé condensé pour un public cible qui doit connaître la
  -- procédure sans nécessairement la lire en entier) — générée seulement sur une version
  -- APPROVED (voir POST .../distribution-sheet), persistée ici pour être réaffichée en
  -- priorité dans la bannière d'accusé de lecture de ProcedureDetail.jsx à chaque chargement,
  -- pas seulement au moment de sa génération. {target_audience, summary, key_points,
  -- audience_notes, generated_at}.
  distribution_sheet jsonb,
  -- Recherche plein texte du contenu (objet/domaine d'application/responsabilités + texte des
  -- sections du gabarit) — même principe que documents.search_vector (trigger +
  -- to_tsvector('french', ...) + index GIN), utilisé par GET /api/procedures?search= via
  -- search_procedure_ids() ci-dessous plutôt qu'un scan complet du jsonb à chaque requête.
  search_vector tsvector,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Ajoutée après coup (comme capas.qqoqccp_analysis_id après qqoqccp_analyses) : référence
-- circulaire résolue en deux temps, procedure_versions référençant déjà procedures.
alter table procedures add column current_version_id uuid references procedure_versions (id) on delete set null;

-- Un gabarit par tenant (GET/PUT /api/procedure-gabarits sont des routes singulières, sans
-- :id — confirmé par la conception des routes, Prompt 2), imposé par une contrainte unique.
create table procedure_templates (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants (id) on delete cascade unique,
  section_structure    jsonb not null default '[]',
  -- Consigne de style libre, ajoutée au prompt IA de génération/vérification de conformité
  -- (voir services/groq.js) — copiée depuis un preset (POST /apply-preset) ou saisie
  -- librement, jamais interprétée structurellement, juste passée telle quelle au modèle.
  fixed_instructions   text,
  -- Police/couleurs — copié depuis un preset. Utilisé par l'export PDF (accentColor/
  -- boxBackground/boxBorder uniquement, voir services/procedurePdf.js) et par l'export Word
  -- (voir active_preset_id ci-dessous et services/procedureWord.js).
  render_style         jsonb,
  -- Identifiant du dernier preset appliqué (voir data/procedureTemplatePresets.js), JAMAIS
  -- effacé par une modification manuelle ultérieure de section_structure/fixed_instructions
  -- (le PUT normal ne touche pas render_style, donc le style visuel du dernier preset reste
  -- valide) — remis à null seulement si un autre preset est appliqué à sa place. Sert
  -- uniquement à choisir le renderer Word approprié (services/procedureWord.js) : PAS une
  -- référence figée vers le preset, qui reste une simple copie librement modifiable ensuite
  -- (voir POST /apply-preset).
  active_preset_id     text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Un job de génération IA "document complet" par exécution (voir
-- services/procedureFullDraftJob.js) : contrairement à generate-draft (transitoire, un seul
-- appel Groq, jamais persisté), ce pipeline enchaîne ~10-15 appels séquentiels (1 plan + 1 par
-- sous-section) et doit survivre à un redémarrage du process (hébergement Render, tiers non
-- payant redémarrable) — un état en mémoire serait perdu au premier restart en cours de
-- génération. procedure_id volontairement absent : comme generate-draft, ce pipeline tourne
-- AVANT que la procédure existe (formulaire de création) aussi bien qu'après (nouvelle
-- version) ; result contient le contenu assemblé, jamais persisté automatiquement dans
-- procedure_versions — c'est au frontend de le proposer dans l'éditeur puis de l'enregistrer
-- normalement via POST/PUT .../versions. Sert aussi de journal pour le garde-fou d'usage (voir
-- routes/procedures.js) : pas de table de quota dédiée, on compte les lignes récentes ici.
create table procedure_generation_jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants (id) on delete cascade,
  created_by          uuid references users (id) on delete set null,
  subject             text not null,
  -- Copie de procedure_templates.section_structure/fixed_instructions au moment du
  -- lancement — jamais relu depuis procedure_templates une fois le job démarré, pour ne pas
  -- mélanger deux gabarits si l'admin le modifie pendant l'exécution.
  template_snapshot   jsonb not null,
  status              text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  total_steps         integer,
  completed_steps     integer not null default 0,
  current_step_label  text,
  -- {objet, domaine_application, responsabilites, sections, documents_associes, ai_generation}
  -- — voir assembleProcedureFullDraft() ; rempli seulement quand status = 'completed'.
  result              jsonb,
  -- Sous-sections tombées en erreur (réseau ou JSON illisible) et remplacées par un texte
  -- "à compléter manuellement" plutôt que de faire échouer tout le document.
  -- [{section_key, subsection_title}].
  failed_subsections  jsonb not null default '[]',
  -- Rempli seulement sur un échec TOTAL (l'étape de plan elle-même a échoué) — jamais sur un
  -- échec partiel d'une sous-section, qui reste dans failed_subsections ci-dessus.
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Accusé de lecture par VERSION (chaque procedure_versions est déjà une ligne stable et
-- immuable une fois publiée, contrairement à documents qui mute en place) — plus simple que
-- document_acknowledgments, qui doit matcher un numéro de version texte faute de ligne dédiée
-- par version courante.
create table procedure_acknowledgments (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  procedure_version_id  uuid not null references procedure_versions (id) on delete cascade,
  user_id               uuid not null references users (id) on delete cascade,
  acknowledged_at       timestamptz not null default now(),
  unique (procedure_version_id, user_id)
);

-- Traçabilité inverse Procédures <-> CAPA/audits : contrairement à capas.ref_document (un seul
-- FK, fixé à la création de la CAPA), un même CAPA ou audit peut concerner plusieurs
-- procédures et vice-versa — table de liaison many-to-many plutôt qu'une colonne, attachable/
-- détachable après coup depuis n'importe lequel des deux côtés.
create table procedure_capa_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  capa_id       uuid not null references capas (id) on delete cascade,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (procedure_id, capa_id)
);

create table procedure_audit_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  procedure_id  uuid not null references procedures (id) on delete cascade,
  audit_id      uuid not null references audits (id) on delete cascade,
  created_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (procedure_id, audit_id)
);

create table user_notification_preferences (
  user_id                   uuid primary key references users (id) on delete cascade,
  tenant_id                 uuid not null references tenants (id) on delete cascade,
  email_documents_to_review boolean not null default true,
  email_capa_overdue        boolean not null default true,
  email_training_renewal    boolean not null default true,
  email_approval_requests   boolean not null default true,
  email_task_due            boolean not null default true,
  email_procedure_review    boolean not null default true,
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

-- Partage d'UN élément précis (un document, une CAPA...) avec un rôle ou une personne qui n'y
-- aurait normalement pas accès — générique et réutilisable entre modules plutôt qu'une table
-- par module, voir services/recordSharing.js. C'est un octroi d'accès EN PLUS des règles
-- normales du module (jamais une restriction) : pour les documents, s'ajoute à
-- category_permissions plutôt que de le remplacer (utile pour partager UN document précis
-- sans ouvrir toute sa catégorie restreinte) ; pour les CAPA, donne l'accès à un membre qui
-- n'est pas l'assigné. subject_id porte soit un nom de rôle ('manager'/'member', jamais
-- 'admin' — un admin voit déjà tout), soit un uuid d'utilisateur en texte selon subject_type.
create table record_shares (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants (id) on delete cascade,
  resource_type  text not null check (resource_type in ('document', 'capa', 'complaint', 'qqoqccp', 'procedure')),
  resource_id    uuid not null,
  subject_type   text not null check (subject_type in ('role', 'user')),
  subject_id     text not null,
  created_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, resource_type, resource_id, subject_type, subject_id)
);

-- Catégories génériques réutilisables par plusieurs modules (CAPA, réclamations, QQOQCCP,
-- fournisseurs, formations, revues de direction) — même principe que document_categories
-- (restriction + permissions par utilisateur/groupe), mais polymorphe via resource_type plutôt
-- qu'une table par module. Documents garde sa propre table (document_categories), déjà
-- profondément intégrée (upload, import Excel, historique des versions...) : pas de migration
-- risquée pour un bénéfice marginal, seule cette table sert les nouveaux modules.
create table categories (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  resource_type text not null check (
    resource_type in (
      'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
      'haccp_plan', 'procedure'
    )
  ),
  name          text not null,
  color         text,
  is_restricted boolean not null default false,
  -- Catégorie personnelle "Uniquement moi", créée en libre-service par un member/manager à la
  -- création d'un élément (voir getOrCreatePersonalCategory, genericCategoryPermissions.js) —
  -- null pour une catégorie normale gérée par un admin dans Paramètres. Le nom seul ne peut pas
  -- être unique ici (deux personnes peuvent s'appeler pareil, ou vouloir toutes une catégorie
  -- "Personnel") : l'identité réelle d'une catégorie personnelle est owner_user_id, pas le nom.
  owner_user_id uuid references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index categories_admin_name_unique on categories (tenant_id, resource_type, name) where owner_user_id is null;
create unique index categories_personal_owner_unique on categories (tenant_id, resource_type, owner_user_id) where owner_user_id is not null;

-- Miroir de category_permissions (documents), pour les catégories génériques ci-dessus —
-- table séparée plutôt que réutiliser category_permissions telle quelle : sa colonne
-- category_id référence déjà document_categories avec une contrainte FK stricte,
-- incompatible avec une seconde table de catégories sans une migration plus risquée.
create table generic_category_permissions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants (id) on delete cascade,
  category_id  uuid not null references categories (id) on delete cascade,
  subject_type text not null check (subject_type in ('user', 'group')),
  subject_id   uuid not null,
  can_view     boolean not null default true,
  can_edit     boolean not null default false,
  can_approve  boolean not null default false,
  can_delete   boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (category_id, subject_type, subject_id)
);

-- category_id sur chaque module concerné, ajouté après coup (ALTER, pas inline dans leurs
-- create table respectifs plus haut) : categories n'existe qu'à partir d'ici dans ce script,
-- une référence inline y échouerait sur une installation neuve exécutée dans l'ordre du fichier.
alter table capas add column category_id uuid references categories (id) on delete set null;
alter table complaints add column category_id uuid references categories (id) on delete set null;
alter table qqoqccp_analyses add column category_id uuid references categories (id) on delete set null;
alter table suppliers add column category_id uuid references categories (id) on delete set null;
alter table trainings add column category_id uuid references categories (id) on delete set null;
alter table management_reviews add column category_id uuid references categories (id) on delete set null;
alter table audits add column category_id uuid references categories (id) on delete set null;
alter table risks add column category_id uuid references categories (id) on delete set null;
alter table kpis add column category_id uuid references categories (id) on delete set null;
alter table haccp_plans add column category_id uuid references categories (id) on delete set null;
alter table procedures add column category_id uuid references categories (id) on delete set null;

-- Suivi manuel de tâches sans module dédié dans l'application (le planning agrège aussi
-- automatiquement les échéances CAPA/documents/formations, voir routes/planning.js).
-- L'assigné est optionnel, et au plus l'un des deux (compte OU personnel sans compte),
-- jamais les deux — même logique que training_records.
create table tasks (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants (id) on delete cascade,
  title                 text not null,
  description           text,
  due_date              date not null,
  status                text not null default 'todo' check (status in ('todo', 'done')),
  assigned_to           uuid references users (id) on delete set null,
  assigned_employee_id  uuid references employees (id) on delete set null,
  created_by            uuid references users (id) on delete set null,
  category_id           uuid references categories (id) on delete set null,
  priority              text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  checklist             jsonb not null default '[]',
  recurrence            text not null default 'none' check (recurrence in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  recurrence_interval   integer not null default 1 check (recurrence_interval > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint tasks_assignee_check check (not (assigned_to is not null and assigned_employee_id is not null))
);

-- Piste d'audit plateforme (espace super admin) : distincte de document_audit_log qui est
-- scopée à un document dans un tenant — ici les actions traversent les tenants (ex :
-- suspension d'un tenant par un super admin). Ni actor_id ni target_id n'ont de contrainte
-- FK — même raisonnement que document_audit_log (voir son commentaire juste au-dessus) :
-- une vraie FK ON DELETE (CASCADE ou SET NULL) déclenche une cascade UPDATE/DELETE sur ces
-- lignes, bloquée par le trigger immuable ci-dessous, ce qui empêcherait la suppression de
-- tout tenant/utilisateur ayant déjà une action journalisée à son nom (bug réel rencontré en
-- développant cette table, avant de la corriger comme ceci).
create table super_admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  details     jsonb,
  created_at  timestamptz not null default now()
);

-- Un instantané par tenant par jour des métriques du dashboard (voir GET /api/dashboard/stats,
-- computeTenantMetrics dans routes/dashboard.js), écrit uniquement par dashboardSnapshotJob.js
-- (tous les jours à 3h) — jamais par la route elle-même, pour éviter toute course entre
-- plusieurs chargements simultanés du dashboard. metrics en jsonb (un blob, pas une colonne
-- par métrique) : un nouveau widget n'a jamais besoin d'une migration pour être suivi dans le
-- temps. Comparé à l'instantané le plus proche d'il y a 30 jours pour calculer les tendances
-- affichées ("↑3 vs le mois dernier") — tenant entier uniquement, jamais par service.
create table dashboard_metric_snapshots (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants (id) on delete cascade,
  snapshot_date date not null,
  metrics       jsonb not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, snapshot_date)
);

-- Visibilité du menu par rôle et par utilisateur — purement additif, absence de ligne = menu
-- complet inchangé pour tout le monde (comportement actuel). role_hidden_items :
-- {"member": ["suppliers"], "manager": []} = sections retirées PAR DÉFAUT pour ce rôle.
-- user_overrides : {"<userId>": {"suppliers": true}} = exception pour CET utilisateur précis,
-- prioritaire sur la règle de son rôle (true = forcer visible, false = forcer masqué). Un admin
-- voit toujours tout : ce réglage ne s'applique jamais au rôle admin (voir GET /api/tenant/menu),
-- pour qu'aucune combinaison de règles ne puisse jamais cacher Paramètres > Visibilité à
-- celui/celle qui doit pouvoir la corriger.
create table tenant_menu_settings (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null unique references tenants (id) on delete cascade,
  role_hidden_items  jsonb not null default '{}'::jsonb,
  user_overrides     jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Stockage alternatif Google Drive, par tenant — purement additif, n'affecte aucun tenant
-- existant. Absence de ligne = 'supabase' (comportement actuel inchangé, valeur par défaut de
-- la colonne) ; seuls les tenants qui activent explicitement Google Drive ont une ligne ici.
create table tenant_storage_settings (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null unique references tenants (id) on delete cascade,
  storage_provider  text not null default 'supabase' check (storage_provider in ('supabase', 'google_drive')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Connexion Google Drive OAuth d'un tenant : compte Google connecté, dossier racine "QMS SaaS"
-- créé dans son Drive, et mapping catégorie de documents -> sous-dossier Drive. access_token et
-- refresh_token sont chiffrés applicativement avant d'être écrits ici (voir le service dédié à
-- l'implémentation OAuth) — jamais en clair en base malgré le type text.
create table google_drive_connections (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null unique references tenants (id) on delete cascade,
  google_email         text not null,
  access_token         text not null,
  refresh_token        text not null,
  token_expires_at     timestamptz not null,
  root_folder_id       text not null,
  category_folder_ids  jsonb not null default '{}'::jsonb,
  connected_by         uuid references users (id) on delete set null,
  -- false après un "Déconnecter" côté app : la ligne (et le refresh_token) est GARDÉE plutôt que
  -- supprimée, pour que les documents déjà stockés sur Drive (storage_provider='google_drive')
  -- restent résolvables/téléchargeables indéfiniment — seules /status, /health et /activate
  -- filtrent sur is_active=true (un tenant déconnecté doit repasser par un vrai consentement
  -- OAuth pour reconnecter, jamais une simple réactivation d'un token oublié).
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
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

-- Même pattern que auth_tenant_id() ci-dessus, pour les policies RLS réservées au super
-- admin (super_admin_audit_log). coalesce(..., false) : un utilisateur non authentifié
-- (auth.uid() = null) ne doit jamais se résoudre en erreur mais en "pas super admin".
create or replace function auth_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_super_admin from public.users where id = auth.uid()), false);
$$;

-- =============================================================================
-- INDEX
-- =============================================================================

create index idx_users_tenant_id on users (tenant_id);

create index idx_employees_tenant_id on employees (tenant_id);

create index idx_tasks_tenant_id on tasks (tenant_id);
create index idx_tasks_due_date on tasks (due_date);
create index idx_tasks_assigned_to on tasks (assigned_to);
create index idx_tasks_assigned_employee_id on tasks (assigned_employee_id);

create index idx_document_categories_tenant_id on document_categories (tenant_id);

create index idx_documents_tenant_id on documents (tenant_id);
create index idx_documents_category_id on documents (category_id);
create index idx_documents_status on documents (status);
create index idx_documents_title_trgm on documents using gin (title gin_trgm_ops);
create index idx_documents_search_vector on documents using gin (search_vector);

create index idx_document_versions_document_id on document_versions (document_id);
create index idx_document_versions_tenant_id on document_versions (tenant_id);

create index idx_services_tenant_id on services (tenant_id);

create index idx_user_services_tenant_id on user_services (tenant_id);
create index idx_user_services_user_id on user_services (user_id);
create index idx_user_services_service_id on user_services (service_id);

create index idx_capas_tenant_id on capas (tenant_id);
create index idx_capas_status on capas (status);
create index idx_capas_assigned_to on capas (assigned_to);
create index idx_capas_ref_document on capas (ref_document);
create index idx_capas_due_date on capas (due_date);
create index idx_capas_service_id on capas (service_id);

create index idx_audits_tenant_id on audits (tenant_id);
create index idx_audits_status on audits (status);
create index idx_audits_planned_date on audits (planned_date);
create index idx_audits_service_id on audits (service_id);

create index idx_audit_findings_tenant_id on audit_findings (tenant_id);
create index idx_audit_findings_audit_id on audit_findings (audit_id);

create index idx_management_reviews_tenant_id on management_reviews (tenant_id);
create index idx_management_reviews_review_date on management_reviews (review_date);

create index idx_management_review_actions_tenant_id on management_review_actions (tenant_id);
create index idx_management_review_actions_review_id on management_review_actions (review_id);

create index idx_complaints_tenant_id on complaints (tenant_id);
create index idx_complaints_status on complaints (status);
create index idx_complaints_assigned_to on complaints (assigned_to);
create index idx_complaints_due_date on complaints (due_date);
create index idx_complaints_service_id on complaints (service_id);

create index idx_risks_tenant_id on risks (tenant_id);
create index idx_risks_status on risks (status);
create index idx_risks_service_id on risks (service_id);
create index idx_risks_review_date on risks (review_date);
create index idx_risks_score on risks (risk_score);

create index idx_haccp_plans_tenant_id on haccp_plans (tenant_id);
create index idx_haccp_plans_status on haccp_plans (status);
create index idx_haccp_plans_service_id on haccp_plans (service_id);

create index idx_haccp_process_steps_tenant_id on haccp_process_steps (tenant_id);
create index idx_haccp_process_steps_plan_id on haccp_process_steps (plan_id);

create index idx_haccp_hazards_tenant_id on haccp_hazards (tenant_id);
create index idx_haccp_hazards_step_id on haccp_hazards (step_id);

create index idx_haccp_ccps_tenant_id on haccp_ccps (tenant_id);
create index idx_haccp_ccps_hazard_id on haccp_ccps (hazard_id);

create index idx_haccp_monitoring_logs_tenant_id on haccp_monitoring_logs (tenant_id);
create index idx_haccp_monitoring_logs_ccp_id on haccp_monitoring_logs (ccp_id);
create index idx_haccp_monitoring_logs_recorded_at on haccp_monitoring_logs (recorded_at);

create index idx_suppliers_tenant_id on suppliers (tenant_id);
create index idx_suppliers_status on suppliers (status);
create index idx_suppliers_service_id on suppliers (service_id);
create index idx_suppliers_next_evaluation_date on suppliers (next_evaluation_date);

create index idx_supplier_evaluations_tenant_id on supplier_evaluations (tenant_id);
create index idx_supplier_evaluations_supplier_id on supplier_evaluations (supplier_id);

create index idx_capa_comments_tenant_id on capa_comments (tenant_id);
create index idx_capa_comments_capa_id on capa_comments (capa_id);

create index idx_qqoqccp_analyses_tenant_id on qqoqccp_analyses (tenant_id);

create index idx_trainings_tenant_id on trainings (tenant_id);

create index idx_training_records_tenant_id on training_records (tenant_id);
create index idx_training_records_training_id on training_records (training_id);
create index idx_training_records_user_id on training_records (user_id);
create index idx_training_records_employee_id on training_records (employee_id);
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

create index idx_document_acknowledgments_tenant_id on document_acknowledgments (tenant_id);
create index idx_document_acknowledgments_document_id on document_acknowledgments (document_id);

create index idx_procedures_tenant_id on procedures (tenant_id);
create index idx_procedure_versions_tenant_id on procedure_versions (tenant_id);
create index idx_procedure_versions_procedure_id on procedure_versions (procedure_id);
create index idx_procedure_versions_search_vector on procedure_versions using gin (search_vector);
create index idx_procedure_templates_tenant_id on procedure_templates (tenant_id);

create index idx_procedure_generation_jobs_tenant_id on procedure_generation_jobs (tenant_id);
create index idx_procedure_generation_jobs_tenant_created_at on procedure_generation_jobs (tenant_id, created_at);

create index idx_procedure_acknowledgments_tenant_id on procedure_acknowledgments (tenant_id);
create index idx_procedure_acknowledgments_procedure_version_id on procedure_acknowledgments (procedure_version_id);
create index idx_procedure_capa_links_tenant_id on procedure_capa_links (tenant_id);
create index idx_procedure_capa_links_procedure_id on procedure_capa_links (procedure_id);
create index idx_procedure_capa_links_capa_id on procedure_capa_links (capa_id);
create index idx_procedure_audit_links_tenant_id on procedure_audit_links (tenant_id);
create index idx_procedure_audit_links_procedure_id on procedure_audit_links (procedure_id);
create index idx_procedure_audit_links_audit_id on procedure_audit_links (audit_id);

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

create index idx_super_admin_audit_log_created_at on super_admin_audit_log (created_at desc);
create index idx_super_admin_audit_log_target on super_admin_audit_log (target_type, target_id);

create index idx_dashboard_metric_snapshots_tenant_date on dashboard_metric_snapshots (tenant_id, snapshot_date desc);

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

-- Même principe que documents_search_vector_update ci-dessus, mais construit depuis le
-- contenu jsonb d'une version plutôt que des colonnes texte : objet/domaine
-- d'application/responsabilités concaténés au texte de chaque section du gabarit
-- (content->'sections', tableau de {key,label,content}).
create or replace function procedure_versions_search_vector_update()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector(
    'french',
    coalesce(new.content->>'objet', '') || ' ' ||
    coalesce(new.content->>'domaine_application', '') || ' ' ||
    coalesce(new.content->>'responsabilites', '') || ' ' ||
    coalesce(
      (select string_agg(section->>'content', ' ') from jsonb_array_elements(coalesce(new.content->'sections', '[]'::jsonb)) as section),
      ''
    )
  );
  return new;
end;
$$;

create trigger trg_procedure_versions_search_vector before insert or update on procedure_versions
  for each row execute function procedure_versions_search_vector_update();

create trigger trg_capas_updated_at before update on capas
  for each row execute function set_updated_at();

create trigger trg_audits_updated_at before update on audits
  for each row execute function set_updated_at();

create trigger trg_audit_findings_updated_at before update on audit_findings
  for each row execute function set_updated_at();

create trigger trg_management_reviews_updated_at before update on management_reviews
  for each row execute function set_updated_at();

create trigger trg_management_review_actions_updated_at before update on management_review_actions
  for each row execute function set_updated_at();

create trigger trg_complaints_updated_at before update on complaints
  for each row execute function set_updated_at();

create trigger trg_risks_updated_at before update on risks
  for each row execute function set_updated_at();

create trigger trg_haccp_plans_updated_at before update on haccp_plans
  for each row execute function set_updated_at();

create trigger trg_haccp_process_steps_updated_at before update on haccp_process_steps
  for each row execute function set_updated_at();

create trigger trg_haccp_hazards_updated_at before update on haccp_hazards
  for each row execute function set_updated_at();

create trigger trg_haccp_ccps_updated_at before update on haccp_ccps
  for each row execute function set_updated_at();

create trigger trg_suppliers_updated_at before update on suppliers
  for each row execute function set_updated_at();

create trigger trg_trainings_updated_at before update on trainings
  for each row execute function set_updated_at();

create trigger trg_tasks_updated_at before update on tasks
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

-- Même garantie d'immuabilité que document_audit_log, pour la même raison : une piste
-- d'audit qui peut être modifiée après coup n'en est plus une.
create or replace function super_admin_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'super_admin_audit_log est immuable : aucune modification ni suppression autorisée.';
end;
$$;

create trigger trg_super_admin_audit_log_immutable
  before update or delete on super_admin_audit_log
  for each row execute function super_admin_audit_log_immutable();

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

create trigger trg_tenant_menu_settings_updated_at before update on tenant_menu_settings
  for each row execute function set_updated_at();

create trigger trg_tenant_storage_settings_updated_at before update on tenant_storage_settings
  for each row execute function set_updated_at();

create trigger trg_google_drive_connections_updated_at before update on google_drive_connections
  for each row execute function set_updated_at();

create trigger trg_categories_updated_at before update on categories
  for each row execute function set_updated_at();

create trigger trg_procedures_updated_at before update on procedures
  for each row execute function set_updated_at();

create trigger trg_procedure_versions_updated_at before update on procedure_versions
  for each row execute function set_updated_at();

create trigger trg_procedure_templates_updated_at before update on procedure_templates
  for each row execute function set_updated_at();

create trigger trg_procedure_generation_jobs_updated_at before update on procedure_generation_jobs
  for each row execute function set_updated_at();

-- =============================================================================
-- RECHERCHE
-- =============================================================================

-- Recherche plein texte sur les documents : classement par pertinence (ts_rank),
-- extrait mis en évidence (ts_headline), et localisation de la correspondance
-- (titre vs contenu) pour l'indicateur visuel côté frontend.
--
-- p_user_id / p_user_role (obligatoires, pas de valeur par défaut) appliquent les
-- permissions granulaires du Chantier 4 : un document dans une catégorie restreinte
-- (is_restricted) n'apparaît dans les résultats que si l'appelant est admin, ou
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

-- Utilisée par GET /api/procedures?search= (routes/procedures.js) : renvoie les id de
-- procédures dont le numéro/titre correspond (ilike, comportement inchangé) OU dont le
-- CONTENU DE LA VERSION COURANTE correspond (plein texte, procedure_versions.search_vector) —
-- jamais l'historique complet, une procédure n'est cherchée qu'à travers ce qui fait foi
-- aujourd'hui. Le résultat n'est qu'une liste d'id : le tri, l'embed current_version et les
-- filtres statut/processus restent gérés par le query builder Supabase côté route, comme
-- avant l'ajout de cette fonction.
create or replace function search_procedure_ids(p_tenant_id uuid, p_query text)
returns table (id uuid)
language sql
stable
as $$
  select p.id
  from procedures p
  left join procedure_versions pv on pv.id = p.current_version_id
  where p.tenant_id = p_tenant_id
    and (
      p.number ilike '%' || p_query || '%'
      or p.title ilike '%' || p_query || '%'
      or (pv.search_vector is not null and pv.search_vector @@ websearch_to_tsquery('french', p_query))
    );
$$;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================

alter table tenants enable row level security;
alter table users enable row level security;
alter table employees enable row level security;
alter table tasks enable row level security;
alter table document_categories enable row level security;
alter table documents enable row level security;
alter table document_versions enable row level security;
alter table services enable row level security;
alter table user_services enable row level security;
alter table capas enable row level security;
alter table capa_counters enable row level security;
alter table capa_priority_delays enable row level security;
alter table capa_comments enable row level security;
alter table qqoqccp_analyses enable row level security;
alter table audits enable row level security;
alter table audit_findings enable row level security;
alter table management_reviews enable row level security;
alter table management_review_actions enable row level security;
alter table complaints enable row level security;
alter table risks enable row level security;
alter table haccp_plans enable row level security;
alter table haccp_process_steps enable row level security;
alter table haccp_hazards enable row level security;
alter table haccp_ccps enable row level security;
alter table haccp_monitoring_logs enable row level security;
alter table suppliers enable row level security;
alter table supplier_evaluations enable row level security;
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
alter table document_acknowledgments enable row level security;
alter table procedures enable row level security;
alter table procedure_versions enable row level security;
alter table procedure_templates enable row level security;
alter table procedure_generation_jobs enable row level security;
alter table procedure_acknowledgments enable row level security;
alter table procedure_capa_links enable row level security;
alter table procedure_audit_links enable row level security;
alter table user_notification_preferences enable row level security;
alter table notification_log enable row level security;
alter table notifications enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table category_permissions enable row level security;
alter table super_admin_audit_log enable row level security;
alter table dashboard_metric_snapshots enable row level security;
alter table record_shares enable row level security;
alter table categories enable row level security;
alter table generic_category_permissions enable row level security;
alter table tenant_menu_settings enable row level security;
alter table tenant_storage_settings enable row level security;
alter table google_drive_connections enable row level security;

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

create policy employees_isolation on employees
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy tasks_isolation on tasks
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

create policy services_isolation on services
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy user_services_isolation on user_services
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

create policy audits_isolation on audits
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy audit_findings_isolation on audit_findings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy management_reviews_isolation on management_reviews
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy management_review_actions_isolation on management_review_actions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy complaints_isolation on complaints
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy risks_isolation on risks
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_plans_isolation on haccp_plans
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_process_steps_isolation on haccp_process_steps
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_hazards_isolation on haccp_hazards
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_ccps_isolation on haccp_ccps
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy haccp_monitoring_logs_isolation on haccp_monitoring_logs
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy suppliers_isolation on suppliers
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy supplier_evaluations_isolation on supplier_evaluations
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

create policy document_acknowledgments_isolation on document_acknowledgments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

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

create policy procedure_generation_jobs_isolation on procedure_generation_jobs
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_acknowledgments_isolation on procedure_acknowledgments
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_capa_links_isolation on procedure_capa_links
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy procedure_audit_links_isolation on procedure_audit_links
  for all
  using (tenant_id = auth_tenant_id())
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

create policy categories_isolation on categories
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy generic_category_permissions_isolation on generic_category_permissions
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

-- Pas de tenant_id sur cette table (elle traverse volontairement les tenants) : l'isolation
-- passe par auth_is_super_admin() plutôt que par auth_tenant_id() comme partout ailleurs.
create policy super_admin_audit_log_select on super_admin_audit_log
  for select
  using (auth_is_super_admin());

create policy super_admin_audit_log_insert on super_admin_audit_log
  for insert
  with check (auth_is_super_admin());

create policy dashboard_metric_snapshots_isolation on dashboard_metric_snapshots
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy record_shares_isolation on record_shares
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy tenant_menu_settings_isolation on tenant_menu_settings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy tenant_storage_settings_isolation on tenant_storage_settings
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());

create policy google_drive_connections_isolation on google_drive_connections
  for all
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
