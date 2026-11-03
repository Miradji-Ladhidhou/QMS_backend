-- The previous schema only understood Drive file IDs. Do not reinterpret Supabase object
-- paths as Drive IDs when rolling back.
update procedure_versions
set attachment_file_path = null, attachment_file_name = null
where attachment_storage_provider is distinct from 'google_drive';

alter table procedure_versions
  drop column if exists attachment_storage_provider;

alter table procedure_versions
  rename column attachment_file_path to attachment_drive_file_id;
