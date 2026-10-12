# Tennis Stat Tracker: public beta

This is the existing Tennis Stat Tracker (V464 HTML app), packaged for an **open beta that anyone with the link can join**:

- **Install it on a phone** like an app, and keep using it **offline** at courtside (service worker + manifest).
- **Back up to the cloud**: sign in with an email code, and the app takes a snapshot of the whole on-device database to Supabase every few minutes. It also backs up when the app goes to the background and whenever you tap "Back up now".
- **Restore** onto a new or cleared phone, choosing from the backup history.
- **Feedback and error reports** go into Supabase, so you can read them in one place.
- **Self-service account deletion** from inside the app.
- **Welcome page** (`welcome.html`) to share: install steps per device, what to test, a QR code and share buttons.
- **Beta terms and privacy notice** (`privacy.html`), linked from sign-in.

The phone is still the working copy. The cloud holds backups and is where you analyse the beta data. Real multi-user sync comes with the rebuild (see `architecture/architecture-v1.md` in the project).

## Files

| File | Purpose |
|---|---|
| `welcome.html` | **The link you share with testers** |
| `index.html` | The app: the original plus 4 small hooks (PWA head tags, a call after each local save, a narrow bridge `window.__tennisBeta`, and loading the beta scripts) |
| `reset.html` | Page the "Forgot password" email opens, to set a new password |
| `privacy.html` | Beta terms and privacy notice (**draft; have a lawyer review it**) |
| `beta-config.js` | **The only file you must edit**: Supabase URL and anon key |
| `beta-cloud.js` / `.css` | Sign-in, backup engine, restore, feedback, error reporting, account deletion |
| `vendor/supabase.js`, `vendor/qrcode.js` | Pinned libraries (supabase-js 2.116.0, qrcode-generator 1.4.4), served from your own domain so they work offline |
| `sw.js` | Offline cache. Bump `CACHE_VERSION` on every deploy. |
| `manifest.webmanifest`, `icons/` | Install-to-home-screen metadata |
| `supabase/001_beta_schema.sql` | Tables, Row Level Security, triggers, retention, quotas, deletion function, admin views |

## Go live (about 1 hour)

### 1. Supabase (20 min)
1. Create a project at supabase.com on the **Free plan**, choosing a **US region** (the privacy notice says data is stored in the US).
   Free-plan limits to watch:
   - **The project pauses after about a week with no activity.** Restore it from the dashboard. Active testers keep it awake.
   - **500 MB database.** Each tester is capped at 50 MB of backups, and most use far less. Check usage under **Project Settings → Usage**, and upgrade to Pro ($25/mo) when you pass about 300 MB or about 20 active testers.
2. **SQL Editor** → paste `supabase/001_beta_schema.sql` → **Run**. It's safe to re-run whenever you update it.
3. **Authentication → Sign In / Providers → Email**: keep it enabled, **turn OFF "Confirm email"**, set **minimum password length to 8**, and keep **"Allow new users to sign up" ON**.
   Testers sign in with **email + password**, and the app sends no emails for normal sign-in. That avoids the Free plan's email limits and its block on editing templates (new free projects can't edit email templates without custom SMTP, since June 2026).
4. **Authentication → URL Configuration**: set **Site URL** to your GitHub Pages address (e.g. `https://<you>.github.io/tennis-tracker-beta/`) and add `https://<you>.github.io/tennis-tracker-beta/**` under **Redirect URLs**. The "Forgot password" email links to `reset.html` on that site.
5. **Email sending (optional for now):** only password-reset emails are sent, through Supabase's built-in email, which has a low hourly limit. For a bigger beta, add a free SMTP provider (Brevo, Resend, or Gmail with an app password) under **Authentication → SMTP Settings**.
6. **Project Settings → API**: copy the **Project URL** and the **anon / publishable** key into `beta-config.js`. Never use the `service_role` key.

### 2. Host it (10 min)
**Option A: GitHub Pages (with git)**
```bash
cd beta-site
git init && git add . && git commit -m "Tennis Tracker beta"
git branch -M main
git remote add origin https://github.com/<you>/tennis-tracker-beta.git
git push -u origin main
```
On GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
Your share link is `https://<you>.github.io/tennis-tracker-beta/welcome.html`.
A public repo is fine: there are no secrets in it, because the anon key is public by design.

**Option B: Netlify Drop (no git)**: drag the `beta-site` folder onto app.netlify.com/drop. Your share link is `<netlify-url>/welcome.html`.

**Optional:** point a custom domain (for example `beta.<yourbrand>.com`) at either host. It's easier to trust and to type.

### 3. Smoke test on your phone (10 min)
1. Open the welcome link in **Safari** (iPhone) or **Chrome** (Android) and follow its install steps.
2. Open the app from the home-screen icon, tap **☁** (bottom-left) and create an account with email + password.
3. Track a few points, then tap **Back up now**. In Supabase → Table Editor → `beta_backups`, you should see a row.
4. Turn on airplane mode, close and reopen the app. It should still load, with your data.
5. Sign in with a second email on another phone. You should see none of the first account's data.

### 4. Invite testers
Share the welcome link: in texts, group chats, club emails, or as the QR code on the page (print it for courtside). The page tells testers how to install, what to try ("track 2 matches, then ☁ → Send feedback") and links the privacy notice.

## Watching the beta (Supabase SQL Editor)
```sql
select * from beta_admin_activity order by last_backup_at desc nulls last;   -- who's active
select * from beta_admin_matches order by created_at desc;                    -- every match tracked
select created_at, message, device_label from beta_feedback order by created_at desc;
select created_at, message, source, device_label from beta_client_errors order by created_at desc;
select count(*) as testers from auth.users;                                    -- signups
```
Admin views are only visible in the dashboard, not through the public API.

## Deploying an update
1. Edit files.
2. In `sw.js`, bump `CACHE_VERSION` (for example `tst-beta-2026-10-13-1`).
3. Push to git or drop the folder again. Phones pick up the new version the next time the app opens with a connection (pages load network-first).

## Open-signup safeguards
- **Isolation:** Row Level Security means each tester can read, write and delete only their own rows. The server sets ownership, size and counts, so the client can't spoof them.
- **Abuse limits:** 15 MB per backup; 50 MB stored per tester (the oldest backups roll off first, and the 3 newest are always kept); 10 backups per 5 minutes; feedback and errors 30 per 10 minutes.
- **Retention:** the 10 most recent backups plus one per day for 14 days, per tester.
- **Deletion:** ☁ → *Delete my cloud account & data* removes every cloud row and the tester's login immediately (function `beta_delete_my_account`).
- **Who signs up:** accounts are adults only (18+, or the local age of majority). Parents and guardians create and manage accounts for junior players. Testers accept "as-is, use at your own risk" terms at sign-in.
- **What the disclaimer does and doesn't cover:** "use at your own risk" limits your liability for bugs, data loss and outages. It doesn't remove privacy-law duties for kids' data that parents enter (COPPA in the US, GDPR/UK GDPR for testers in Europe). Those apply wherever the testers are, not where you are. Before promoting widely, have a lawyer review `privacy.html`, and sign Supabase's data processing agreement (DPA), available in the dashboard.

## Known limits of this beta
- One device is the working copy. Two phones signed into the same account each back up their own snapshot, and a restore replaces the whole device database. There is no merging.
- Video stays on the device (unchanged from the original app).
- AI strategy and UTR sync stay disabled (no backend configured).
- Testers see only their own data. The cross-coach shared profiles (decision D19) arrive with the rebuild.
