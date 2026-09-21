-- Indicateurs des modules : un KPI de module retient le preset dont il est issu (module_preset_id), pour que la
-- vue « Indicateurs des modules » sache lesquels sont déjà suivis, sans deviner d'après le nom.
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent. Aucune donnée existante n'est modifiée : les KPI de module déjà créés sont rattachés à leur preset
-- automatiquement par l'application (d'après leur nom et leur module), au premier affichage de la vue.

begin;

alter table kpis add column if not exists module_preset_id text;
create index if not exists idx_kpis_module_preset_id on kpis (tenant_id, module_preset_id) where module_preset_id is not null;

commit;

notify pgrst, 'reload schema';
