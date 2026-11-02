# Album Discovery

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
6. Also update the old site's deployment (**Manage deployments > edit > New version**) so it keeps working.

### 2. Point the app at the sheet
Put the `/exec` URL in `config.js` as `apiUrl`.

### 3. Turn on GitHub Pages
Repo **Settings > Pages**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**. The app appears at `https://ninjoeboss.github.io/album-discovery/`.

## Making changes

- Edit `index.html`, then bump `VERSION` in `sw.js` so phones pick up the new copy.
- Server changes go in `apps-script/`. Paste them into Apps Script and deploy a new version of **both** deployments.
- Editor helpers: `listSessions` (who is signed in), `signOutEveryone`, `checkSeasons`, `checkMemberEmails`.
