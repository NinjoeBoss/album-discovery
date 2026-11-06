# Club Music

The installable app for our weekly album club. Rate this week's pick, add yours when it's your turn, and see the leaderboard by season.

It runs on any phone: open the link, then add it to the home screen. It opens full screen with its own icon, remembers who you are, and keeps working when the signal is bad.

## How it fits together

- **This repo (GitHub Pages)** holds the app itself: `index.html`, the icon, `manifest.webmanifest` (name, icon, colors) and `sw.js` (offline support and faster loading).
- **The Google Sheet stays the database.** The app talks to it through the Apps Script code in `apps-script/`, deployed as a web app.
- **Sign in:** tap your name, get a 6 digit code at your Gmail, type it in. You only do this once on each phone.

## Setup (one time)

### 1. Apps Script (in the sheet: Extensions > Apps Script)
1. Replace **WebApp.gs** with `apps-script/WebApp.gs`.
2. Add a file **Api.gs** with `apps-script/Api.gs`.
3. Add a file **Members.gs** with the real member emails (format in `apps-script/Members.example.gs`). This file is never committed here.
4. Run **setupApp** once and approve the permissions (it needs to send the sign in emails).
5. **Deploy > New deployment > Web app**: Execute as **Me**, Who has access **Anyone**. Copy the URL ending in `/exec`.
6. (The old Apps Script site was retired Nov 5, 2026. Its `/exec` page now just links to this app.)

### 2. Point the app at the sheet
Put the `/exec` URL in `config.js` as `apiUrl`.

### 3. Turn on GitHub Pages
Repo **Settings > Pages**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**. Custom domain: `club-music.net` (the `CNAME` file). The app appears at `https://club-music.net/`; the old `https://ninjoeboss.github.io/album-discovery/` address redirects there.

## Making changes

- Edit `index.html`, then bump `VERSION` in `sw.js` so phones pick up the new copy.
- Server changes go in `apps-script/`. Pushing to `main` uploads them automatically (see below); no pasting into the editor.
- Editor helpers: `listSessions` (who is signed in), `signOutEveryone`, `checkSeasons`, `checkMemberEmails`.

## Automatic Apps Script updates

`apps-script/` mirrors the Apps Script project, and two GitHub Actions keep them in sync:

- **Deploy to Apps Script** (`.github/workflows/deploy-apps-script.yml`) runs on every push to `main` that changes `apps-script/`. It uploads the files with clasp and publishes a new version of the **Github** deployment, so the `/exec` URL in `config.js` never changes.
- **Pull from Apps Script** (`.github/workflows/pull-apps-script.yml`) copies the live project back into `apps-script/`. Run it from the Actions tab (or by changing `apps-script/.pull`) after editing anything by hand in the script editor; otherwise the next deploy stops rather than overwrite it.

Repo secrets they use: `CLASPRC_JSON` (the `.clasprc.json` from `clasp login`), `MEMBERS_GS` (the private Members.gs) and `AVATARS_HTML` (the private Avatars file). Members.gs and Avatars are never committed here. If the deploy ever fails with a login error, run `clasp login` again on a computer and replace `CLASPRC_JSON`.

