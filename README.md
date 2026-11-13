# "One Another" Board

A public community bulletin board for prayer requests, needs, and trades for hire.

- **Anyone** can read the board.
- People **sign in with their email** (a sign-in link, no password) to post, pray along, report a post, or see contact details.
- **Moderators approve** every new post before it appears, and see reported posts in a Review tab.
- Posts **expire after 60 days**. Authors can renew them, mark them answered or met, or remove them.
- Prayer requests can hide the poster's name from other readers. Moderators can still see it.

## What's in this folder

| Path | What it is |
|---|---|
| `docs/` | The website: plain HTML, CSS and JavaScript. No build step. GitHub Pages serves this folder, which is why it's called `docs`. |
| `docs/config.js` | **The only file you edit**: Supabase keys, church name, brand colors. |
| `supabase/schema.sql` | The database tables and security rules. You run it once. |
| `supabase/updates/` | Changes for a database that's already running (run each once, oldest first). New installs only need `schema.sql`. |

With no Supabase keys in `config.js`, the site runs in **demo mode**: sample posts, nothing saved, and you're a moderator as soon as you sign in.

## Going live (about 30 minutes)

### 1. Create the database (Supabase, free tier)
1. Create an account at supabase.com and start a **New project**. Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Open **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `docs/config.js`.
   The anon key is meant to be public. The security rules in the schema protect the data. Never put the `service_role` key in the site.

### 2. Put the site online with GitHub Pages (free)
1. On github.com, click **New repository**. Name it `one-another-board` and choose **Public**. Pages on a free account needs a public repository, and nothing in this project is secret.
2. Upload everything in this folder to the repository, either by dragging the files onto the repository page or by pushing with git.
3. In the repository, open **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, pick **main** and **/docs**, and click **Save**.
4. After a minute or two the address appears at the top of that page, for example `https://yourname.github.io/one-another-board/`. Turn on **Enforce HTTPS** if it's offered.

Any change you push to `main` after that goes live within a couple of minutes. To use your own address (for example `board.yourchurch.org`), enter it under **Settings → Pages → Custom domain** and follow GitHub's DNS instructions.

Netlify or Cloudflare Pages also work: upload the `docs` folder.

### 3. Connect sign-in to your site address
In Supabase, open **Authentication → URL Configuration**:
- **Site URL:** your full site address, **including the repository name and the ending slash**, for example `https://yourname.github.io/one-another-board/`
- **Redirect URLs:** add the same address. While testing on your computer, also add `http://localhost:8642`.

If you move to a custom domain later, update both settings.

### 4. Set up email before launch (important)
Supabase's built-in email sender only sends a handful of sign-in emails per hour, which is fine for testing but not for a congregation. Before you announce the board:
- Go to **Authentication → Emails → SMTP Settings** and connect an email service (for example Resend, Postmark, SendGrid or your church's Google Workspace / Microsoft 365).
- Optionally edit the **Magic Link** email template so it mentions your church by name.

### 5. Make yourself a moderator
1. Visit the live site and sign in once with your email.
2. In Supabase **SQL Editor**, run this with your email:
   ```sql
   insert into public.moderators (user_id)
   select id from auth.users where email = 'you@yourchurch.org';
   ```
3. Reload the site. You'll see **Moderator** next to your name and a **Review** tab.

Add other moderators the same way. To remove one: `delete from public.moderators where user_id = (select id from auth.users where email = '...');`

### 6. Optional: stop spam sign-ups
In **Authentication → Attack Protection**, turn on CAPTCHA (Cloudflare Turnstile is free) if you see fake sign-ups. You'd then need a small change to the sign-in form, so ask before turning it on.

## Changing the look
Edit `docs/config.js`:
- `churchName`, `boardName`, `tagline`: the header text.
- `brand.primary` (#0066FF) is used for buttons, links and prayer requests. `brand.secondary` (#0A1650) is the header band and headings. `brand.neutral` (#BCBCBD) is used for lines and borders. `brand.primaryOnDark` is a lighter blue for dark mode.

Upload or push the change to GitHub, and it goes live within a couple of minutes.

## Built-in safety rules
- Browsers can't read or write the tables directly. Everything goes through one read-only view and a small set of database functions that check who is asking.
- Contact details are only sent to signed-in people.
- Each person can add up to 5 posts a day (moderators are exempt).
- Only the author or a moderator can change or remove a post. Approving, declining and removing are moderator-only.

## Trying it on your computer
Open a terminal in this folder and run:
```
ruby -run -e httpd docs -p 8642
```
Then visit http://localhost:8642.

## Ideas for later
- Email the poster when someone prays for their request or responds to a need.
- A weekly email digest of new prayer requests.
- "Members only" prayer requests, using Planning Center to confirm membership.
- Sign in with Google.
