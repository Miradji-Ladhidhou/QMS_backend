begin;

alter table nonconforming_outputs
  add column if not exists lot_reference text,
  add column if not exists containment_action text,
  add column if not exists assigned_to uuid references users (id) on delete set null;

commit;
notify pgrst, 'reload schema';
