-- Run after platform_settings exists. Limits are local guards, not provider billing data.
begin;
insert into public.platform_settings(key, value) values
  ('groq_limits', '{"requests_minute":30,"requests_day":1000,"tokens_minute":8000,"tokens_day":200000}'::jsonb)
  on conflict (key) do nothing;
create or replace function public.protect_groq_limits()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('postgres', 'service_role', 'supabase_admin')
    and ((tg_op <> 'INSERT' and old.key = 'groq_limits') or (tg_op <> 'DELETE' and new.key = 'groq_limits')) then
    raise exception 'Groq limits can only be changed by the backend' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists protect_groq_limits_setting on public.platform_settings;
create trigger protect_groq_limits_setting before insert or update or delete on public.platform_settings
  for each row execute function public.protect_groq_limits();

create table if not exists public.groq_quota_calls (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  token_budget integer not null check (token_budget > 0),
  tokens integer check (tokens >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists groq_quota_calls_created on public.groq_quota_calls(created_at);
create index if not exists groq_quota_calls_finished on public.groq_quota_calls(finished_at);
alter table public.groq_quota_calls enable row level security;

create or replace function public.groq_quota_snapshot()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_limits jsonb; v_usage jsonb;
begin
  select value into v_limits from platform_settings where key = 'groq_limits';
  if not found then raise exception 'Groq limits setting missing'; end if;
  select jsonb_build_object(
    'requests_minute', count(*) filter (where created_at > now() - interval '1 minute' or finished_at is null),
    'requests_day', count(*) filter (where created_at > now() - interval '24 hours' or finished_at is null),
    'tokens_minute', coalesce(sum(coalesce(tokens, token_budget)) filter (where finished_at > now() - interval '1 minute' or finished_at is null), 0),
    'tokens_day', coalesce(sum(coalesce(tokens, token_budget)) filter (where finished_at > now() - interval '24 hours' or finished_at is null), 0),
    'pending', count(*) filter (where finished_at is null),
    'estimated_calls', count(*) filter (where finished_at is not null and tokens is null and finished_at > now() - interval '24 hours')
  ) into v_usage from groq_quota_calls
    where created_at > now() - interval '24 hours' or finished_at > now() - interval '24 hours' or finished_at is null;
  return jsonb_build_object('limits', v_limits, 'usage', v_usage, 'observed_at', now());
end $$;

create or replace function public.reserve_groq_call(p_model text, p_token_budget integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_snapshot jsonb; v_key text; v_limit bigint; v_amount bigint; v_id uuid;
begin
  if p_token_budget < 1 then raise exception 'Invalid token budget'; end if;
  perform 1 from platform_settings where key = 'groq_limits' for update;
  if not found then raise exception 'Groq limits setting missing'; end if;
  v_snapshot := groq_quota_snapshot();
  foreach v_key in array array['requests_minute', 'requests_day', 'tokens_minute', 'tokens_day'] loop
    v_limit := (v_snapshot->'limits'->>v_key)::bigint;
    v_amount := case when v_key like 'tokens_%' then p_token_budget else 1 end;
    if v_limit is not null and (v_snapshot->'usage'->>v_key)::bigint + v_amount > v_limit then
      return jsonb_build_object('allowed', false, 'scope', v_key, 'quota', v_snapshot);
    end if;
  end loop;
  insert into groq_quota_calls(model, token_budget) values (p_model, p_token_budget) returning id into v_id;
  return jsonb_build_object('allowed', true, 'call_id', v_id);
end $$;

create or replace function public.finish_groq_call(p_call_id uuid, p_tokens integer default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_tokens < 0 then raise exception 'Invalid token usage'; end if;
  update groq_quota_calls set tokens = p_tokens, finished_at = now() where id = p_call_id and finished_at is null;
  if not found and not exists(select 1 from groq_quota_calls where id = p_call_id) then
    raise exception 'Groq reservation missing';
  end if;
end $$;

revoke all on function public.groq_quota_snapshot() from public, anon, authenticated;
revoke all on function public.reserve_groq_call(text, integer) from public, anon, authenticated;
revoke all on function public.finish_groq_call(uuid, integer) from public, anon, authenticated;
grant execute on function public.groq_quota_snapshot() to service_role;
grant execute on function public.reserve_groq_call(text, integer) to service_role;
grant execute on function public.finish_groq_call(uuid, integer) to service_role;
notify pgrst, 'reload schema';
commit;
