alter table tenants
  drop column if exists company_legal_mentions,
  drop column if exists company_phone,
  drop column if exists company_address;
