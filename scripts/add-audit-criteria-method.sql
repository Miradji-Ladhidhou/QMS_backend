-- Renforce la preuve d'audit interne (ISO 9001 §9.2) sans créer de nouveau module.
alter table audits add column if not exists criteria text;
alter table audits add column if not exists method text;

notify pgrst, 'reload schema';
