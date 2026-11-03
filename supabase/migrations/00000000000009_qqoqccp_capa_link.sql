-- Applique en local, de façon incrémentale, le même changement que schema.sql (backend/) :
-- colonnes de liaison bidirectionnelle entre capas et qqoqccp_analyses. Les deux modules
-- continuent de fonctionner indépendamment (colonnes nullables des deux côtés).

alter table capas add column if not exists qqoqccp_analysis_id uuid references qqoqccp_analyses (id) on delete set null;
alter table qqoqccp_analyses add column if not exists linked_capa_id uuid references capas (id) on delete set null;
