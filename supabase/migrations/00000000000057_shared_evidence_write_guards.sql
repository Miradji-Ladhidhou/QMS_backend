begin;

-- Evidence references records polymorphically, so FK traversal cannot find this table.
create policy share_api_insert_only on public.qms_evidence_attachments
  as restrictive for insert to anon, authenticated with check (false);
create policy share_api_update_only on public.qms_evidence_attachments
  as restrictive for update to anon, authenticated using (false) with check (false);
create policy share_api_delete_only on public.qms_evidence_attachments
  as restrictive for delete to anon, authenticated using (false);

notify pgrst, 'reload schema';
commit;
