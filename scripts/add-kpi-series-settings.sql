-- Permet à chaque série (courbe) d'un KPI d'avoir sa propre unité, sa cible et son sens
-- d'objectif. Jusqu'ici seuls kpis.unit/target/target_direction existaient : toutes les séries
-- d'un même KPI partageaient donc la même unité et le même objectif, même quand elles ne se
-- mesurent pas pareil (ex. "Commandes conformes" en % et "Délai moyen" en heures).
-- Les trois colonnes sont NULL ensemble = la série reprend les valeurs globales du KPI (cas
-- de toutes les séries existantes, aucun backfill nécessaire) ; renseignées ensemble = série
-- paramétrée à part (l'API impose le tout-ou-rien, voir routes/kpis.js#parseSeriesBody).
-- À exécuter une seule fois sur la base de production (Supabase SQL Editor, ou psql avec
-- DATABASE_URL_PROD). Déjà appliqué sur la base locale de dev/tests par Claude.
--
-- Idempotent : chaque étape vérifie si elle a déjà été appliquée avant de s'exécuter.

begin;

alter table kpi_calculation_configs
  add column if not exists unit             text,
  add column if not exists target           numeric,
  add column if not exists target_direction text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'kpi_calculation_configs_target_direction_check') then
    alter table kpi_calculation_configs
      add constraint kpi_calculation_configs_target_direction_check
      check (target_direction is null or target_direction in ('min', 'max'));
  end if;
end $$;

commit;
