-- Update: email moderators whenever someone finishes creating an account
-- (when their email address is confirmed, or right away if no confirmation is needed).
-- Needs the review alerts update (2026-11-13-review-alerts.sql) to be set up first.
-- Run once in Supabase → SQL Editor (safe to run again).

create or replace function public.alert_new_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is not null
     and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    perform public.notify_moderators(
      'New account on the board: ' || coalesce(new.email, 'unknown email'),
      'Someone just created an account on the board.',
      'Email: ' || coalesce(new.email, 'unknown') ||
      E'\n\nThey''ll choose the name shown on their posts the first time they sign in.'
    );
  end if;
  return new;
exception when others then
  -- Never block someone from creating an account because an alert failed.
  raise warning 'New account alert failed: %', sqlerrm;
  return new;
end $$;

revoke execute on function public.alert_new_account() from public, anon, authenticated;

drop trigger if exists users_new_account_alert on auth.users;
create trigger users_new_account_alert
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.alert_new_account();
