-- Ajoute ai_call_failures : journal des appels IA (Groq) en échec, par tenant et par
-- fonctionnalité — jusqu'ici un échec IA ne partait qu'en console.error (voir services/groq.js),
-- invisible nulle part dans l'app. Un tenant qui dit "l'IA ne marche pas" ne pouvait pas être
-- diagnostiqué sans lui demander de reproduire devant vous. Voir GET /api/super-admin/ai-failures
-- et SystemTab côté frontend.
--
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Idempotent : chaque étape vérifie si elle a déjà été appliquée.

begin;

create table if not exists ai_call_failures (
  id          uuid primary key default gen_random_uuid(),
  -- Pas de FK vers tenants (même raisonnement que super_admin_audit_log.actor_id/target_id,
  -- voir schema.sql) : une ligne journalisée ici ne doit jamais bloquer ni compliquer la
  -- suppression d'un tenant.
  tenant_id   uuid,
  feature     text not null,
  category    text not null check (category in ('rate_limit', 'auth', 'timeout', 'network', 'empty_response', 'malformed_response', 'unexpected')),
  message     text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_ai_call_failures_created_at on ai_call_failures (created_at desc);
create index if not exists idx_ai_call_failures_tenant_id on ai_call_failures (tenant_id, created_at desc);

alter table ai_call_failures enable row level security;

-- Seul le backend (clé service_role, qui contourne RLS) écrit dans cette table.
drop policy if exists ai_call_failures_select on ai_call_failures;
create policy ai_call_failures_select on ai_call_failures
  for select
  using (auth_is_super_admin());

commit;
