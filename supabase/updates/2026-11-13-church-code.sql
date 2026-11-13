-- Update: require a church code to create a new account.
-- Run once in Supabase → SQL Editor (safe to run again). Then turn on the check:
--   Authentication → Auth Hooks → Add hook → "Before User Created"
--   → Postgres → schema "public" → function "hook_before_user_created".
-- Existing accounts are never asked for the code. Moderators can change it
-- from the board's Review tab.

-- The current code (one row only).
create table if not exists public.signup_settings (
  id         int primary key default 1 check (id = 1),
  code       text not null check (char_length(btrim(code)) between 4 and 40),
  updated_at timestamptz not null default now()
);
alter table public.signup_settings enable row level security;
revoke all on public.signup_settings from anon, authenticated;
insert into public.signup_settings (id, code) values (1, 'ONEANOTHER') on conflict (id) do nothing;

-- Supabase calls this before creating any new account. The board sends the code
-- people typed as "church_code" in the sign-up data. Letter case and spaces at
-- the ends don't matter.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  expected text;
  given text;
begin
  select btrim(code) into expected from public.signup_settings where id = 1;
  if expected is null or expected = '' then
    return '{}'::jsonb;  -- no code set: allow sign-ups
  end if;
  given := btrim(coalesce(event -> 'user' -> 'user_metadata' ->> 'church_code', ''));
  if lower(given) = lower(expected) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', case when given = ''
      then 'Enter the church code to create an account.'
      else 'That church code doesn''t match. Ask at church for the current code.' end
  ));
end $$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

-- Moderators can see and change the code from the Review tab.
create or replace function public.get_signup_code()
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'Moderators only.'; end if;
  return (select code from public.signup_settings where id = 1);
end $$;

create or replace function public.set_signup_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'Moderators only.'; end if;
  if char_length(btrim(coalesce(p_code, ''))) not between 4 and 40 then
    raise exception 'Use a code between 4 and 40 characters.';
  end if;
  insert into public.signup_settings (id, code, updated_at) values (1, btrim(p_code), now())
  on conflict (id) do update set code = excluded.code, updated_at = now();
end $$;

revoke execute on function public.get_signup_code(), public.set_signup_code(text) from public, anon;
grant execute on function public.get_signup_code(), public.set_signup_code(text) to authenticated;
