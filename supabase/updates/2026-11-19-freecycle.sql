-- Update: add the "Freecycle" post type (free items to give away).
-- Run in Supabase → SQL Editor in TWO steps (Postgres must save a new post type
-- before anything else can use it):
--   Step 1: run only the next line by itself.
--   Step 2: run everything below it.
-- Safe to run again.

alter type public.post_kind add value if not exists 'free';

-- ===== Step 2 starts here =====

-- create_post: Freecycle posts keep a category, a pickup area and an optional contact.
create or replace function public.create_post(
  p_kind text, p_title text, p_body text default '',
  p_category text default null, p_trade text default null, p_area text default null,
  p_rate text default null, p_contact text default null, p_hide_name boolean default false,
  p_website text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  new_id uuid;
  recent int;
begin
  if not exists (select 1 from public.profiles where id = uid) then
    raise exception 'Add your name before posting.';
  end if;
  select count(*) into recent from public.posts where author_id = uid and created_at > now() - interval '1 day';
  if recent >= 5 and not public.is_moderator() then
    raise exception 'You can add up to 5 posts a day. Please try again tomorrow.';
  end if;
  if p_kind = 'skill' and (public.clean(p_trade) is null or public.clean(p_contact) is null) then
    raise exception 'Trade listings need a trade and a way to reach you.';
  end if;
  if p_kind = 'skill' and public.clean(p_website) is not null
     and (char_length(btrim(p_website)) > 200 or btrim(p_website) !~* '^https?://[^[:space:]]+$') then
    raise exception 'Enter a full website address starting with https://';
  end if;

  insert into public.posts (author_id, kind, title, body, category, trade, area, rate, contact, website, hide_name, status)
  values (
    uid, p_kind::public.post_kind, btrim(p_title), coalesce(btrim(p_body), ''),
    case when p_kind in ('need', 'free') then public.clean(p_category) end,
    case when p_kind = 'skill' then public.clean(p_trade) end,
    case when p_kind <> 'prayer' then public.clean(p_area) end,
    case when p_kind = 'skill' then public.clean(p_rate) end,
    case when p_kind <> 'prayer' then public.clean(p_contact) end,
    case when p_kind = 'skill' then public.clean(p_website) end,
    case when p_kind = 'prayer' then coalesce(p_hide_name, false) else false end,
    case when public.is_moderator() then 'open'::public.post_status else 'pending'::public.post_status end
  ) returning id into new_id;
  return new_id;
end $$;

-- Review alert emails: name Freecycle posts correctly.
create or replace function public.alert_new_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  label text := case new.kind::text
    when 'prayer' then 'prayer request'
    when 'need' then 'need'
    when 'free' then 'Freecycle item'
    else 'trade listing' end;
begin
  if new.status = 'pending' then
    perform public.notify_moderators(
      'New ' || label || ' to review: ' || left(new.title, 60),
      'A new ' || label || ' is waiting for your review.',
      new.title || case when coalesce(new.body, '') <> '' then E'\n\n' || left(new.body, 400) else '' end
    );
  end if;
  return new;
end $$;
revoke execute on function public.alert_new_post() from public, anon, authenticated;
