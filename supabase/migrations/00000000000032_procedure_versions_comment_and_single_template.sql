-- Deux ajustements identifiés en concevant les routes (Prompt 2) :
-- 1. Aucune colonne ne portait le commentaire de rejet ("retour au rédacteur avec commentaire")
--    — comment, même nom que document_approvals.comment.
-- 2. GET/PUT /api/procedure-gabarits (singuliers, sans :id) confirment "un gabarit par tenant" —
--    contrainte unique ajoutée pour l'appliquer réellement, pas seulement par convention.

alter table procedure_versions add column comment text;

alter table procedure_templates add constraint procedure_templates_tenant_id_key unique (tenant_id);
