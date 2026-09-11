-- Suppression du module "Étalonnage" (équipements de mesure) — à exécuter une seule fois sur
-- la base de production (Supabase SQL Editor, ou psql avec DATABASE_URL_PROD). Déjà appliqué
-- sur la base locale de dev/tests par Claude ; ce script n'est nécessaire que pour la prod,
-- non joignable depuis cet environnement (pas de route réseau vers db.<projet>.supabase.co).
--
-- Sans risque de perte si les tables sont vides (cas confirmé en local) ; si des équipements
-- ou étalonnages existent réellement en prod, cette suppression est définitive (drop cascade).

begin;

alter table capas drop column if exists equipment_calibration_id;

alter table categories drop constraint if exists categories_resource_type_check;
alter table categories add constraint categories_resource_type_check check (
  resource_type in (
    'capa', 'complaint', 'qqoqccp', 'supplier', 'training', 'management_review', 'audit', 'risk', 'task', 'kpi',
    'haccp_plan', 'procedure', 'accident', 'pdca', 'nonconforming_output',
    'order_review', 'qms_change', 'customer_satisfaction', 'communication_plan', 'employee'
  )
);

drop table if exists equipment_calibrations cascade;
drop table if exists measuring_equipment cascade;

commit;
