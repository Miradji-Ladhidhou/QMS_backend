drop index if exists idx_procedures_source_document_id;

alter table procedures
  drop column if exists source_document_id;
