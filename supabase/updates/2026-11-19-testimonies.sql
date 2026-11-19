-- Update: let people share a testimony when a prayer is answered or a need is met.
-- A moderator reviews each testimony before it appears on the board.
-- Run once in Supabase → SQL Editor (safe to run again).

alter table public.posts add column if not exists testimony text;
alter table public.posts add column if not exists testimony_status text;
alter table public.posts add column if not exists testimony_at timestamptz;
-- The person agreed that the church may share the testimony publicly (beyond the board)
alter table public.posts add column if not exists testimony_share boolean not null default false;
alter table public.posts drop constraint if exists posts_testimony_check;
alter table public.posts add constraint posts_testimony_check check (char_length(testimony) <= 1200);
alter table public.posts drop constraint if exists posts_testimony_status_check;
alter table public.posts add constraint posts_testimony_status_check
  check (testimony_status in ('pending', 'approved', 'declined'));

-- The board view, now with the testimony. Others see it only once a moderator approves it.
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

grant select on public.board_posts to anon, authenticated;

-- Authors add, change or remove (empty text) the testimony on their own answered prayer or met need.
drop function if exists public.set_testimony(uuid, text);
create or replace function public.set_testimony(p_id uuid, p_text text, p_share boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := public.require_user();
  p public.posts;
  t text := public.clean(p_text);
begin
  select * into p from public.posts where id = p_id;
  if not found then raise exception 'That post no longer exists.'; end if;
  if p.author_id <> uid then raise exception 'You can only add a testimony to your own posts.'; end if;
  if p.kind not in ('prayer', 'need') or p.status <> 'closed' then
    raise exception 'You can share a testimony once a prayer is answered or a need is met.';
  end if;
  if char_length(t) > 1200 then raise exception 'Please keep your testimony under 1,200 characters.'; end if;
  update public.posts
     set testimony = t,
         testimony_status = case when t is null then null when public.is_moderator() then 'approved' else 'pending' end,
         testimony_at = case when t is null then null else now() end,
         testimony_share = t is not null and coalesce(p_share, false)
   where id = p_id;
end $$;

-- Moderators approve or decline a testimony.
create or replace function public.review_testimony(p_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_user();
  if not public.is_moderator() then raise exception 'Moderators only.'; end if;
  update public.posts
     set testimony_status = case when p_approve then 'approved' else 'declined' end
   where id = p_id and testimony is not null;
  if not found then raise exception 'That testimony no longer exists.'; end if;
end $$;

grant execute on function public.set_testimony(uuid, text, boolean), public.review_testimony(uuid, boolean) to authenticated;
revoke execute on function public.set_testimony(uuid, text, boolean), public.review_testimony(uuid, boolean) from public, anon;

-- Email moderators when a testimony is waiting for review.
create or replace function public.alert_testimony()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.testimony_status = 'pending' and new.testimony is distinct from old.testimony then
    perform public.notify_moderators(
      'New testimony to review: ' || left(new.title, 60),
      'Someone shared a testimony that is waiting for your review.',
      new.title || E'\n\n' || left(new.testimony, 400)
    );
  end if;
  return new;
exception when undefined_function then
  return new;
end $$;

drop trigger if exists posts_testimony_alert on public.posts;
create trigger posts_testimony_alert after update of testimony on public.posts
  for each row execute function public.alert_testimony();

revoke execute on function public.alert_testimony() from public, anon, authenticated;
