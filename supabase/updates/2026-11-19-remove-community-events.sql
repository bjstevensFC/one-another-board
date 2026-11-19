-- Update: remove the Community Events post type from the board.
-- Event posts can no longer be created. (Postgres can't delete a post type, so the
-- unused "event" value and event_date column stay in the database, doing nothing.)
-- Run once in Supabase → SQL Editor (safe to run again).

-- Hide any event posts that were already made.
update public.posts set status = 'rejected' where kind::text = 'event' and status <> 'rejected';

drop view if exists public.board_posts;
create view public.board_posts as
select
  p.id, p.kind, p.title, p.body, p.category, p.trade, p.area, p.rate,
  p.status, p.created_at, p.expires_at, p.hide_name, p.website,
  (p.expires_at <= now()) as expired,
  (p.author_id = auth.uid()) as is_mine,
  case
    when p.hide_name and p.author_id is distinct from auth.uid() and not public.is_moderator() then null
    else pr.display_name
  end as author_name,
  -- Contact details only for signed-in people
  case when auth.uid() is not null then p.contact end as contact,
  (select count(*) from public.prayers x where x.post_id = p.id)::int as prayer_count,
  exists (select 1 from public.prayers x where x.post_id = p.id and x.user_id = auth.uid()) as i_prayed,
  exists (select 1 from public.reports r where r.post_id = p.id and r.user_id = auth.uid()) as i_reported,
  case when public.is_moderator()
       then (select count(*) from public.reports r where r.post_id = p.id)::int end as report_count,
  -- Others see a testimony only once a moderator approves it
  case when p.testimony_status = 'approved' or p.author_id = auth.uid() or public.is_moderator()
       then p.testimony end as testimony,
  case when p.testimony_status = 'approved' or p.author_id = auth.uid() or public.is_moderator()
       then p.testimony_status end as testimony_status,
  case when p.author_id = auth.uid() or public.is_moderator() then p.testimony_share end as testimony_share
from public.posts p
join public.profiles pr on pr.id = p.author_id
where (p.status in ('open', 'closed') and p.expires_at > now())
   or p.author_id = auth.uid()
   or public.is_moderator();

-- The view runs with its owner's rights and applies the rules above itself.
grant select on public.board_posts to anon, authenticated;

drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean, text);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz);
drop function if exists public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz, date);

create or replace function public.create_post(
  p_kind text, p_title text, p_body text default '',
  p_category text default null, p_trade text default null, p_area text default null,
  p_rate text default null, p_contact text default null, p_hide_name boolean default false,
  p_website text default null, p_expires_at timestamptz default null,
  p_event_date date default null  -- no longer used; still accepted so older copies of the site keep working
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
  if p_kind not in ('prayer', 'need', 'skill', 'free') then
    raise exception 'Unknown post type.';
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
  if p_kind = 'need' and public.clean(p_contact) is null then
    raise exception 'Add a phone number or email so people can reach you about this need.';
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

revoke execute on function public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz, date) from public, anon;
grant execute on function public.create_post(text, text, text, text, text, text, text, text, boolean, text, timestamptz, date) to authenticated;
