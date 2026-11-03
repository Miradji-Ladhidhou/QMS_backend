alter table procedure_templates drop constraint if exists procedure_templates_tenant_id_key;
alter table procedure_versions drop column if exists comment;
