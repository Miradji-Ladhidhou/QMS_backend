-- Imported procedures were incorrectly marked as having an effective version before
-- their first approval. Remove that pointer and any acknowledgments on the unapproved version.
delete from procedure_acknowledgments acknowledgment
using procedures p, procedure_versions v
where p.source_document_id is not null
  and p.current_version_id = v.id
  and acknowledgment.procedure_version_id = v.id
  and v.status <> 'approved';

update procedures p
set current_version_id = null
from procedure_versions v
where p.source_document_id is not null
  and p.current_version_id = v.id
  and v.status <> 'approved';
