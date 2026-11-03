-- Preserve the document that an existing procedure was migrated from. The document remains
-- the owner of its original file; deleting it leaves the procedure intact and clears this link.
alter table procedures
  add column source_document_id uuid references documents (id) on delete set null;

create unique index idx_procedures_source_document_id
  on procedures (tenant_id, source_document_id)
  where source_document_id is not null;
