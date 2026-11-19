# Club Music

The installable app for our weekly album club. Rate this week's pick, add yours when it's your turn, and see the leaderboard by season.

It runs on any phone: open the link, then add it to the home screen. It opens full screen with its own icon, remembers who you are, and keeps working when the signal is bad.

## How it fits together

- **This repo (GitHub Pages)** holds the app itself: `index.html`, the icon, `manifest.webmanifest` (name, icon, colors) and `sw.js` (offline support and faster loading).
- **Supabase is the database and server** (moved from the Google Sheet in Nov 2026). Postgres holds everything (`supabase/migrations`), and one Edge Function, `supabase/functions/api`, answers the app. It takes the same requests the old Apps Script API did, so the app only needed a new address in `config.js`.
- **Locked down:** row level security is on for every table with no policies, the `club` schema isn't exposed to Supabase's public API, and the browser key can't read anything. Only the `api` function touches the data, and who is saving always comes from the session. The deploy job checks this every time.
- **Sign in:** tap your name, get a 6 digit code at your Gmail, type it in. Sessions last 120 days from the last time the phone used the app. Codes still come from Jonathan's Gmail through a tiny leftover Apps Script (`apps-script/Migrate.gs`, the mailer).
- **The Google Sheet is retired.** It stays as a frozen copy of the data up to the move.

## Supabase setup (one time)

1. Create a project at supabase.com (name `club-music`, West US) and save the database password.
2. Add these repo secrets (Settings > Secrets and variables > Actions):
   - `SUPABASE_ACCESS_TOKEN` (Supabase > Account > Access Tokens)
   - `SUPABASE_PROJECT_REF` (the id in the project's URL, after `/project/`)
   - `SUPABASE_DB_PASSWORD`
3. Run **Deploy to Supabase** from the Actions tab (it also runs on every push that changes `supabase/`). It tests the API against a throwaway Postgres, applies database changes, deploys the function, and checks the database can't be read from outside.
4. Run **Deploy to Apps Script** with **migrate** ticked. It exports everything from the sheet (weeks, ratings, songs, comments, rating times, shares, chat, platform choices and current sign ins), loads it into Supabase, and compares the new server's answer with the old one field by field. It refuses to run again once the club has saved anything to Supabase, so it can't erase new data (set `FORCE_IMPORT=yes` to override, on purpose only).
5. Put `https://<project ref>.supabase.co/functions/v1/api` in `config.js` as `apiUrl` and bump `VERSION` in `sw.js`.

**Nightly job** (`supabase-nightly.yml`): pings the project so the Free plan never pauses it, and saves an encrypted backup of the database as a workflow artifact for 30 days (restore steps are at the top of that file).

**Testing locally:** start a Postgres, apply the migration, then
`CLUB_TEST=1 FORCE_IMPORT=yes DB_URL=postgres://... deno test -A supabase/tests/api_test.ts`.

## Old setup (Apps Script, before Nov 2026)

### 1. Apps Script (in the sheet: Extensions > Apps Script)
1. Replace **WebApp.gs** with `apps-script/WebApp.gs`.
2. Add a file **Api.gs** with `apps-script/Api.gs`.
3. Add a file **Members.gs** with the real member emails (format in `apps-script/Members.example.gs`). This file is never committed here.
4. Run **setupApp** once and approve the permissions (it needs to send the sign in emails).
5. **Deploy > New deployment > Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL ending in `/exec`.

### 2. GitHub Pages
Repo **Settings > Pages**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**. Custom domain: `clubmusic.net` (the `CNAME` file). The app appears at `https://clubmusic.net/`. Backup domain `club-music.net` forwards there from its registrar (GitHub Pages serves one custom domain per repo), and the old `https://ninjoeboss.github.io/album-discovery/` address redirects there too.

## Heard it before (bonus shares)

On their turn, after locking in an album nobody has heard, a member can also share one album they already know (Add Album tab, "Heard it before?"). It shows up next to their pick on that Thursday, and everyone can rate it, pick songs and comment, but it stays out of the leaderboard, stats and "still to rate" lists. Shares are rows in the `albums` table with kind `share` (ids from 100000 up, as on the old Shared Albums tab).

## Making changes

- Edit `index.html`, then bump `VERSION` in `sw.js` so phones pick up the new copy.
- Server changes go in `supabase/functions/api/` (and database changes as a new file in `supabase/migrations/`). Pushing to `main` deploys them automatically.
- Editor helpers: `listSessions` (who is signed in), `signOutEveryone`, `checkSeasons`, `checkMemberEmails`, `resetSignInLimits` (unlocks sign in if someone hit today's code limit).
- Security: editor helpers only run for the owner in the script editor; app functions need a signed in session. Sign in codes are capped per day (30 for the club, 8 per member, 15 wrong guesses per member, after which Jonathan gets an email). The `?check=` links need a token the deploy job makes fresh each run (`CheckToken.gs`, never committed).

## Automatic Apps Script updates

`apps-script/` mirrors the Apps Script project, and two GitHub Actions keep them in sync:

- **Deploy to Apps Script** (`.github/workflows/deploy-apps-script.yml`) runs on every push to `main` that changes `apps-script/`. It uploads the files with clasp and publishes a new version of the **Github** deployment, so the `/exec` URL in `config.js` never changes.
- **Pull from Apps Script** (`.github/workflows/pull-apps-script.yml`) copies the live project back into `apps-script/`. Run it from the Actions tab (or by changing `apps-script/.pull`) after editing anything by hand in the script editor; otherwise the next deploy stops rather than overwrite it.

**Face points:** the deploy job also runs MediaPipe Face Landmarker on the club photos and uploads `FacePoints.gs` (eye and mouth spots on each photo, 0 to 100; no images). The app uses them to draw face filters, like the Procrastinator's tears. It's rebuilt on every deploy, so after changing `AVATARS_HTML`, run **Deploy to Apps Script** from the Actions tab. If detection fails, the deploy still goes ahead and the app uses default spots. Script: `.github/scripts/face_points.py`.

Repo secrets they use: `CLASPRC_JSON` (the `.clasprc.json` from `clasp login`), `MEMBERS_GS` (the private Members.gs) and `AVATARS_HTML` (the private Avatars file). Members.gs and Avatars are never committed here. If the deploy ever fails with a login error, run `clasp login` again on a computer and replace `CLASPRC_JSON`.

