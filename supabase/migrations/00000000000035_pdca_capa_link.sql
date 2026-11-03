-- Lien bidirectionnel PDCA <-> CAPA, sur le même principe que accidents/risks/complaints/etc :
-- un projet PDCA peut donner lieu à une CAPA formelle depuis sa conclusion (étape Act).

alter table pdca_projects add column if not exists linked_capa_id uuid references capas (id) on delete set null;
alter table capas add column if not exists pdca_project_id uuid references pdca_projects (id) on delete set null;
