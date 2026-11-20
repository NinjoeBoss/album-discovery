// Apple Music (iTunes) and Spotify lookups: covers, album/artist/song links, tracklists.
// Ported from the Apps Script files Cover Art.gs, Album Links.gs and Tracklists.gs,
// keeping the same matching rules (standard edition and explicit copy preferred).

type Item = Record<string, any>;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const EXTRAS = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded)\b/;
const EXTRAS_TRACKS = /\b(deluxe|remaster(ed)?|edition|version|live|anniversary|expanded|instrumental)\b/;

async function getJson(url: string, init?: RequestInit, tries = 3): Promise<any> {
  let wait = 800;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(6000) });
    if (res.ok) return await res.json();
    if (res.status !== 403 && res.status !== 429 && res.status < 500) throw new Error(`lookup failed (${res.status})`);
    await new Promise((r) => setTimeout(r, wait));
    wait += 800;
  }
  throw new Error("lookup service is busy");
}

const itunes = (path: string) => getJson("https://itunes.apple.com/" + path);

/* ---------- matching ---------- */

export function explicitBonus(it: Item): number {
  const e = String(it?.collectionExplicitness || it?.trackExplicitness || "").toLowerCase();
  return e === "explicit" ? 1 : e === "cleaned" ? -2 : 0;
}

function score(n: string, who: string, a: string, ar: string, extras = EXTRAS) {
  let s = 0;
  if (n === a) s += 10; else if (n.startsWith(a)) s += 5; else if (n.includes(a)) s += 2;
  if (ar && who.includes(ar)) s += 6;
  if (extras.test(n) && !extras.test(a)) s -= 3;
  return s;
}

/** Best iTunes album for a title and artist (score at least 5), or null. */
export function bestMatch(items: Item[], album: string, artist: string, opts: { explicit?: boolean; extras?: RegExp } = {}) {
  const a = norm(album), ar = norm(artist);
  let best: Item | null = null, bestScore = -1;
  for (const it of items) {
    let s = score(norm(it.collectionName), norm(it.artistName), a, ar, opts.extras);
    if (opts.explicit !== false) s += explicitBonus(it);
    if (s > bestScore) { best = it; bestScore = s; }
  }
  return bestScore >= 5 ? best : null;
}

/** Every result tied for the best score (at least 5). */
function topMatches(items: Item[], album: string, artist: string, nameOf: (x: Item) => string, artistOf: (x: Item) => string) {
  const a = norm(album), ar = norm(artist);
  const scored = items.map((it) => ({ it, s: score(norm(nameOf(it)), norm(artistOf(it)), a, ar) + explicitBonus(it) }));
  const top = Math.max(-1, ...scored.map((x) => x.s));
  return top < 5 ? [] : scored.filter((x) => x.s === top).map((x) => x.it);
}

/** Every album Apple lists for an artist (used when plain search misses one). */
export async function artistAlbums(artist: string): Promise<Item[]> {
  artist = String(artist || "").trim();
  if (!artist) return [];
  try {
    const people = (await itunes(`search?entity=musicArtist&limit=5&country=us&term=${encodeURIComponent(artist)}`)).results || [];
    const who = people.find((p: Item) => norm(p.artistName) === norm(artist)) || people[0];
    if (!who?.artistId) return [];
    const list = (await itunes(`lookup?entity=album&limit=200&country=us&id=${who.artistId}`)).results || [];
    return list.filter((r: Item) => r.wrapperType === "collection");
  } catch { return []; }
}

const big = (u: string) => u.replace("100x100bb", "600x600bb");

/* ---------- album search (Add Album page) ---------- */

export async function searchAlbums(query: string) {
  query = String(query || "").trim();
  if (query.length < 2) return [];
  let items: Item[];
  try {
    items = (await itunes(`search?entity=album&limit=25&country=us&term=${encodeURIComponent(query)}`)).results || [];
  } catch {
    throw new Error("Album search is busy right now. Try again in a minute, or type the album in by hand.");
  }
  const seen = new Set<string>(), out: Item[] = [];
  for (const it of items) {
    if (!it.collectionName) continue;
    const raw = String(it.collectionName);
    const kind = /\s-\sSingle$/i.test(raw) ? "Single" : /\s-\sEP$/i.test(raw) ? "EP" : "Album";
    const name = raw.replace(/\s-\s(Single|EP)$/i, "").trim();
    const key = norm(name) + "|" + norm(it.artistName);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      album: name, artist: String(it.artistName || ""), year: String(it.releaseDate || "").slice(0, 4),
      cover: it.artworkUrl100 ? big(it.artworkUrl100) : "", tracks: it.trackCount || 0, kind,
    });
  }
  return [...out.filter((x) => x.kind === "Album"), ...out.filter((x) => x.kind !== "Album")].slice(0, 12);
}

/* ---------- cover ---------- */

export async function findCover(album: string, artist: string): Promise<string> {
  try {
    const results = (await itunes(`search?entity=album&limit=10&country=us&term=${encodeURIComponent(album + " " + artist)}`)).results || [];
    let pick = bestMatch(results, album, artist);
    if (!pick) pick = bestMatch(await artistAlbums(artist), album, artist);
    return pick?.artworkUrl100 ? big(pick.artworkUrl100) : "";
  } catch { return ""; }
}

/* ---------- tracklist ---------- */

export async function findTracks(album: string, artist: string): Promise<string[]> {
  const results = (await itunes(`search?entity=album&limit=25&country=us&term=${encodeURIComponent(album + " " + (artist || ""))}`)).results || [];
  let pick = bestMatch(results, album, artist, { explicit: false, extras: EXTRAS_TRACKS });
  if (!pick && artist) {
    const by = (await itunes(`search?entity=album&attribute=artistTerm&limit=100&country=us&term=${encodeURIComponent(artist)}`)).results || [];
    pick = bestMatch(by, album, artist, { explicit: false, extras: EXTRAS_TRACKS });
  }
  if (!pick) return [];
  const songs = ((await itunes(`lookup?entity=song&limit=200&country=us&id=${pick.collectionId}`)).results || [])
    .filter((r: Item) => r.wrapperType === "track" && r.kind === "song")
    .sort((a: Item, b: Item) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber));
  const out: string[] = [];
  for (const s of songs) {
    const n = String(s.trackName || "").trim();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/* ---------- Spotify ---------- */

let spotifyToken: { token: string; until: number } | null = null;

async function spotify(path: string): Promise<any> {
  const id = (Deno.env.get("SPOTIFY_CLIENT_ID") || "").trim();
  const secret = (Deno.env.get("SPOTIFY_CLIENT_SECRET") || "").trim();
  if (!id || !secret) throw new Error("Spotify keys not set");
  if (!spotifyToken || Date.now() > spotifyToken.until) {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(id + ":" + secret), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`Spotify sign in failed (${res.status})`);
    const j = await res.json();
    spotifyToken = { token: j.access_token, until: Date.now() + Math.max(60, j.expires_in - 120) * 1000 };
  }
  return getJson("https://api.spotify.com/v1/" + path, { headers: { Authorization: "Bearer " + spotifyToken.token } }, 2);
}

export const spotifyReady = () => !!(Deno.env.get("SPOTIFY_CLIENT_ID") && Deno.env.get("SPOTIFY_CLIENT_SECRET"));

async function spotifyHasExplicit(albumId: string): Promise<boolean | null> {
  try { return ((await spotify(`albums/${albumId}/tracks?limit=50&market=US`)).items || []).some((t: Item) => t.explicit); }
  catch { return null; }
}

/* ---------- album links ---------- */

export async function appleAlbumLink(album: string, artist: string): Promise<string> {
  const results = (await itunes(`search?entity=album&limit=10&country=us&term=${encodeURIComponent(album + " " + (artist || ""))}`)).results || [];
  const nameOf = (r: Item) => r.collectionName, artistOf = (r: Item) => r.artistName;
  let pick = topMatches(results, album, artist, nameOf, artistOf)[0];
  let mine: Item[] | null = null;
  if (!pick) { mine = await artistAlbums(artist); pick = topMatches(mine, album, artist, nameOf, artistOf)[0]; }
  if (!pick) return "";
  if (pick.collectionExplicitness === "cleaned") {
    const n = norm(pick.collectionName);
    const exp = (mine || await artistAlbums(artist)).find((r) => r.collectionExplicitness === "explicit" && norm(r.collectionName) === n);
    if (exp?.collectionViewUrl) pick = exp;
  }
  return String(pick.collectionViewUrl || "").split("?")[0];
}

export async function spotifyAlbumLink(album: string, artist: string): Promise<string> {
  if (!spotifyReady()) return "";
  const clean = (s: string) => String(s || "").replace(/[‘’'"]/g, "").replace(/\s+/g, " ").trim();
  const a = clean(album), ar = clean(artist);
  const queries = [...(ar ? [`album:"${a}" artist:"${ar}"`] : []), ar ? a + " " + ar : a, ...(ar ? [`artist:"${ar}" ${a}`] : [])];
  for (const q of queries) {
    const items = ((await spotify(`search?type=album&limit=10&q=${encodeURIComponent(q)}`)).albums || {}).items || [];
    const tied = topMatches(items, album, artist, (x) => x.name, (x) => (x.artists || []).map((y: Item) => y.name).join(", "));
    if (!tied.length) continue;
    let pick = tied[0];
    if (tied.length > 1) {
      for (const t of tied.slice(0, 3)) if (await spotifyHasExplicit(t.id) === true) { pick = t; break; }
    }
    return pick.external_urls?.spotify || "";
  }
  return "";
}

export const searchLink = (service: string, q: string) =>
  service === "apple" ? "https://music.apple.com/us/search?term=" + encodeURIComponent(q) : "https://open.spotify.com/search/" + encodeURIComponent(q);

/* ---------- artist links ---------- */

const artistNorm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[‘’'".]/g, "").replace(/[^a-z0-9$¥]+/g, " ").trim();

function artistNames(artist: string) {
  const first = artist.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bwith\b)\s*/i)[0].trim();
  return first && first.toLowerCase() !== artist.toLowerCase() ? [artist, first] : [artist];
}

function pickArtist(items: Item[], name: string, nameOf: (x: Item) => string) {
  const n = artistNorm(name);
  const exact = items.find((it) => artistNorm(nameOf(it)) === n);
  if (exact) return exact;
  const top = items[0];
  return top && n && artistNorm(nameOf(top)).includes(n) ? top : null;
}

export async function artistLink(service: "spotify" | "apple", artist: string): Promise<string> {
  artist = String(artist || "").trim();
  if (!artist) return "";
  for (const name of artistNames(artist)) {
    if (service === "apple") {
      const items = (await itunes(`search?entity=musicArtist&limit=10&country=us&term=${encodeURIComponent(name)}`)).results || [];
      const p = pickArtist(items, name, (a) => a.artistName);
      if (p?.artistLinkUrl) return String(p.artistLinkUrl).split("?")[0];
    } else {
      if (!spotifyReady()) return "";
      const q = `artist:"${name.replace(/[‘’'"]/g, "")}"`;
      const items = ((await spotify(`search?type=artist&limit=10&q=${encodeURIComponent(q)}`)).artists || {}).items || [];
      const p = pickArtist(items, name, (a) => a.name);
      if (p?.external_urls?.spotify) return p.external_urls.spotify;
    }
  }
  return "";
}

/* ---------- song links ---------- */

const songNorm = (s: unknown) => String(s ?? "").toLowerCase()
  .replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " ").replace(/\s+-\s+.*$/, "")
  .replace(/[‘’'".]/g, "").replace(/&/g, "and").replace(/[^a-z0-9$]+/g, " ").trim();

type Track = { name: string; url: string };

function matchSong(tracks: Track[], song: string) {
  if (!tracks.length) return "";
  const exact = tracks.find((t) => t.name === song);
  if (exact) return exact.url;
  const n = songNorm(song);
  return (n && tracks.find((t) => songNorm(t.name) === n)?.url) || "";
}

const appleSongUrl = (u: string) => {
  const m = String(u).match(/^([^?]+)\?(?:.*&)?i=(\d+)/);
  return m ? m[1] + "?i=" + m[2] : String(u).split("&")[0];
};

export async function albumTracksWithLinks(service: string, albumUrl: string): Promise<Track[]> {
  if (service === "apple") {
    const m = String(albumUrl || "").match(/music\.apple\.com\/.*\/album\/(?:[^\/?]+\/)?(\d+)/);
    if (!m) return [];
    return ((await itunes(`lookup?entity=song&limit=200&country=us&id=${m[1]}`)).results || [])
      .filter((r: Item) => r.wrapperType === "track" && r.trackViewUrl)
      .map((r: Item) => ({ name: String(r.trackName || "").trim(), url: appleSongUrl(r.trackViewUrl) }));
  }
  const m = String(albumUrl || "").match(/open\.spotify\.com\/album\/([A-Za-z0-9]+)/);
  if (!m || !spotifyReady()) return [];
  const out: Track[] = [];
  let next: string | null = `albums/${m[1]}/tracks?limit=50&market=US`;
  for (let page = 0; next && page < 4; page++) {
    const j: any = await spotify(next.replace("https://api.spotify.com/v1/", ""));
    for (const t of j.items || []) if (t.external_urls?.spotify) out.push({ name: String(t.name || "").trim(), url: t.external_urls.spotify });
    next = j.next;
  }
  return out;
}

const explicitFirst = <T>(items: T[], isExp: (x: T) => boolean) => [...items.filter(isExp), ...items.filter((x) => !isExp(x))];

export async function findSong(service: string, tracks: Track[], song: string, artist: string): Promise<string> {
  const hit = matchSong(tracks, song);
  if (hit) return hit;
  const ar = artistNorm(artist);
  if (service === "apple") {
    let items = ((await itunes(`search?entity=song&limit=25&country=us&term=${encodeURIComponent(song + " " + (artist || ""))}`)).results || [])
      .filter((r: Item) => r.trackViewUrl && (!ar || artistNorm(r.artistName).includes(ar)));
    items = explicitFirst(items, (r: Item) => r.trackExplicitness === "explicit");
    return matchSong(items.map((r: Item) => ({ name: String(r.trackName || "").trim(), url: appleSongUrl(r.trackViewUrl) })), song);
  }
  if (!spotifyReady()) return "";
  const clean = (s: string) => String(s || "").replace(/[‘’'"]/g, "");
  const qs = [`track:"${clean(song)}"` + (artist ? ` artist:"${clean(artist)}"` : ""), clean(song) + " " + clean(artist)];
  for (const q of qs) {
    let items: Item[] = [];
    try { items = ((await spotify(`search?type=track&limit=10&market=US&q=${encodeURIComponent(q)}`)).tracks || {}).items || []; } catch { continue; }
    items = items.filter((t) => t.external_urls?.spotify &&
      (!ar || (t.artists || []).some((x: Item) => artistNorm(x.name).includes(ar) || ar.includes(artistNorm(x.name)))));
    items = explicitFirst(items, (t) => !!t.explicit);
    const h = matchSong(items.map((t) => ({ name: String(t.name || "").trim(), url: t.external_urls.spotify })), song);
    if (h) return h;
  }
  return "";
}

/** Apple's 30 second preview clips for an album: from its Apple Music link, or a title search if it has none. */
export async function albumPreviews(albumUrl: string, album: string, artist: string): Promise<Track[]> {
  let id = (String(albumUrl || "").match(/music\.apple\.com\/.*\/album\/(?:[^\/?]+\/)?(\d+)/) || [])[1] || "";
  if (!id) {
    const results = (await itunes(`search?entity=album&limit=10&country=us&term=${encodeURIComponent(album + " " + (artist || ""))}`)).results || [];
    id = String(bestMatch(results, album, artist)?.collectionId || "");
  }
  if (!id) return [];
  return ((await itunes(`lookup?entity=song&limit=200&country=us&id=${id}`)).results || [])
    .filter((r: Item) => r.wrapperType === "track" && /^https:\/\/[a-z0-9.-]+\.apple\.com\//.test(String(r.previewUrl || "")))
    .map((r: Item) => ({ name: String(r.trackName || "").trim(), url: String(r.previewUrl) }));
}
