// Club Music API (Supabase Edge Function).
//
// Answers the app exactly like the old Apps Script API did:
//   POST { action, args: [...], session } as a plain text JSON body
//   -> { ok: true, result } or { ok: false, error }
// so index.html only needed its address changed.
//
// The database is closed to the outside world (see supabase/migrations); this
// function is the only thing that reads or writes it. Who is saving always comes
// from the session, never from anything the app sends.

import postgres from "npm:postgres@3.4.5";
import * as L from "./lookups.ts";
import * as Push from "./push.ts";

const TZ = "America/Los_Angeles";
const SHARE_BASE = 100000;
const FIRST_ROW = 7;                      // old sheet row of the first week
const FIRST_WEEK = "2026-07-16";          // that week's Thursday
const SLOTS_SHOWN = 8;
const OPEN_WEEKS_AHEAD = 12;              // open weeks kept ready past today
const COMMENT_MAX = 200;
const SHARE_DAYS = 6;
const CHAT_MAX = 500, CHAT_LOAD = 200, CHAT_PER_MINUTE = 20;
const SESSION_DAYS = 120;                 // counted from the last time the phone used the app
const CODE_MINUTES = 10, CODE_TRIES = 5, CODES_PER_10_MIN = 3;
const CODES_PER_DAY_TOTAL = 30, CODES_PER_DAY_NAME = 8, WRONG_CODES_PER_DAY = 15;
const APP_KEY_DAYS = 30;
const LOOKUP_MS = 4000;                   // time one request may spend finding missing covers/links
const WAIT_ALBUM = { album: "Graduation", artist: "Kanye West", year: "2007" };

const sql = postgres(Deno.env.get("DB_URL") || Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false, max: 3, idle_timeout: 20, types: { numeric: { to: 1700, from: [1700], serialize: String, parse: Number } },
});

class UserError extends Error {}
const fail = (msg: string): never => { throw new UserError(msg); };

/* ---------- small helpers ---------- */

const normName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
const todayYmd = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ymd = (d: Date | string | null) => !d ? "" : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
function shiftDays(ymdStr: string, days: number) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12)).toISOString().slice(0, 10);
}
const weekOfRow = (id: number) => shiftDays(FIRST_WEEK, 7 * (id - FIRST_ROW));
function pretty(ymdStr: string) {
  const [y, m, d] = ymdStr.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}
async function sha256(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
const randomHex = (bytes = 32) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, "0")).join("");
function checkScore(score: unknown) {
  const s = Number(score);
  if (isNaN(s) || s < 1 || s > 10 || Math.round(s * 4) !== s * 4) fail("Scores must be from 1 to 10 in quarter steps.");
  return s;
}
function checkAlbumInput(album: unknown, artist: unknown, year: unknown) {
  const a = clean(album), ar = clean(artist), y = String(year ?? "").trim();
  if (!a) fail("Add the album name.");
  if (!ar) fail("Add the artist.");
  if (a.length > 150 || ar.length > 150) fail("That name is too long.");
  if (y && !(/^\d{4}$/.test(y) && +y >= 1900 && +y <= 2030)) fail("Year should look like 1997.");
  return { album: a, artist: ar, year: y };
}
const httpsOrNull = (u: unknown) => /^https:\/\//.test(String(u || "")) ? String(u).slice(0, 500) : null;

/** Runs fn inside one transaction that holds the club write lock (same role as Apps Script's LockService). */
const locked = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  sql.begin(async (tx) => { await tx`select pg_advisory_xact_lock(4242)`; return fn(tx); }) as Promise<T>;

/** Counts hits in a short window; throws msg once `max` is reached. */
async function rateLimit(bucket: string, max: number, seconds: number, msg: string) {
  const [{ n }] = await sql`select count(*)::int n from club.rate_hits where bucket = ${bucket} and at > now() - make_interval(secs => ${seconds})`;
  if (n >= max) fail(msg);
  await sql`insert into club.rate_hits (bucket) values (${bucket})`;
  if (Math.random() < 0.05) await sql`delete from club.rate_hits where at < now() - interval '1 day'`;
}

/* ---------- members and seasons ---------- */

type Member = { name: string; email: string; sort: number; rotation: number; is_admin: boolean; platform: string | null };
const loadMembers = () => sql<Member[]>`select name, email, sort, rotation, is_admin, platform from club.members order by sort`;
const loadSeasons = () => sql<{ name: string; start: string }[]>`select name, to_char(start, 'YYYY-MM-DD') as start from club.seasons order by start`;
function seasonOf(seasons: { name: string; start: string }[], d: string) {
  if (!d) return seasons[seasons.length - 1].name;
  let name = seasons[0].name;
  for (const s of seasons) if (d >= s.start) name = s.name;
  return name;
}
const rotationOf = (members: Member[]) => [...members].sort((a, b) => a.rotation - b.rotation).map((m) => m.name);

/* ---------- sessions ---------- */

type Session = { member: string; email: string; hash: string; admin: boolean };

async function sessionFor(token: unknown): Promise<Session | null> {
  const t = String(token || "");
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  const hash = await sha256(t);
  const rows = await sql`
    update club.sessions s set last_used = now()
      from club.members m
     where s.token_hash = ${hash} and m.name = s.member
       and s.last_used > now() - make_interval(days => ${SESSION_DAYS})
    returning m.name, m.email, m.is_admin`;
  if (!rows.length) { await sql`delete from club.sessions where token_hash = ${hash}`; return null; }
  return { member: rows[0].name, email: rows[0].email, admin: rows[0].is_admin, hash };
}

async function newSession(member: string) {
  const token = randomHex();
  await sql`insert into club.sessions (token_hash, member) values (${await sha256(token)}, ${member})`;
  return { session: token, name: member };
}

/* ---------- sign in codes ---------- */

const lockedMessage = "Too many wrong codes today, so sign in is paused until tomorrow. Ask Jonathan if you need in sooner.";
const mask = (email: string) => { const [a, b] = email.split("@"); return a.slice(0, 2) + "•••••@" + b; };

async function sendMail(to: string, subject: string, body: string, html?: string) {
  const url = Deno.env.get("MAILER_URL"), secret = Deno.env.get("MAILER_SECRET");
  if (!url || !secret) fail("Email isn't set up yet. Ask Jonathan.");
  const res = await fetch(url!, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: "mail", secret, to, subject, body, html }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => null);
  if (!j?.ok) throw new Error("Couldn't send the email: " + (j?.error || res.status));
}

async function memberByName(name: unknown) {
  const rows = await sql<Member[]>`select * from club.members where name = ${String(name || "")}`;
  if (!rows.length) fail("That name isn't on the club list.");
  return rows[0];
}

async function requestCode(name: unknown) {
  const m = await memberByName(name);
  await rateLimit("code|" + m.name, CODES_PER_10_MIN, 600, "Too many codes sent. Wait 10 minutes and try again.");
  const day = todayYmd();
  await locked(async (tx) => {
    const rows = await tx`select member, sent, wrong from club.signin_counts where day = ${day} and member in (${m.name}, '*')`;
    const mine = rows.find((r) => r.member === m.name) || { sent: 0, wrong: 0 };
    const all = rows.find((r) => r.member === "*") || { sent: 0 };
    if (mine.wrong >= WRONG_CODES_PER_DAY) fail(lockedMessage);
    if (all.sent >= CODES_PER_DAY_TOTAL || mine.sent >= CODES_PER_DAY_NAME) fail("Too many sign in codes today. Try again tomorrow, or ask Jonathan.");
    await tx`insert into club.signin_counts (day, member, sent) values (${day}, ${m.name}, 1), (${day}, '*', 1)
             on conflict (day, member) do update set sent = signin_counts.sent + 1`;
  });
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await sql`insert into club.codes (member, code_hash, tries, expires) values (${m.name}, ${await sha256(m.name + "|" + code)}, 0, now() + make_interval(mins => ${CODE_MINUTES}))
            on conflict (member) do update set code_hash = excluded.code_hash, tries = 0, expires = excluded.expires`;
  await sendMail(m.email, "Your Club Music code: " + code,
    `Hi ${m.name},\n\nYour sign in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore it.`,
    `<div style="font-family:Roboto,Arial,sans-serif;color:#1e1b2e"><p>Hi ${m.name},</p><p>Your Club Music sign in code:</p>` +
    `<p style="font-size:32px;font-weight:900;letter-spacing:6px;background:#eceaf3;padding:14px 20px;border-radius:12px;display:inline-block">${code}</p>` +
    `<p style="color:#5e5873">It works for ${CODE_MINUTES} minutes. If you didn't ask for this, you can ignore it.</p></div>`);
  return { hint: mask(m.email) };
}

async function verifyCode(name: unknown, code: unknown) {
  const m = await memberByName(name);
  const c = String(code || "").replace(/\D/g, "");
  const day = todayYmd();
  const [cnt] = await sql`select wrong from club.signin_counts where day = ${day} and member = ${m.name}`;
  if (cnt && cnt.wrong >= WRONG_CODES_PER_DAY) fail(lockedMessage);
  const [saved] = await sql`select code_hash, tries from club.codes where member = ${m.name} and expires > now()`;
  if (!saved) fail("That code expired. Send a new one.");
  if (saved.code_hash !== await sha256(m.name + "|" + c)) {
    const [w] = await sql`insert into club.signin_counts (day, member, wrong) values (${day}, ${m.name}, 1)
      on conflict (day, member) do update set wrong = signin_counts.wrong + 1 returning wrong, alerted`;
    if (w.wrong >= WRONG_CODES_PER_DAY) {
      await sql`delete from club.codes where member = ${m.name}`;
      if (!w.alerted) {
        await sql`update club.signin_counts set alerted = true where day = ${day} and member = ${m.name}`;
        const admins = await sql`select email from club.members where is_admin`;
        for (const a of admins) {
          try {
            await sendMail(a.email, `Club Music: sign in locked for ${m.name} today`,
              `Someone typed ${WRONG_CODES_PER_DAY} wrong sign in codes for ${m.name} today, so sign in for ${m.name} is paused until tomorrow. ` +
              `If that wasn't ${m.name} fumbling the code, someone may be trying to guess it.\n\nPhones already signed in keep working.`);
          } catch { /* the lock holds without the email */ }
        }
      }
      fail(lockedMessage);
    }
    if (saved.tries + 1 >= CODE_TRIES) { await sql`delete from club.codes where member = ${m.name}`; fail("Too many wrong tries. Send a new code."); }
    await sql`update club.codes set tries = tries + 1 where member = ${m.name}`;
    fail("That code isn't right. Check the email and try again.");
  }
  await sql`delete from club.codes where member = ${m.name}`;
  return newSession(m.name);
}

/* Home screen sign in hand off (see the old Api.gs for why iPhones need it). */
async function appKey(s: Session) {
  const k = randomHex();
  await sql.begin(async (tx) => {
    await tx`delete from club.app_keys where session_hash = ${s.hash}`;
    await tx`insert into club.app_keys (key_hash, member, session_hash) values (${await sha256(k)}, ${s.member}, ${s.hash})`;
  });
  return { key: k, days: APP_KEY_DAYS };
}

async function useAppKey(k: unknown) {
  const key = String(k || "");
  const bad = "That home screen link has already been used or expired. Sign in below.";
  if (!/^[a-f0-9]{64}$/.test(key)) fail(bad);
  const rows = await sql`delete from club.app_keys where key_hash = ${await sha256(key)} returning member, created`;
  if (!rows.length || Date.now() - new Date(rows[0].created).getTime() > APP_KEY_DAYS * 864e5) fail(bad);
  return newSession(rows[0].member);
}

/* ---------- saved lookups ---------- */

async function kvGet(key: string) {
  const [r] = await sql`select value from club.kv where key = ${key} and (expires is null or expires > now())`;
  return r ? r.value : null;
}
async function kvSet(key: string, value: unknown, hours?: number) {
  await sql`insert into club.kv (key, value, expires) values (${key}, ${sql.json(value as any)}, ${hours ? new Date(Date.now() + hours * 36e5) : null})
            on conflict (key) do update set value = excluded.value, expires = excluded.expires`;
}

/** Fills in missing covers, links and tracklists, spending at most LOOKUP_MS. Saves what it finds. */
async function fillLookups(rows: any[], budgetMs = LOOKUP_MS) {
  const deadline = Date.now() + budgetMs;
  const misses = new Set((await sql`select key from club.kv where key like 'miss|%' and expires > now()`).map((r) => r.key));
  const jobs: (() => Promise<void>)[] = [];
  const field = (r: any, col: string, find: () => Promise<any>, empty = (v: any) => v == null) => {
    if (!empty(r[col]) || misses.has(`miss|${col}|${r.id}`)) return;
    jobs.push(async () => {
      let v: any = null;
      try { v = await find(); } catch { return; }      // network trouble: try again next load
      if (v && (!Array.isArray(v) || v.length)) {
        r[col] = v;
        await sql`update club.albums set ${sql({ [col]: Array.isArray(v) ? sql.json(v) : v } as any)} where id = ${r.id}`;
      } else await kvSet(`miss|${col}|${r.id}`, true, 6);
    });
  };
  for (const r of rows) {
    if (!r.album) continue;
    field(r, "cover", () => L.findCover(r.album, r.artist));
    field(r, "apple", () => L.appleAlbumLink(r.album, r.artist));
    if (L.spotifyReady()) field(r, "spotify", () => L.spotifyAlbumLink(r.album, r.artist));
    field(r, "tracks", () => L.findTracks(r.album, r.artist));
    field(r, "apple_artist", () => L.artistLink("apple", r.artist));
    if (L.spotifyReady()) field(r, "spotify_artist", () => L.artistLink("spotify", r.artist));
  }
  // A few at a time so Apple's ~20 requests a minute limit isn't hit all at once.
  let i = 0;
  const worker = async () => { while (i < jobs.length && Date.now() < deadline) await jobs[i++](); };
  await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
}

/* ---------- the club's data ---------- */

/**
 * Most picked song among the members' picks, written like the old sheet did ("Song  (2 votes)").
 * One pick alone is shown as is; no picks or no overlap is "No agreement yet", which the app hides.
 */
const NO_AGREEMENT = "No agreement yet";
function groupSong(values: string[]) {
  const v = values.filter(Boolean);
  if (!v.length) return NO_AGREEMENT;
  const order: string[] = [], count = new Map<string, number>();
  for (const s of v) { if (!count.has(s)) order.push(s); count.set(s, (count.get(s) || 0) + 1); }
  const m = Math.max(...count.values());
  if (m > 1) return order.find((s) => count.get(s) === m) + "  (" + m + " votes)";
  return v.length > 1 ? NO_AGREEMENT : v[0];
}

/** Keeps OPEN_WEEKS_AHEAD open Thursdays ready past today (the sheet needed rows added by hand). */
async function ensureWeeks() {
  const today = todayYmd();
  const [{ max, ahead }] = await sql`select max(id)::int max, count(*) filter (where week >= ${today})::int ahead from club.albums where kind = 'pick'`;
  if (ahead >= OPEN_WEEKS_AHEAD) return;
  const start = (max || FIRST_ROW - 1) + 1;
  const ids = Array.from({ length: OPEN_WEEKS_AHEAD - ahead }, (_, i) => start + i);
  await sql`insert into club.albums ${sql(ids.map((id) => ({ id, kind: "pick", week: weekOfRow(id) })))} on conflict do nothing`;
}

async function getData(s: Session | null) {
  await ensureWeeks();
  const [members, seasons, rows, ratings] = await Promise.all([
    loadMembers(), loadSeasons(),
    sql`select id, kind, to_char(week, 'YYYY-MM-DD') week, album, artist, year, picked_by, cover, spotify, apple,
               spotify_artist, apple_artist, tracks from club.albums order by id`,
    sql`select album_id, member, score, fav, least, comment, rated_at from club.ratings`,
  ]);
  await fillLookups(rows);

  const names = members.map((m) => m.name);
  const today = todayYmd();
  const byAlbum = new Map<number, any[]>();
  for (const r of ratings) (byAlbum.get(r.album_id) || byAlbum.set(r.album_id, []).get(r.album_id)!).push(r);

  const shape = (r: any, index: number) => {
    const rs = byAlbum.get(r.id) || [];
    const get = (n: string) => rs.find((x) => x.member === n);
    const per = (f: (x: any) => any, dflt: any) => Object.fromEntries(names.map((n) => { const x = get(n); return [n, x ? f(x) : dflt]; }));
    const nums = rs.filter((x) => x.score != null && names.includes(x.member)).map((x) => Number(x.score));
    const share = r.kind === "share";
    const fav = per((x) => x.fav || "", ""), least = per((x) => x.least || "", "");
    return {
      row: r.id, ...(share ? { shared: true } : { index }), number: 0, date: r.week, season: seasonOf(seasons, r.week),
      album: r.album, artist: r.artist || "", year: r.year || "", pickedBy: r.picked_by || "",
      ratings: per((x) => x.score == null ? null : Number(x.score), null), fav, least,
      comments: per((x) => x.comment || "", ""),
      groupFav: share ? "" : groupSong(names.map((n) => fav[n])), groupLeast: share ? "" : groupSong(names.map((n) => least[n])),
      tracks: r.tracks || [],
      avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null, count: nums.length,
      spotify: r.spotify || L.searchLink("spotify", r.album + " " + (r.artist || "")),
      apple: r.apple || L.searchLink("apple", r.album + " " + (r.artist || "")),
      cover: r.cover || "", spotifyArtist: r.spotify_artist || "", appleArtist: r.apple_artist || "",
      ratedAt: share ? {} : per((x) => x.rated_at ? new Date(x.rated_at).getTime() : null, null),
    };
  };

  const picks = rows.filter((r) => r.kind === "pick");
  const albums: any[] = [], blanks: { r: any; index: number }[] = [];
  picks.forEach((r, index) => { if (r.album) albums.push(shape(r, index)); else blanks.push({ r, index }); });
  const perSeason: Record<string, number> = {};
  for (const a of albums) a.number = perSeason[a.season] = (perSeason[a.season] || 0) + 1;

  const rot = rotationOf(members);
  const turns = turnsOf(picks, rot);
  const slots = blanks.slice(0, SLOTS_SHOWN).map(({ r, index }) => ({
    row: r.id, date: r.week, season: seasonOf(seasons, r.week),
    reserved: names.includes(r.picked_by) ? r.picked_by : "", turn: turns[index] || "",
  }));

  const me = s ? members.find((m) => m.name === s.member) : null;
  const [mp] = s ? await sql`select push_prefs from club.members where name = ${s.member}` : [];
  return {
    season: seasonOf(seasons, today), currentSeason: seasonOf(seasons, today),
    seasons: seasons.map((x) => ({ name: x.name, start: x.start, count: perSeason[x.name] || 0 })),
    me: { email: me?.email || "", name: me?.name || "", admin: !!me?.is_admin, platform: me?.platform || "", push: pushPrefs(mp?.push_prefs) },
    members: names,
    albums,
    shared: rows.filter((r) => r.kind === "share" && r.album).map((r) => shape(r, 0)),
    shareDays: SHARE_DAYS,
    slots, turn: slots.length ? slots[0].turn : "",
    rotation: rot, commentMax: COMMENT_MAX,
    waitAlbum: await waitAlbum(),
    today,
  };
}

/** Whose week each pick row is: its picker, a name reserved on an open week, or next in the rotation. */
function turnsOf(picks: any[], rot: string[]) {
  let prev = "";
  return picks.map((r) => {
    const name = rot.includes(r.picked_by) ? r.picked_by : r.album ? "" : rot[(rot.indexOf(prev) + 1) % rot.length];
    if (name) prev = name;
    return name;
  });
}

async function waitAlbum() {
  const w = WAIT_ALBUM;
  if (!w) return null;
  let saved = await kvGet("waitAlbum");
  if (!saved || saved.album !== w.album) {
    const [cover, apple, spotify, appleArtist, spotifyArtist] = await Promise.all([
      L.findCover(w.album, w.artist), L.appleAlbumLink(w.album, w.artist).catch(() => ""),
      L.spotifyAlbumLink(w.album, w.artist).catch(() => ""), L.artistLink("apple", w.artist).catch(() => ""),
      L.artistLink("spotify", w.artist).catch(() => ""),
    ]);
    saved = { album: w.album, cover, apple, spotify, appleArtist, spotifyArtist };
    if (cover) await kvSet("waitAlbum", saved);
  }
  return {
    album: w.album, artist: w.artist, year: w.year, cover: saved.cover || "",
    spotify: saved.spotify || L.searchLink("spotify", w.album + " " + w.artist),
    apple: saved.apple || L.searchLink("apple", w.album + " " + w.artist),
    spotifyArtist: saved.spotifyArtist || "", appleArtist: saved.appleArtist || "",
  };
}

/* ---------- rating ---------- */

async function submitRating(s: Session, row: unknown, _member: unknown, score: unknown, fav: unknown, least: unknown, comment: unknown) {
  const sc = checkScore(score);
  const id = Number(row);
  let text: string | null = null;
  if (comment != null) {
    text = String(comment).trim();
    if (text.length > COMMENT_MAX) fail(`Comments can be up to ${COMMENT_MAX} characters.`);
  }
  const first = await locked(async (tx) => {
    const [a] = await tx`select id from club.albums where id = ${id} and album is not null`;
    if (!a) fail("That album could not be found.");
    const [prev] = await tx`select score from club.ratings where album_id = ${id} and member = ${s.member}`;
    await tx`
      insert into club.ratings (album_id, member, score, fav, least, comment, rated_at)
      values (${id}, ${s.member}, ${sc}, ${fav == null ? "" : String(fav)}, ${least == null ? "" : String(least)}, ${text ?? ""}, now())
      on conflict (album_id, member) do update set
        score = excluded.score,
        fav = case when ${fav == null} then ratings.fav else excluded.fav end,
        least = case when ${least == null} then ratings.least else excluded.least end,
        comment = case when ${text == null} then ratings.comment else excluded.comment end,
        rated_at = case when ratings.score is null and ratings.rated_at is null then now() else ratings.rated_at end`;
    return !prev || prev.score == null;
  });
  if (first) await inBackground(ratedNote(s.member, id));
  return getData(s);
}

/** "Luke rated X · 3 of 5 have rated it" (no score, so nobody is swayed), or the group average once everyone has. */
async function ratedNote(member: string, id: number) {
  const [a] = await sql`select album, kind from club.albums where id = ${id}`;
  const names = (await loadMembers()).map((m) => m.name);
  const scores = (await sql`select member, score from club.ratings where album_id = ${id} and score is not null`).filter((r) => names.includes(r.member));
  const all = a.kind === "pick" && scores.length === names.length;
  const avg = scores.reduce((t, r) => t + Number(r.score), 0) / (scores.length || 1);
  await notify("ratings", all
    ? { title: `Everyone has rated ${a.album}`, body: `${member} was last in. Group average: ${(Math.round(avg * 100) / 100).toString()}`, tag: "rated-" + id, url: `./?go=album&row=${id}` }
    : { title: `${member} rated ${a.album}`, body: a.kind === "pick" ? `${scores.length} of ${names.length} have rated it.` : "Heard it before share", tag: "rated-" + id, url: `./?go=album&row=${id}` },
    { except: member });
}

/* ---------- New Album Thursday ---------- */

async function submitPick(s: Session, _member: unknown, album: unknown, artist: unknown, year: unknown, cover: unknown, replaceRow: unknown) {
  const p = checkAlbumInput(album, artist, year);
  const today = todayYmd();
  const replace = replaceRow ? Number(replaceRow) : null;
  await ensureWeeks();
  const result = await locked(async (tx) => {
    const members = await tx`select name, rotation from club.members order by rotation`;
    const rot = members.map((m) => m.name);
    const seasons = await tx`select name, to_char(start, 'YYYY-MM-DD') as start from club.seasons order by start` as any;
    const picks = await tx`select a.id, to_char(a.week, 'YYYY-MM-DD') week, a.album, a.artist, a.picked_by,
                                  exists (select 1 from club.ratings r where r.album_id = a.id and r.score is not null) rated
                             from club.albums a where kind = 'pick' order by id`;
    for (const r of picks) {
      if (r.id === replace || !r.album) continue;
      if (normName(r.album) === normName(p.album) && normName(r.artist) === normName(p.artist)) {
        fail(`${p.album} by ${p.artist} has already been picked` +
          (r.picked_by ? ` (${r.picked_by}'s pick, ${seasonOf(seasons, r.week)}, ${pretty(r.week)})` : "") + ".");
      }
    }
    let target: any;
    if (replace) {
      target = picks.find((r) => r.id === replace);
      if (!target?.album) fail("That pick could not be found.");
      if (target.picked_by !== s.member) fail("You can only change your own pick.");
      if (target.rated) fail("People have already rated that one, so it can't be swapped.");
      if (target.week < today) fail("That Thursday has already passed.");
    } else {
      const ahead = picks.find((r) => r.album && r.picked_by === s.member && r.week > today && !r.rated);
      if (ahead) fail(`You already have ${ahead.album} lined up for ${pretty(ahead.week)}. Change that one instead.`);
      const turns = turnsOf(picks, rot);
      target = picks.find((r, i) => !r.album && turns[i] === s.member);
      if (!target) fail("You don't have another turn in the open weeks yet.");
    }
    await tx`update club.albums set album = ${p.album}, artist = ${p.artist}, year = ${p.year || null}, picked_by = ${s.member},
               cover = ${httpsOrNull(cover)}, spotify = null, apple = null, spotify_artist = null, apple_artist = null, tracks = null
             where id = ${target.id}`;
    await tx`delete from club.kv where key like ${"miss|%|" + target.id}`;
    return { row: target.id, date: target.week, season: seasonOf(seasons, target.week) };
  });
  await inBackground(notify("picks", {
    title: replace ? `${s.member} changed their pick` : `${s.member} picked an album`,
    body: `${p.album} by ${p.artist}, for ${pretty(result.date)}`, tag: "album-" + result.row, url: `./?go=album&row=${result.row}`,
  }, { except: s.member }));
  return { ...result, data: await getData(s) };
}

async function removePick(s: Session, row: unknown, freeWeek: unknown) {
  const id = Number(row);
  const today = todayYmd();
  const result = await locked(async (tx) => {
    const [a] = await tx`select id, album, picked_by, to_char(week, 'YYYY-MM-DD') week,
                                exists (select 1 from club.ratings r where r.album_id = albums.id and r.score is not null) rated
                           from club.albums where id = ${id} and kind = 'pick'`;
    if (!a?.album) fail("That album could not be found.");
    if (a.picked_by !== s.member && !s.admin) fail(`Only ${a.picked_by || "the person who picked it"} can remove this album.`);
    if (a.rated) fail(`Someone has already rated ${a.album}, so it can't be removed.`);
    if (a.week < today) fail("That Thursday has already passed.");
    await tx`update club.albums set album = null, artist = null, year = null, cover = null, spotify = null, apple = null,
               spotify_artist = null, apple_artist = null, tracks = null
               ${freeWeek ? tx`, picked_by = null` : tx``}
             where id = ${id}`;
    await tx`delete from club.ratings where album_id = ${id}`;
    return { album: a.album, date: a.week };
  });
  return { ...result, data: await getData(s) };
}

/* ---------- "Heard it before" shares ---------- */

async function submitShare(s: Session, album: unknown, artist: unknown, year: unknown, cover: unknown, pickRow: unknown, replaceRow: unknown) {
  const p = checkAlbumInput(album, artist, year);
  const today = todayYmd();
  const replace = replaceRow ? Number(replaceRow) : null;
  const result = await locked(async (tx) => {
    const [pick] = await tx`select album, picked_by, to_char(week, 'YYYY-MM-DD') week from club.albums where id = ${Number(pickRow)} and kind = 'pick'`;
    if (!pick?.album || pick.picked_by !== s.member) fail("Pick your album for the week first, then share one.");
    if (shiftDays(pick.week, SHARE_DAYS) < today) fail("That week is over, so it can't get a share now.");
    const all = await tx`select a.id, a.kind, a.album, a.artist, a.picked_by, to_char(a.week, 'YYYY-MM-DD') week,
                                exists (select 1 from club.ratings r where r.album_id = a.id and r.score is not null and r.member <> a.picked_by) rated_by_others
                           from club.albums a where a.album is not null`;
    for (const r of all) {
      if (r.id === replace) continue;
      const same = normName(r.album) === normName(p.album) && normName(r.artist) === normName(p.artist);
      if (same && r.kind === "pick") fail(`${p.album} was already a club pick${r.picked_by ? ` (${r.picked_by})` : ""}.`);
      if (same) fail(`${p.album} has already been shared by ${r.picked_by || "someone"}.`);
      if (r.kind === "share" && r.picked_by === s.member && r.week === pick.week) fail(`You already shared ${r.album} this week. Swap that one instead.`);
    }
    let id: number;
    if (replace) {
      const cur = all.find((r) => r.id === replace && r.kind === "share");
      if (!cur) fail("That share could not be found.");
      if (cur!.picked_by !== s.member) fail("You can only change your own share.");
      if (cur!.rated_by_others) fail("People have already rated that one, so it can't be swapped.");
      await tx`delete from club.ratings where album_id = ${replace}`;
      id = replace;
    } else {
      const [{ next }] = await tx`select greatest(max(id) + 1, ${SHARE_BASE + 2})::int next from club.albums where kind = 'share'`;
      id = next;
    }
    await tx`insert into club.albums (id, kind, week, album, artist, year, picked_by, cover)
             values (${id}, 'share', ${pick.week}, ${p.album}, ${p.artist}, ${p.year || null}, ${s.member}, ${httpsOrNull(cover)})
             on conflict (id) do update set week = excluded.week, album = excluded.album, artist = excluded.artist, year = excluded.year,
               picked_by = excluded.picked_by, cover = excluded.cover, spotify = null, apple = null, spotify_artist = null, apple_artist = null, tracks = null`;
    await tx`delete from club.kv where key like ${"miss|%|" + id}`;
    return { album: p.album, date: pick.week, row: id };
  });
  await inBackground(notify("picks", {
    title: `${s.member} shared one they've heard before`, body: `${p.album} by ${p.artist}`, tag: "album-" + result.row, url: `./?go=album&row=${result.row}`,
  }, { except: s.member }));
  return { ...result, data: await getData(s) };
}

async function removeShare(s: Session, row: unknown) {
  const id = Number(row);
  const result = await locked(async (tx) => {
    const [a] = await tx`select album, picked_by,
        exists (select 1 from club.ratings r where r.album_id = albums.id and r.score is not null and r.member <> albums.picked_by) rated_by_others
      from club.albums where id = ${id} and kind = 'share'`;
    if (!a?.album) fail("That share could not be found.");
    if (a.picked_by !== s.member && !s.admin) fail(`Only ${a.picked_by || "the person who shared it"} can remove this one.`);
    if (a.rated_by_others) fail(`Someone has already rated ${a.album}, so it can't be removed.`);
    // Keep the row with no album (like the old tab), so share numbers are never reused.
    await tx`update club.albums set album = null, artist = null, year = null, cover = null, spotify = null, apple = null,
               spotify_artist = null, apple_artist = null, tracks = null where id = ${id}`;
    await tx`delete from club.ratings where album_id = ${id}`;
    return { album: a.album };
  });
  return { ...result, data: await getData(s) };
}

/* ---------- song links ---------- */

async function songLinks(row: unknown, platform: unknown, songs: unknown) {
  const p = platform === "apple" ? "apple" : "spotify";
  const list = (Array.isArray(songs) ? songs : []).map((x) => String(x || "").trim())
    .filter((x, i, all) => x && all.indexOf(x) === i).slice(0, 12);
  if (!list.length) return {};
  const [a] = await sql`select id, album, artist, spotify, apple from club.albums where id = ${Number(row)} and album is not null`;
  if (!a) fail("That album could not be found.");
  const keyOf = async (song: string) => `song|${p}|${(await sha256([a.album, a.artist, song].join("|").toLowerCase())).slice(0, 32)}`;
  const keys = await Promise.all(list.map(keyOf));
  const saved = new Map((await sql`select key, value from club.kv where key in ${sql(keys)} and (expires is null or expires > now())`).map((r) => [r.key, r.value]));
  const out: Record<string, string> = {}, todo: number[] = [];
  list.forEach((song, i) => {
    const v = saved.get(keys[i]);
    if (typeof v === "string" && v) out[song] = v;
    else if (v === false) out[song] = L.searchLink(p, song + " " + (a.artist || ""));
    else todo.push(i);
  });
  if (!todo.length) return out;
  let tracks: { name: string; url: string }[] = [];
  try { tracks = await L.albumTracksWithLinks(p, (p === "apple" ? a.apple : a.spotify) || ""); } catch { /* search each song */ }
  await Promise.all(todo.map(async (i) => {
    const song = list[i];
    let url = "";
    try { url = await L.findSong(p, tracks, song, a.artist || ""); } catch { url = ""; }
    if (url) { await kvSet(keys[i], url); out[song] = url; }
    else { await kvSet(keys[i], false, 6); out[song] = L.searchLink(p, song + " " + (a.artist || "")); }
  }));
  return out;
}

/* ---------- chat ---------- */

async function chatGen() { return String((await kvGet("chat|gen")) ?? "1"); }

/** here = the app is on screen right now: no phone notifications while that's true (see notify). */
async function getChat(s: Session, sinceArg: unknown, gen: unknown, here?: unknown) {
  if (here === true) await sql`update club.members set active_at = now() where name = ${s.member}`;
  let since = Math.max(0, Number(sinceArg) || 0);
  const [[{ last }], g] = await Promise.all([sql`select coalesce(max(id), 0)::int last from club.chat`, chatGen()]);
  if (String(gen || "") !== g) since = 0;
  if (since && since >= last) return { last, gen: g, messages: [], full: false };
  const rowOf = (r: any) => ({ id: Number(r.id), time: new Date(r.at).getTime(), name: r.name, text: r.text });
  if (since) {
    const fresh = await sql`select * from club.chat where id > ${since} and text <> '' order by id limit ${CHAT_LOAD + 1}`;
    if (fresh.length <= CHAT_LOAD) return { last, gen: g, messages: fresh.map(rowOf), full: false };
  }
  const rows = await sql`select * from (select * from club.chat where text <> '' order by id desc limit ${CHAT_LOAD}) t order by id`;
  return { last, gen: g, messages: rows.map(rowOf), full: true };
}

async function postChat(s: Session, textArg: unknown) {
  const text = String(textArg ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) fail("Type a message first.");
  if (text.length > CHAT_MAX) fail(`Keep messages under ${CHAT_MAX} characters.`);
  await rateLimit("chat|" + s.member, CHAT_PER_MINUTE, 60, "Slow down a little. Try again in a minute.");
  return locked(async (tx) => {
    const [r] = await tx`insert into club.chat (id, name, text) select coalesce(max(id), 0) + 1, ${s.member}, ${text} from club.chat returning id, at`;
    return { id: Number(r.id), time: new Date(r.at).getTime(), name: s.member, text };
  }).then(async (msg) => {
    await inBackground(chatPing(msg.id));
    await inBackground(notify("chat", { title: s.member, body: chatPreview(text), tag: "chat", url: "./?go=chat", urgency: "high" }, { except: s.member }));
    return msg;
  });
}

async function deleteChat(s: Session, idArg: unknown) {
  const id = Number(idArg);
  const [m] = await sql`select name, text from club.chat where id = ${id}`;
  if (!m || !m.text) fail("That message is already gone.");
  if (m.name !== s.member && !s.admin) fail("You can only delete your own messages.");
  await sql`update club.chat set text = '' where id = ${id}`;   // keeps the id, so ids are never reused
  await kvSet("chat|gen", String(Date.now()));
  await inBackground(chatPing(id));
  return true;
}

/* ---------- live chat ----------
 * Open apps keep a socket to Supabase Realtime on a public broadcast channel. The server
 * only says "chat changed" there (no names, no text, since anyone with the public key could
 * listen); each app then asks getChat with its session as usual. Polling stays on as backup. */
const LIVE_TOPIC = "club-chat";

function chatLive() {
  const base = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!base || !key) return null;
  return { url: base.replace(/^http/, "ws") + "/realtime/v1/websocket", key, topic: LIVE_TOPIC };
}

async function chatPing(last: number) {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
  if (!base || !key || Deno.env.get("CLUB_TEST")) return;
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const r = await fetch(base + "/realtime/v1/api/broadcast", {
    method: "POST", headers, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ messages: [{ topic: LIVE_TOPIC, event: "chat", payload: { last } }] }),
  });
  if (!r.ok) console.error("chatPing", r.status, await r.text());
}

/* ---------- phone notifications ---------- */

const PUSH_KINDS = ["chat", "picks", "ratings", "reminders"] as const;
type PushKind = typeof PUSH_KINDS[number];
const PUSH_SUBJECT = "https://clubmusic.net";
const PUSH_PER_MEMBER = 10;
const IN_APP_SECONDS = 45;     // the open app checks chat at least every 30s while on screen

/** The club's VAPID key pair: made the first time it's needed and kept in kv (never leaves the database). */
let vapidKeys: Push.VapidKeys | null = null;
async function vapid(): Promise<Push.VapidKeys> {
  if (vapidKeys) return vapidKeys;
  let v = await kvGet("vapid");
  if (!v) {
    await sql`insert into club.kv (key, value) values ('vapid', ${sql.json(await Push.makeVapidKeys() as any)}) on conflict do nothing`;
    v = await kvGet("vapid");
  }
  return vapidKeys = v;
}

function pushPrefs(raw: any) {
  const out: Record<PushKind, boolean> = { chat: true, picks: true, ratings: true, reminders: true };
  for (const k of PUSH_KINDS) if (raw && typeof raw[k] === "boolean") out[k] = raw[k];
  return out;
}

/**
 * Sends a note to every phone whose member wants this kind, except `except`
 * (or only to `only`). Subscriptions the push service says are gone are removed.
 */
async function notify(kind: PushKind | "test", note: Push.Note, opts: { except?: string; only?: string[] } = {}) {
  // "here": that member has the app open on screen (checked in within IN_APP_SECONDS), so skip them.
  // Test notes always go, since you press that button from inside the app.
  const subs = await sql`select s.endpoint, s.p256dh, s.auth, s.member, m.push_prefs,
                           coalesce(m.active_at > now() - make_interval(secs => ${IN_APP_SECONDS}), false) here
                         from club.push_subs s join club.members m on m.name = s.member`;
  const to = subs.filter((r) => (kind === "test" || (pushPrefs(r.push_prefs)[kind] && !r.here)) &&
    r.member !== opts.except && (!opts.only || opts.only.includes(r.member)));
  if (!to.length) return 0;
  const keys = await vapid();
  const results = await Promise.all(to.map((r) => Push.sendOne({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, note, keys, PUSH_SUBJECT)));
  const gone = to.filter((_, i) => results[i] === "gone").map((r) => r.endpoint);
  const ok = to.filter((_, i) => results[i] === "ok").map((r) => r.endpoint);
  if (gone.length) await sql`delete from club.push_subs where endpoint in ${sql(gone)}`;
  if (ok.length) await sql`update club.push_subs set last_ok = now() where endpoint in ${sql(ok)}`;
  return ok.length;
}

/** Lets the reply go back right away while the notes go out (Supabase keeps the function running for them). */
function inBackground(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error("notify", e));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil && !Deno.env.get("CLUB_TEST")) { rt.waitUntil(safe); return; }
  return safe;
}

const short = (t: string, n = 140) => t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
const chatPreview = (text: string) => /^\[GIF\] https:\/\//.test(text) ? "sent a GIF" : short(text.replace(/\s+/g, " "));

async function pushSubscribe(s: Session, sub: any) {
  const endpoint = String(sub?.endpoint || ""), p256dh = String(sub?.keys?.p256dh || ""), auth = String(sub?.keys?.auth || "");
  if (!Push.okEndpoint(endpoint)) fail("This browser's notification service isn't supported.");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) fail("That notification subscription looks broken. Try turning notifications off and on.");
  await sql`insert into club.push_subs (endpoint, member, session_hash, p256dh, auth) values (${endpoint}, ${s.member}, ${s.hash}, ${p256dh}, ${auth})
            on conflict (endpoint) do update set member = excluded.member, session_hash = excluded.session_hash, p256dh = excluded.p256dh, auth = excluded.auth`;
  await sql`delete from club.push_subs where member = ${s.member} and endpoint not in (
              select endpoint from club.push_subs where member = ${s.member} order by created desc limit ${PUSH_PER_MEMBER})`;
  return true;
}

async function setPushPrefs(s: Session, raw: any) {
  const [m] = await sql`select push_prefs from club.members where name = ${s.member}`;
  const prefs = pushPrefs(m?.push_prefs);
  for (const k of PUSH_KINDS) if (raw && typeof raw[k] === "boolean") prefs[k] = raw[k];
  await sql`update club.members set push_prefs = ${sql.json(prefs)} where name = ${s.member}`;
  return prefs;
}

/** Called on a schedule by GitHub Actions (push-reminders.yml). Safe to call twice: each note goes out once. */
async function pushCron(secretArg: unknown) {
  const secret = Deno.env.get("CRON_SECRET") || "";
  if (secret.length < 32 || String(secretArg || "") !== secret) fail("Not allowed.");
  const today = todayYmd();
  const weekday = new Date(today + "T12:00:00Z").getUTCDay();   // 4 = Thursday
  const once = async (key: string) => (await sql`insert into club.kv (key, value, expires) values (${"pushsent|" + key}, 'true', now() + interval '30 days')
                                               on conflict do nothing returning key`).length > 0;
  const sent: string[] = [];
  const members = await loadMembers();
  const names = members.map((m) => m.name);
  const picks = await sql`select id, to_char(week, 'YYYY-MM-DD') week, album, artist, picked_by from club.albums where kind = 'pick' order by id`;
  const current = [...picks].reverse().find((r) => r.album && r.week <= today);

  if (weekday === 4) {
    // New Album Thursday
    const drop = picks.find((r) => r.week === today && r.album);
    if (drop && await once("release|" + drop.id)) {
      await notify("picks", { title: "New Album Thursday", body: `${drop.album} by ${drop.artist}` + (drop.picked_by ? ` (${drop.picked_by}'s pick)` : ""),
        tag: "album-" + drop.id, url: `./?go=album&row=${drop.id}`, ttl: 12 * 3600 });
      sent.push("release");
    }
  } else if (current) {
    // A nudge before the next album: whoever hasn't rated the current one yet.
    const rated = new Set((await sql`select member from club.ratings where album_id = ${current.id} and score is not null`).map((r) => r.member));
    const behind = names.filter((n) => !rated.has(n));
    if (behind.length && await once(`remind|${current.id}|${today}`)) {
      await notify("reminders", { title: `Still need to rate ${current.album}`, body: "The next album drops Thursday. Get your score in.",
        tag: "remind-" + current.id, url: `./?go=rate&row=${current.id}`, ttl: 12 * 3600 }, { only: behind });
      sent.push("remind:" + behind.join(","));
    }
    // And whoever picks for the coming Thursday, if they haven't yet.
    const turns = turnsOf(picks, rotationOf(members));
    const i = picks.findIndex((r) => r.week > today);
    const next = picks[i];
    if (next && !next.album && turns[i] && next.week <= shiftDays(today, 7) && await once(`turn|${next.id}|${today}`)) {
      await notify("reminders", { title: "Your turn to pick", body: `Pick the album for ${pretty(next.week)}.`, tag: "turn", url: "./?go=add", ttl: 12 * 3600 }, { only: [turns[i]] });
      sent.push("turn:" + turns[i]);
    }
  }
  if (Math.random() < 0.2) await sql`delete from club.kv where key like 'pushsent|%' and expires < now()`;
  return { today, sent };
}

/* ---------- dispatch ---------- */

const WRITES = new Set(["submitRating", "submitPick", "removePick", "submitShare", "removeShare", "postChat", "deleteChat", "setPlatform"]);
let liveMarked = false;

async function dispatch(req: any) {
  const action = String(req?.action || "");
  const a = Array.isArray(req?.args) ? req.args : [];

  switch (action) {
    case "members": return (await loadMembers()).map((m) => m.name);
    case "requestCode": return requestCode(a[0]);
    case "verifyCode": return verifyCode(a[0], a[1]);
    case "useAppKey": return useAppKey(a[0]);
    case "ping": return (await sql`select 1 ok`)[0].ok;   // keep alive (Free plan pauses after a quiet week)
    case "pushCron": return pushCron(a[0]);
    case "pushKey": return (await vapid()).publicKey;
  }

  const s = await sessionFor(req?.session);
  if (!s) throw new Error("SIGNED_OUT");
  if (!liveMarked && WRITES.has(action)) {
    // Once the club saves anything here, the one time copy from the sheet refuses to run again.
    await sql`insert into club.kv (key, value) values ('live', ${sql.json(new Date().toISOString())}) on conflict do nothing`;
    liveMarked = true;
  }

  switch (action) {
    case "getData": return getData(s);
    case "submitRating": return submitRating(s, a[0], a[1], a[2], a[3], a[4], a[5]);
    case "searchAlbums": return L.searchAlbums(a[0]);
    case "submitPick": return submitPick(s, a[0], a[1], a[2], a[3], a[4], a[5]);
    case "removePick": return removePick(s, a[0], a[1]);
    case "submitShare": return submitShare(s, a[0], a[1], a[2], a[3], a[4], a[5]);
    case "removeShare": return removeShare(s, a[0]);
    case "getChat": return getChat(s, a[0], a[1], a[2]);
    case "chatAway": await sql`update club.members set active_at = null where name = ${s.member}`; return true;
    case "chatLive": return chatLive();
    case "postChat": return postChat(s, a[0]);
    case "deleteChat": return deleteChat(s, a[0]);
    case "gifKey": return Deno.env.get("KLIPY_API_KEY") || "";
    case "avatars": return Object.fromEntries((await sql`select name, avatar from club.members where avatar is not null`).map((r) => [r.name, r.avatar]));
    case "faces": return (await kvGet("faces")) || {};
    case "setPlatform": {
      const p = String(a[0] || "");
      if (p !== "spotify" && p !== "apple") fail("Pick Spotify or Apple Music.");
      await sql`update club.members set platform = ${p} where name = ${s.member}`;
      return p;
    }
    case "songLinks": return songLinks(a[0], a[1], a[2]);
    case "appKey": return appKey(s);
    case "pushSubscribe": return pushSubscribe(s, a[0]);
    case "pushUnsubscribe":
      await sql`delete from club.push_subs where endpoint = ${String(a[0] || "")} and member = ${s.member}`;
      return true;
    case "pushPrefs": return setPushPrefs(s, a[0]);
    case "pushTest": {
      await rateLimit("pushtest|" + s.member, 5, 600, "That's a lot of tests. Try again in a few minutes.");
      const n = await notify("test", { title: "Notifications are on", body: "This is how Club Music will reach you.", tag: "test", url: "./" }, { only: [s.member] });
      if (!n) fail("Couldn't reach this phone. Turn notifications off and on, then try again.");
      return n;
    }
    case "signOut":
      await sql`delete from club.app_keys where session_hash = ${s.hash}`;
      await sql`delete from club.sessions where token_hash = ${s.hash}`;
      return true;
  }
  fail("Unknown action: " + action);
}

const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") || "https://clubmusic.net,https://club-music.net").split(",").map((x) => x.trim());

export async function handle(request: Request): Promise<Response> {
  const origin = request.headers.get("Origin") || "";
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return new Response("Club Music API", { status: 200, headers: cors });

  let out: unknown;
  try {
    const body = await request.text();
    if (body.length > 20000) fail("That request is too big.");
    out = { ok: true, result: await dispatch(JSON.parse(body || "{}")) };
  } catch (err) {
    const msg = err instanceof UserError || (err as Error)?.message === "SIGNED_OUT" ? (err as Error).message : "Something went wrong on the server. Try again in a moment.";
    if (!(err instanceof UserError) && (err as Error)?.message !== "SIGNED_OUT") console.error(err);
    out = { ok: false, error: msg };
  }
  return new Response(JSON.stringify(out), { headers: { ...cors, "Content-Type": "application/json" } });
}

if (!Deno.env.get("CLUB_TEST")) Deno.serve(handle);

export { dispatch, getData, groupSong, turnsOf, sql };
