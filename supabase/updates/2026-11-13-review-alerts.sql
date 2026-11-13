-- Update: email moderators when a post needs review or gets reported.
-- Run once in Supabase → SQL Editor (safe to run again).
--
-- Before running: in Supabase → Project Settings → Vault, add a secret named
--   resend_alerts_key
-- whose value is a Resend API key with "Sending access".
-- Without that secret, alerts are skipped and posting still works normally.

create extension if not exists pg_net with schema extensions;

-- Escape text for use inside an HTML email.
create or replace function public.html_escape(t text)
returns text language sql immutable as $$
  select replace(replace(replace(replace(coalesce(t, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

-- Send one email to each moderator through Resend. Never blocks the caller:
-- any problem is logged as a warning and the post or report still goes through.
create or replace function public.notify_moderators(p_subject text, p_heading text, p_detail text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  api_key text;
  board_url constant text := 'https://oneanother.follow-church.com/';
  html text;
  m record;
begin
  begin
    select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_alerts_key' limit 1;
  exception when others then
    api_key := null;
  end;
  if api_key is null or api_key = '' then
    return;
  end if;

  html := '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0B0F1F">'
       || '<div style="background:#0A1650;color:#fff;padding:18px 22px;border-bottom:4px solid #0066FF">'
       || '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.75">Follow Church</div>'
       || '<div style="font-size:22px;font-weight:bold">&ldquo;One Another&rdquo; Board</div></div>'
       || '<div style="padding:22px">'
       || '<p style="font-size:17px;font-weight:bold;margin:0 0 8px">' || public.html_escape(p_heading) || '</p>'
       || '<p style="font-size:15px;line-height:1.5;margin:0 0 20px;white-space:pre-wrap">' || public.html_escape(p_detail) || '</p>'
       || '<a href="' || board_url || '" style="display:inline-block;background:#0066FF;color:#fff;text-decoration:none;font-weight:bold;padding:10px 18px;border-radius:999px">Open the Review tab</a>'
       || '<p style="font-size:12px;color:#555B6E;margin:24px 0 0">You get these emails because you are a moderator of the board.</p>'
       || '</div></div>';

  for m in
    select u.email from public.moderators mo join auth.users u on u.id = mo.user_id where u.email is not null
  loop
    begin
      perform net.http_post(
        url := 'https://api.resend.com/emails',
        headers := jsonb_build_object('Authorization', 'Bearer ' || api_key, 'Content-Type', 'application/json'),
        body := jsonb_build_object(
          'from', '“One Another” Board <alerts@board.follow-church.com>',
          'to', jsonb_build_array(m.email),
          'subject', p_subject,
          'html', html
        )
      );
    exception when others then
      raise warning 'Review alert to a moderator failed: %', sqlerrm;
    end;
  end loop;
exception when others then
  raise warning 'Review alerts failed: %', sqlerrm;
end $$;

-- Nobody calls this directly; only the triggers below use it.
revoke execute on function public.notify_moderators(text, text, text) from public, anon, authenticated;

-- New post waiting for review
create or replace function public.alert_new_post()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  label text := case new.kind when 'prayer' then 'prayer request' when 'need' then 'need' else 'trade listing' end;
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

drop trigger if exists posts_review_alert on public.posts;
create trigger posts_review_alert after insert on public.posts
  for each row execute function public.alert_new_post();

-- Post reported
create or replace function public.alert_report()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  select title into t from public.posts where id = new.post_id;
  perform public.notify_moderators(
    'A post was reported: ' || left(coalesce(t, 'a post'), 60),
    'Someone reported a post on the board.',
    coalesce(t, '') || E'\n\nReason: ' || coalesce(nullif(new.reason, ''), 'No reason given')
  );
  return new;
end $$;

drop trigger if exists reports_review_alert on public.reports;
create trigger reports_review_alert after insert on public.reports
  for each row execute function public.alert_report();

revoke execute on function public.alert_new_post(), public.alert_report(), public.html_escape(text) from public, anon, authenticated;
