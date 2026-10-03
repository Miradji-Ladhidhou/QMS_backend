-- HACCP dossier, explicit control decisions, CCP validation state, and structured drift records.
-- Idempotent; safe to apply repeatedly. Existing CCPs remain operational as legacy records without
-- inventing any approval history. Existing monitoring logs retain their original data only.
begin;

alter table haccp_plans add column if not exists prerequisites text;
alter table haccp_plans add column if not exists intended_use text;
alter table haccp_plans add column if not exists consumer_groups text;
alter table haccp_plans add column if not exists product_characteristics text;
alter table haccp_plans add column if not exists flow_diagram_reference text;
alter table haccp_plans add column if not exists flow_diagram_verification text;
alter table haccp_plans add column if not exists no_ccp_justification text;
alter table haccp_plans add column if not exists validation_review_notes text;
alter table haccp_plans add column if not exists verification_review_notes text;

alter table haccp_hazards add column if not exists control_type text not null default 'undetermined';
alter table haccp_hazards add column if not exists decision_justification text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'haccp_hazards_control_type_check') then
    alter table haccp_hazards add constraint haccp_hazards_control_type_check
      check (control_type in ('undetermined', 'prp', 'ccp', 'process_change'));
  end if;
end $$;
update haccp_hazards h
set control_type = 'ccp'
where h.control_type = 'undetermined'
  and exists (select 1 from haccp_ccps c where c.hazard_id = h.id and c.tenant_id = h.tenant_id);

alter table haccp_ccps alter column critical_limits drop not null;
alter table haccp_ccps alter column monitoring_procedure drop not null;
alter table haccp_ccps add column if not exists status text not null default 'legacy';
alter table haccp_ccps add column if not exists validation_source text;
alter table haccp_ccps add column if not exists validation_evidence text;
alter table haccp_ccps add column if not exists approved_by uuid references users (id) on delete set null;
alter table haccp_ccps add column if not exists approved_at timestamptz;
alter table haccp_ccps add column if not exists ai_generated boolean not null default false;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'haccp_ccps_status_check') then
    alter table haccp_ccps add constraint haccp_ccps_status_check check (status in ('draft', 'approved', 'legacy'));
  end if;
end $$;
alter table haccp_ccps alter column status set default 'draft';

alter table haccp_monitoring_logs add column if not exists lot_reference text;
alter table haccp_monitoring_logs add column if not exists product_disposition text;
alter table haccp_monitoring_logs add column if not exists disposition_decision text;
alter table haccp_monitoring_logs add column if not exists return_to_control text;
alter table haccp_monitoring_logs add column if not exists effectiveness_verification text;

create or replace function haccp_create_ccp_draft(
  p_tenant_id uuid,
  p_hazard_id uuid,
  p_decision_justification text,
  p_ccp jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_hazard_id uuid;
  v_ccp jsonb;
begin
  select id into v_hazard_id
  from haccp_hazards
  where id = p_hazard_id and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'HAZARD_NOT_FOUND';
  end if;

  if exists (
    select 1 from haccp_ccps
    where tenant_id = p_tenant_id and hazard_id = p_hazard_id
  ) then
    raise exception 'CCP_EXISTS';
  end if;

  insert into haccp_ccps (
    tenant_id, hazard_id, ccp_number, critical_limits, status, ai_generated,
    monitoring_procedure, monitoring_frequency, monitoring_responsible,
    corrective_action_procedure, verification_procedure, verification_frequency,
    record_keeping_procedure, limit_min, limit_max, limit_unit, monitoring_interval_hours
  ) values (
    p_tenant_id, p_hazard_id, nullif(p_ccp->>'ccp_number', ''), nullif(p_ccp->>'critical_limits', ''),
    'draft', coalesce((p_ccp->>'ai_generated')::boolean, true),
    nullif(p_ccp->>'monitoring_procedure', ''), nullif(p_ccp->>'monitoring_frequency', ''),
    nullif(p_ccp->>'monitoring_responsible', '')::uuid,
    nullif(p_ccp->>'corrective_action_procedure', ''), nullif(p_ccp->>'verification_procedure', ''),
    nullif(p_ccp->>'verification_frequency', ''), nullif(p_ccp->>'record_keeping_procedure', ''),
    nullif(p_ccp->>'limit_min', '')::numeric, nullif(p_ccp->>'limit_max', '')::numeric,
    nullif(p_ccp->>'limit_unit', ''), nullif(p_ccp->>'monitoring_interval_hours', '')::numeric
  )
  returning to_jsonb(haccp_ccps.*) into v_ccp;

  update haccp_hazards
  set control_type = 'ccp', decision_justification = p_decision_justification, updated_at = now()
  where id = p_hazard_id and tenant_id = p_tenant_id;

  return v_ccp;
end;
$$;
revoke all on function haccp_create_ccp_draft(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function haccp_create_ccp_draft(uuid, uuid, text, jsonb) to service_role;

commit;
notify pgrst, 'reload schema';
