-- Traçabilité : ce risque vient-il d'une suggestion IA acceptée telle quelle (ou modifiée)
-- plutôt que d'une saisie manuelle — même principe que haccp_hazards.ai_generated.
alter table risks add column ai_generated boolean not null default false;
