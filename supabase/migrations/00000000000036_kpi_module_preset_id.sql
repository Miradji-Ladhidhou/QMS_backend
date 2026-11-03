-- Relie chaque KPI calcule depuis un module a son preset catalogue.
-- Necessaire pour l'aperçu /api/kpis/module-overview et le recalcul des indicateurs modules.

alter table kpis add column if not exists module_preset_id text;

create index if not exists idx_kpis_module_preset_id
  on kpis (tenant_id, module_preset_id)
  where module_preset_id is not null;

notify pgrst, 'reload schema';
