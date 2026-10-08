alter table qms_evidence_attachments
  drop constraint if exists qms_evidence_attachments_module_key_check;

alter table qms_evidence_attachments
  add constraint qms_evidence_attachments_module_key_check
  check (module_key in (
    'accidents',
    'nonconforming-outputs',
    'audits',
    'complaints',
    'capas',
    'haccp',
    'suppliers',
    'supplier-evaluations',
    'risks',
    'pdca',
    'qqoqccp'
  ));
