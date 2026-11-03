-- Let procedure versions use the tenant's configured document provider. Existing Drive
-- references keep their provider explicitly; Supabase Storage attachments use null.
alter table procedure_versions
  rename column attachment_drive_file_id to attachment_file_path;

alter table procedure_versions
  add column attachment_storage_provider text;

update procedure_versions
set attachment_storage_provider = 'google_drive'
where attachment_file_path is not null;
