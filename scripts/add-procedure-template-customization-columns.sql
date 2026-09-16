-- Ajoute accent_color/visual_options à procedure_templates (refonte de la mise en page des
-- procédures — personnalisation directe par tenant, remplace les 4 presets figés) — à exécuter
-- une seule fois sur la base de production (Supabase SQL Editor, ou psql avec DATABASE_URL_PROD).
-- Déjà appliqué sur la base locale de dev/tests par Claude ; ce script n'est nécessaire que pour
-- la prod, non joignable depuis cet environnement (pas de route réseau vers
-- db.<projet>.supabase.co).
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.
--
-- Profite du passage pour combler un décalage déjà constaté entre schema.sql et l'historique
-- de migrations réel (supabase/migrations/) : render_style/active_preset_id/fixed_instructions
-- sont documentées dans schema.sql et déjà utilisées par le code, mais n'apparaissent dans
-- aucun fichier sous supabase/migrations/ — IF NOT EXISTS les recrée sans risque si elles
-- manquaient vraiment en prod, et ne fait rien si elles existent déjà.

begin;

alter table procedure_templates
  add column if not exists render_style       jsonb,
  add column if not exists active_preset_id   text,
  add column if not exists fixed_instructions text;

alter table procedure_templates
  add column if not exists accent_color    text not null default '#44546A',
  add column if not exists visual_options  jsonb not null default '{"band": false, "bulletStyle": "dash", "calloutStyle": "left-border"}'::jsonb;

commit;
