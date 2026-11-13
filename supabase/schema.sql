-- "One Another" Board — database schema for Supabase (Postgres)
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
--
-- Security model
--   * Browsers never touch the tables directly. All table privileges are revoked
--     from the public roles (anon, authenticated).
--   * Reading goes through one view, board_posts, which applies the visibility
--     rules itself (approved, unexpired posts for everyone; your own posts for you;
--     everything for moderators) and hides names and contact details as needed.
--   * Every write goes through a small function that checks who is calling.

create extension if not exists pgcrypto;

-- ---------- Tables ----------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at   timestamptz not null default now()
);

create table if not exists public.moderators (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

do $$ begin
  create type public.post_kind as enum ('prayer', 'need', 'skill');
exception when duplicate_object then null; end $$;

do $$ begin
  -- pending: waiting for a moderator; open: on the board; closed: answered / met / paused;
  -- rejected: declined by a moderator (only the author and moderators see it)
  create type public.post_status as enum ('pending', 'open', 'closed', 'rejected');
exception when duplicate_object then null; end $$;

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles (id) on delete cascade,
  kind        public.post_kind not null,
  title       text not null check (char_length(title) between 1 and 90),
  body        text not null default '' check (char_length(body) <= 1200),
  category    text check (char_length(category) <= 40),
  trade       text check (char_length(trade) <= 40),
  area        text check (char_length(area) <= 60),
  rate        text check (char_length(rate) <= 60),
  contact     text check (char_length(contact) <= 80),
  hide_name   boolean not null default false,
  status      public.post_status not null default 'pending',
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '60 days',
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz
);
create index if not exists posts_status_idx on public.posts (status, expires_at);
create index if not exists posts_author_idx on public.posts (author_id);

create table if not exists public.prayers (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.reports (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  reason     text not null default '' check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- Lock the tables: RLS on with no policies, and no grants to the public roles.
alter table public.profiles   enable row level security;
alter table public.moderators enable row level security;
alter table public.posts      enable row level security;
alter table public.prayers    enable row level security;
alter table public.reports    enable row level security;
revoke all on public.profiles, public.moderators, public.posts, public.prayers, public.reports
  from anon, authenticated;

-- ---------- Helpers ----------

create or replace function public.is_moderator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.moderators where user_id = auth.uid());
$$;

create or replace function public.require_user()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Please sign in first.' using errcode = '28000';
  end if;
  return auth.uid();
end $$;

create or replace function public.clean(t text)
returns text language sql immutable as $$
  select nullif(btrim(t), '');
$$;

-- ---------- Read: the board ----------

drop view if exists public.board_posts;
create view public.board_posts as
select
  p.id, p.kind, p.title, p.body, p.category, p.trade, p.area, p.rate,
  p.status, p.created_at, p.expires_at, p.hide_name,
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
       then (select count(*) from public.reports r where r.post_id = p.id)::int end as report_count
from public.posts p
join public.profiles pr on pr.id = p.author_id
where (p.status in ('open', 'closed') and p.expires_at > now())
   or p.author_id = auth.uid()
   or public.is_moderator();

-- The view runs with its owner's rights and applies the rules above itself.
grant select on public.board_posts to anon, authenticated;

-- ---------- Write: functions the site calls ----------

create or replace function public.get_me()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'signed_in', auth.uid() is not null,
    'display_name', (select display_name from public.profiles where id = auth.uid()),
    'is_moderator', public.is_moderator()
  );
$$;

create or replace function public.set_display_name(p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  if public.clean(p_name) is null or char_length(btrim(p_name)) > 60 then
    raise exception 'Use a name between 1 and 60 characters.';
  end if;
  insert into public.profiles (id, display_name) values (uid, btrim(p_name))
  on conflict (id) do update set display_name = excluded.display_name;
end $$;

create or replace function public.create_post(
  p_kind text, p_title text, p_body text default '',
  p_category text default null, p_trade text default null, p_area text default null,
  p_rate text default null, p_contact text default null, p_hide_name boolean default false
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

  insert into public.posts (author_id, kind, title, body, category, trade, area, rate, contact, hide_name, status)
  values (
    uid, p_kind::public.post_kind, btrim(p_title), coalesce(btrim(p_body), ''),
    case when p_kind = 'need'  then public.clean(p_category) end,
    case when p_kind = 'skill' then public.clean(p_trade) end,
    case when p_kind <> 'prayer' then public.clean(p_area) end,
    case when p_kind = 'skill' then public.clean(p_rate) end,
    case when p_kind <> 'prayer' then public.clean(p_contact) end,
    case when p_kind = 'prayer' then coalesce(p_hide_name, false) else false end,
    case when public.is_moderator() then 'open'::public.post_status else 'pending'::public.post_status end
  ) returning id into new_id;
  return new_id;
end $$;

-- Authors: open <-> closed on their own approved posts.
-- Moderators: open, closed or rejected on any post.
create or replace function public.set_post_status(p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  p public.posts;
begin
  select * into p from public.posts where id = p_id;
  if not found then raise exception 'That post no longer exists.'; end if;

  if public.is_moderator() then
    if p_status not in ('open', 'closed', 'rejected') then raise exception 'Unknown status.'; end if;
    update public.posts
       set status = p_status::public.post_status,
           reviewed_by = case when p.status = 'pending' or p_status = 'rejected' then uid else reviewed_by end,
           reviewed_at = case when p.status = 'pending' or p_status = 'rejected' then now() else reviewed_at end
     where id = p_id;
    if p_status = 'open' then delete from public.reports where post_id = p_id; end if;
  elsif p.author_id = uid then
    if p.status not in ('open', 'closed') or p_status not in ('open', 'closed') then
      raise exception 'This post is waiting for review and can''t be changed yet.';
    end if;
    update public.posts set status = p_status::public.post_status where id = p_id;
  else
    raise exception 'You can only change your own posts.';
  end if;
end $$;

create or replace function public.renew_post(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  update public.posts set expires_at = now() + interval '60 days'
   where id = p_id and (author_id = uid or public.is_moderator());
  if not found then raise exception 'You can only renew your own posts.'; end if;
end $$;

create or replace function public.delete_post(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  delete from public.posts where id = p_id and (author_id = uid or public.is_moderator());
  if not found then raise exception 'You can only remove your own posts.'; end if;
end $$;

create or replace function public.toggle_prayer(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  if not exists (select 1 from public.posts where id = p_id and kind = 'prayer' and status = 'open' and expires_at > now()) then
    raise exception 'This prayer request is no longer open.';
  end if;
  if exists (select 1 from public.prayers where post_id = p_id and user_id = uid) then
    delete from public.prayers where post_id = p_id and user_id = uid;
    return false;
  end if;
  insert into public.prayers (post_id, user_id) values (p_id, uid);
  return true;
end $$;

create or replace function public.report_post(p_id uuid, p_reason text default '')
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := public.require_user();
begin
  insert into public.reports (post_id, user_id, reason)
  values (p_id, uid, left(coalesce(btrim(p_reason), ''), 300))
  on conflict (post_id, user_id) do update set reason = excluded.reason, created_at = now();
end $$;

-- Moderators can read report reasons for a post.
create or replace function public.list_reports(p_id uuid)
returns table (reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_moderator() then raise exception 'Moderators only.'; end if;
  return query select r.reason, r.created_at from public.reports r where r.post_id = p_id order by r.created_at desc;
end $$;

-- Only signed-in people may call the write functions; helpers stay private.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.get_me(), public.set_display_name(text),
  public.create_post(text, text, text, text, text, text, text, text, boolean),
  public.set_post_status(uuid, text), public.renew_post(uuid), public.delete_post(uuid),
  public.toggle_prayer(uuid), public.report_post(uuid, text), public.list_reports(uuid)
to authenticated;
grant execute on function public.get_me() to anon;
-- The view calls is_moderator(); allow it for both roles.
grant execute on function public.is_moderator() to anon, authenticated;

-- ---------- Make yourself a moderator ----------
-- After you sign in to the site once, run this with your sign-in email:
--   insert into public.moderators (user_id)
--   select id from auth.users where email = 'you@example.org';
