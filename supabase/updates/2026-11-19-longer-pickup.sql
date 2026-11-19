-- Update: allow up to 200 characters in the area field, which Freecycle posts
-- use for pickup instructions. Run once in Supabase → SQL Editor (safe to run again).

alter table public.posts drop constraint if exists posts_area_check;
alter table public.posts add constraint posts_area_check check (char_length(area) <= 200);
