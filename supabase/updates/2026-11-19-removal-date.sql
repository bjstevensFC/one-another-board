-- Update: Needs and Freecycle posts can pick a date to come down sooner than 60 days.
-- Run once in Supabase → SQL Editor (safe to run again).

drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean, text);

create or replace function public.create_post(
  p_kind text, p_title text, p_body text default '',
  p_category text default null, p_trade text default null, p_area text default null,
  p_rate text default null, p_contact text default null, p_hide_name boolean default false,
  p_website text default null, p_expires_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  new_id uuid;
  recent int;
  expires timestamptz := now() + interval '60 days';
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
  if p_kind = 'free' and public.clean(p_contact) is null then
    raise exception 'Add a phone number or email so people can reach you about this item.';
  end if;

  if p_kind = 'skill' and public.clean(p_website) is not null
     and (char_length(btrim(p_website)) > 200 or btrim(p_website) !~* '^https?://[^[:space:]]+$') then
    raise exception 'Enter a full website address starting with https://';
  end if;

  -- Needs and Freecycle posts can come down sooner than 60 days, on a date the author picks.
  if p_kind in ('need', 'free') and p_expires_at is not null then
    if p_expires_at <= now() then
      raise exception 'Choose a removal date that hasn''t passed yet.';
    end if;
    expires := least(p_expires_at, expires);
  end if;

  insert into public.posts (author_id, kind, title, body, category, trade, area, rate, contact, website, hide_name, status, expires_at)
  values (
    uid, p_kind::public.post_kind, btrim(p_title), coalesce(btrim(p_body), ''),
    case when p_kind in ('need', 'free') then public.clean(p_category) end,
    case when p_kind = 'skill' then public.clean(p_trade) end,
    case when p_kind <> 'prayer' then public.clean(p_area) end,
    case when p_kind = 'skill' then public.clean(p_rate) end,
    case when p_kind <> 'prayer' then public.clean(p_contact) end,
    case when p_kind = 'skill' then public.clean(p_website) end,
    case when p_kind = 'prayer' then coalesce(p_hide_name, false) else false end,
    case when public.is_moderator() then 'open'::public.post_status else 'pending'::public.post_status end,
    expires
  ) returning id into new_id;
  return new_id;
end $$;

revoke execute on function public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz) from public, anon;
grant execute on function public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz) to authenticated;
