// Loads the Apps Script export into the Supabase database (one transaction; replaces what's there).
//
//   deno run -A supabase/scripts/import.ts <export.json> <Members.gs> <Avatars.html> [FacePoints.gs]
//
// DB_URL must point at the database. Nothing personal is printed: only counts.

import postgres from "npm:postgres@3.4.5";

const [exportPath, membersPath, avatarsPath, facesPath] = Deno.args;
const ex = JSON.parse(await Deno.readTextFile(exportPath));
const membersGs = await Deno.readTextFile(membersPath);
const avatarsHtml = avatarsPath ? await Deno.readTextFile(avatarsPath).catch(() => "") : "";
const facesGs = facesPath ? await Deno.readTextFile(facesPath).catch(() => "") : "";

// Members.gs: AD_MEMBER_EMAILS = { 'email': 'Name', ... }
const emails: Record<string, string> = {};
for (const m of membersGs.matchAll(/["']([^"'\s]+@[^"'\s]+)["']\s*:\s*["']([^"']+)["']/g)) emails[m[2].trim()] = m[1].trim().toLowerCase();
// Avatars: AVATARS = { Name: 'data:image/...' }
const avatars: Record<string, string> = {};
for (const m of avatarsHtml.matchAll(/["']?([A-Za-z][\w ]*)["']?\s*:\s*["'](data:image\/[^"']+)["']/g)) avatars[m[1].trim()] = m[2];
let faces: unknown = {};
const fm = facesGs.match(/AD_FACE_POINTS\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
if (fm) { try { faces = JSON.parse(fm[1]); } catch { faces = {}; } }

const names: string[] = ex.members;
for (const n of names) if (!emails[n]) throw new Error(`No email for member ${n} in Members.gs`);

const isSearch = (u: string) => !u || /\/search(\/|\?)/.test(u);
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (x) => x.toString(16).padStart(2, "0")).join("");

const sql = postgres(Deno.env.get("DB_URL")!, { prepare: false, max: 1, onnotice: () => {} });
const d = ex.data;
const albumsByRow = new Map<number, any>(d.albums.map((a: any) => [a.row, a]));

const [live] = await sql`select value from club.kv where key = 'live'`.catch(() => [] as any[]);
if (live && Deno.env.get("FORCE_IMPORT") !== "yes") {
  console.log(`Not importing: the club has been saving to Supabase since ${live.value}, and an import would erase that.`);
  await sql.end();
  Deno.exit(1);
}

await sql.begin(async (tx) => {
  await tx`set local search_path = club`;
  await tx`truncate ratings, chat, sessions, app_keys, codes, signin_counts, rate_hits, kv, albums, members, seasons cascade`;

  await tx`insert into seasons ${tx(ex.seasons.map((s: any) => ({ name: s.name, start: s.start })))}`;
  const rot = [...ex.rotation.filter((n: string) => names.includes(n)), ...names.filter((n) => !ex.rotation.includes(n))];
  await tx`insert into members ${tx(names.map((n, i) => ({
    name: n, email: emails[n], sort: i, rotation: rot.indexOf(n), is_admin: ex.admins.includes(n),
    platform: ["spotify", "apple"].includes(ex.platforms[n]) ? ex.platforms[n] : null, avatar: avatars[n] || null,
  })))}`;

  // Weeks: every row of the season tab. Rows without a date get one from their position.
  const firstDated = ex.rows.find((r: any) => r.date);
  const weekOf = (row: number, date: string) => {
    if (date) return date;
    const [y, m, dd] = firstDated.date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd + 7 * (row - firstDated.row), 12)).toISOString().slice(0, 10);
  };
  const albumRow = (a: any, kind: string, id: number, week: string) => ({
    id, kind, week, album: a.album, artist: a.artist || null, year: a.year || null, picked_by: names.includes(a.pickedBy) ? a.pickedBy : null,
    cover: a.cover || null, spotify: isSearch(a.spotify) ? null : a.spotify, apple: isSearch(a.apple) ? null : a.apple,
    spotify_artist: a.spotifyArtist || null, apple_artist: a.appleArtist || null, tracks: a.tracks?.length ? a.tracks : null,
  });
  const weekRows = ex.rows.map((r: any) => {
    const a = albumsByRow.get(r.row);
    const week = weekOf(r.row, r.date);
    if (a) return albumRow(a, "pick", r.row, week);
    return { id: r.row, kind: "pick", week, album: null, artist: null, year: null, picked_by: names.includes(r.pickedBy) ? r.pickedBy : null,
      cover: null, spotify: null, apple: null, spotify_artist: null, apple_artist: null, tracks: null };
  });
  const shares = d.shared.map((a: any) => albumRow(a, "share", a.row, a.date));
  // Removed shares keep their numbers so they're never reused.
  const shareIds = new Set(shares.map((s: any) => s.id));
  const gone = (ex.shareRows || []).filter((id: number) => !shareIds.has(id)).map((id: number) => ({
    id, kind: "share", week: firstDated.date, album: null, artist: null, year: null, picked_by: null,
    cover: null, spotify: null, apple: null, spotify_artist: null, apple_artist: null, tracks: null }));
  const all = [...weekRows, ...shares, ...gone];
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200).map((r) => ({ ...r, tracks: r.tracks ? tx.json(r.tracks) : null }));
    await tx`insert into albums ${tx(chunk)}`;
  }

  const ratings: any[] = [];
  for (const a of [...d.albums, ...d.shared]) {
    for (const n of names) {
      const score = a.ratings?.[n], fav = a.fav?.[n] || "", least = a.least?.[n] || "", comment = a.comments?.[n] || "";
      if (score == null && !fav && !least && !comment) continue;
      const t = a.ratedAt?.[n];
      ratings.push({ album_id: a.row, member: n, score: score ?? null, fav, least, comment: comment.slice(0, 200), rated_at: t ? new Date(t) : null });
    }
  }
  if (ratings.length) await tx`insert into ratings ${tx(ratings)}`;

  const chat = ex.chat.filter((c: any) => names.includes(c.name)).map((c: any) => ({ id: c.id, at: new Date(c.time || Date.now()), name: c.name, text: c.text }));
  for (let i = 0; i < chat.length; i += 500) await tx`insert into chat ${tx(chat.slice(i, i + 500))}`;

  const sessions = [];
  for (const s of ex.sessions) if (/^[a-f0-9]{64}$/.test(s.token)) sessions.push({ token_hash: await sha256(s.token), member: s.name, created: new Date(s.created), last_used: new Date() });
  if (sessions.length) await tx`insert into sessions ${tx(sessions)}`;
  const keys = [];
  for (const k of ex.appKeys) if (/^[a-f0-9]{64}$/.test(k.key)) keys.push({ key_hash: await sha256(k.key), member: k.name, created: new Date(k.created), session_hash: k.session ? await sha256(k.session) : null });
  if (keys.length) await tx`insert into app_keys ${tx(keys)}`;

  await tx`insert into kv (key, value) values ('chat|gen', ${tx.json(String(ex.chatGen || "1"))}), ('faces', ${tx.json(faces as any)})`;

  console.log(`Imported: ${names.length} members, ${weekRows.length} weeks (${d.albums.length} albums), ${shares.length} shares, ` +
    `${ratings.length} ratings, ${chat.length} chat messages, ${sessions.length} sign ins, ${keys.length} home screen keys, ` +
    `${Object.keys(avatars).length} photos.`);
});
await sql.end();
