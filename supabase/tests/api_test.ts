// End to end test against a local Postgres:
//   CLUB_TEST=1 DB_URL=postgres://postgres@localhost:5499/club deno test -A supabase/tests/api_test.ts
// Loads a sample export with the real import script, then drives the API the way the app does.
// Outside lookups (Apple, Spotify) are stubbed, and the mailer is captured instead of sending.

function assert(c: unknown, msg = "assertion failed") { if (!c) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y}, got ${x}`); }
async function assertRejects(fn: () => Promise<unknown>, _e?: unknown, includes = "") {
  try { await fn(); } catch (e) { if (includes && !String((e as Error).message).includes(includes)) throw new Error(`error "${(e as Error).message}" lacks "${includes}"`); return; }
  throw new Error("expected an error");
}

const NAMES = ["Brennan", "Jonathan", "William", "Luke", "Nathan"];
const sentMail: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url || input);
  if (url.startsWith("https://mailer.test")) { sentMail.push(JSON.parse(init.body)); return new Response('{"ok":true,"result":true}'); }
  if (url.includes("itunes.apple.com/search?entity=album")) {
    return Response.json({ results: [{ collectionName: "Test Album", artistName: "Test Artist", artworkUrl100: "https://is1.mzstatic.com/x/100x100bb.jpg", collectionViewUrl: "https://music.apple.com/us/album/test/1", collectionId: 1, collectionExplicitness: "explicit", releaseDate: "2001-01-01", trackCount: 2 }] });
  }
  if (url.includes("itunes.apple.com/lookup?entity=song")) {
    return Response.json({ results: [{ wrapperType: "track", kind: "song", trackName: "One", discNumber: 1, trackNumber: 1, trackViewUrl: "https://music.apple.com/us/album/test/1?i=11&uo=4" }, { wrapperType: "track", kind: "song", trackName: "Two", discNumber: 1, trackNumber: 2, trackViewUrl: "https://music.apple.com/us/album/test/1?i=12" }] });
  }
  if (url.includes("itunes.apple.com")) return Response.json({ results: [] });
  return realFetch(input, init);
}) as typeof fetch;
Deno.env.set("MAILER_URL", "https://mailer.test/exec");
Deno.env.set("MAILER_SECRET", "x".repeat(40));

const ymd = (row: number) => new Date(Date.UTC(2026, 6, 16 + 7 * (row - 7), 12)).toISOString().slice(0, 10);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const rows: any[] = [], albums: any[] = [];
for (let r = 7; r <= 40; r++) {
  const date = ymd(r);
  const past = date <= today;
  const picker = NAMES[(r - 7) % 5];
  rows.push({ row: r, date, album: past ? `Album ${r}` : "", artist: past ? `Artist ${r}` : "", year: past ? "1999" : "", pickedBy: past ? picker : (r === 30 ? "William" : "") });
  if (!past) continue;
  const ratings: any = {}, fav: any = {}, least: any = {}, comments: any = {}, ratedAt: any = {};
  NAMES.forEach((n, i) => {
    ratings[n] = (r + i) % 4 === 0 ? null : 5 + ((r * 3 + i) % 10) / 2;
    fav[n] = ratings[n] == null ? "" : i < 2 ? "Song A" : "Song B";
    least[n] = ""; comments[n] = i === 1 ? `nice ${r}` : "";
    ratedAt[n] = ratings[n] != null && r > 20 ? 1794336300000 + r * 1000 : null;
  });
  const nums = Object.values(ratings).filter((x) => x != null) as number[];
  albums.push({ row: r, album: `Album ${r}`, artist: `Artist ${r}`, year: "1999", pickedBy: picker, date, ratings, fav, least, comments, ratedAt,
    tracks: ["Song A", "Song B"], cover: "https://is1.mzstatic.com/c.jpg", spotify: "https://open.spotify.com/search/x", apple: "https://music.apple.com/us/album/a/9",
    spotifyArtist: "", appleArtist: "https://music.apple.com/us/artist/a/1", avg: nums.reduce((a, b) => a + b, 0) / nums.length, count: nums.length });
}
const exportJson = {
  members: NAMES, rotation: NAMES, admins: ["Jonathan"],
  seasons: [{ name: "Season 1", start: "2026-07-16" }, { name: "Season 2", start: "2026-11-12" }],
  rows, shareRows: [100002, 100003],
  data: { albums, shared: [{ row: 100003, shared: true, date: albums[albums.length - 1].date, album: "Shared One", artist: "Old Band", year: "1990", pickedBy: albums[albums.length - 1].pickedBy,
    ratings: { Brennan: 8 }, fav: {}, least: {}, comments: {}, ratedAt: {}, tracks: [], cover: "", spotify: "", apple: "" }] },
  sessions: [{ token: "a".repeat(64), name: "Jonathan", created: Date.now() - 864e5 }, { token: "b".repeat(64), name: "Luke", created: Date.now() }],
  appKeys: [], platforms: { Jonathan: "apple" },
  chat: [{ id: 1, time: Date.now() - 1e5, name: "Luke", text: "hi" }, { id: 2, time: Date.now(), name: "Jonathan", text: "" }, { id: 3, time: Date.now(), name: "Nathan", text: "yo" }],
  chatGen: "1",
};
const dir = await Deno.makeTempDir();
await Deno.writeTextFile(`${dir}/export.json`, JSON.stringify(exportJson));
await Deno.writeTextFile(`${dir}/Members.gs`, "var AD_MEMBER_EMAILS = {\n" + NAMES.map((n) => `  '${n.toLowerCase()}@example.com': '${n}'`).join(",\n") + "\n};");
await Deno.writeTextFile(`${dir}/Avatars.html`, "<script>var AVATARS = { Luke: 'data:image/jpeg;base64,AAAA' };</script>");

const imp = await new Deno.Command("deno", { args: ["run", "-A", new URL("../scripts/import.ts", import.meta.url).pathname, `${dir}/export.json`, `${dir}/Members.gs`, `${dir}/Avatars.html`], env: Deno.env.toObject() }).output();
if (!imp.success) throw new Error(new TextDecoder().decode(imp.stderr));
console.log(new TextDecoder().decode(imp.stdout).trim());

const { handle, sql } = await import("../functions/api/index.ts");
async function call(action: string, args: unknown[] = [], session = "a".repeat(64)) {
  const res = await handle(new Request("http://x/", { method: "POST", headers: { Origin: "https://clubmusic.net" }, body: JSON.stringify({ action, args, session }) }));
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://clubmusic.net");
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
const JON = "a".repeat(64), LUKE = "b".repeat(64);

Deno.test("imported sign ins work and unknown ones are signed out", async () => {
  assertEquals((await call("getData", [], JON)).me.name, "Jonathan");
  await assertRejects(() => call("getData", [], "c".repeat(64)), Error, "SIGNED_OUT");
  assertEquals(await call("members"), NAMES);
});

Deno.test("getData keeps the old shape", async () => {
  const d = await call("getData");
  assertEquals(d.members, NAMES);
  assertEquals(d.me.platform, "apple");
  const a = d.albums[0];
  assertEquals(a.row, 7); assertEquals(a.number, 1); assertEquals(a.season, "Season 1");
  const favs = NAMES.map((n) => a.fav[n]).filter(Boolean);
  const nB = favs.filter((x) => x === "Song B").length, nA = favs.filter((x) => x === "Song A").length;
  const top = Math.max(nA, nB);
  assertEquals(a.groupFav, top > 1 ? `${favs.find((x) => favs.filter((y) => y === x).length === top)}  (${top} votes)` : favs.length === 1 ? favs[0] : "No agreement yet");
  assert(d.albums.every((x: any, i: number, all: any[]) => i === 0 || x.row > all[i - 1].row));
  const s2 = d.albums.filter((x: any) => x.season === "Season 2");
  if (s2.length) assertEquals(s2[0].number, 1);
  assertEquals(d.shared.length, 1); assertEquals(d.shared[0].ratings.Brennan, 8);
  assert(d.slots.length === 8);
  assert(d.slots.some((s: any) => s.reserved === "William" && s.turn === "William"));
  assert(d.albums[0].spotify.includes("/search/"));          // no Spotify keys: search link
  assert(typeof d.albums[0].ratedAt.Brennan !== "undefined");
});

Deno.test("rating: saves score, keeps the first rating time, validates", async () => {
  const d = await call("getData");
  const a = d.albums[d.albums.length - 1];
  await assertRejects(() => call("submitRating", [a.row, "Luke", 10.1, null, null, null]), Error, "quarter steps");
  await assertRejects(() => call("submitRating", [a.row, "Luke", 7, null, null, "x".repeat(201)]), Error, "200");
  let d2 = await call("submitRating", [a.row, "Brennan", 7.25, "Song A", null, "great"]);  // saves as Jonathan whatever the app sent
  let b = d2.albums.find((x: any) => x.row === a.row);
  assertEquals(b.ratings.Jonathan, 7.25); assertEquals(b.fav.Jonathan, "Song A"); assertEquals(b.comments.Jonathan, "great");
  const t = b.ratedAt.Jonathan;
  d2 = await call("submitRating", [a.row, "Jonathan", 8, null, "Song B", null]);
  b = d2.albums.find((x: any) => x.row === a.row);
  assertEquals(b.ratings.Jonathan, 8); assertEquals(b.fav.Jonathan, "Song A"); assertEquals(b.least.Jonathan, "Song B"); assertEquals(b.comments.Jonathan, "great");
  assertEquals(b.ratedAt.Jonathan, t);
});

Deno.test("picks: turn order, one ahead, no repeats, change, remove", async () => {
  let d = await call("getData", [], LUKE);
  const lukeSlot = d.slots.find((s: any) => s.turn === "Luke");
  await assertRejects(() => call("submitPick", ["Luke", "Album 7", "Artist 7", "", "", null], LUKE), Error, "already been picked");
  const r = await call("submitPick", ["Luke", "Test Album", "Test Artist", "2001", "https://is1.mzstatic.com/chosen.jpg", null], LUKE);
  assertEquals(r.row, lukeSlot.row);
  const added = r.data.albums.find((x: any) => x.row === r.row);
  assertEquals(added.cover, "https://is1.mzstatic.com/chosen.jpg");
  assertEquals(added.tracks, ["One", "Two"]);                 // looked up right away
  assertEquals(added.apple, "https://music.apple.com/us/album/test/1");
  await assertRejects(() => call("submitPick", ["Luke", "Other", "Band", "", "", null], LUKE), Error, "lined up");
  const c = await call("submitPick", ["Luke", "Swapped", "Band", "", "", r.row], LUKE);
  assertEquals(c.row, r.row);
  const rm = await call("removePick", [c.row, false], JON);    // admin can remove anyone's unrated pick
  assertEquals(rm.album, "Swapped");
  d = rm.data;
  assertEquals(d.slots.find((s: any) => s.row === c.row).reserved, "Luke");
});

Deno.test("shares: ride along with your pick, no repeats, remove", async () => {
  const d = await call("getData", [], LUKE);
  const last = d.albums[d.albums.length - 1];
  const sess = last.pickedBy === "Jonathan" ? JON : last.pickedBy === "Luke" ? LUKE : null;
  if (!sess) return; // the sample's latest picker has no session in this fixture
  await assertRejects(() => call("submitShare", ["Album 8", "Artist 8", "", "", last.row, null], sess), Error, "club pick");
  await assertRejects(() => call("submitShare", ["Brand New", "Someone", "1988", "", last.row, null], sess), Error, "already shared");
  const mine = d.shared[0];
  await assertRejects(() => call("submitShare", ["Brand New", "Someone", "1988", "", last.row, mine.row], sess), Error, "already rated");
  await assertRejects(() => call("removeShare", [mine.row], sess), Error, "already rated");
});

Deno.test("chat: load, post, delete, rate limit", async () => {
  let c = await call("getChat", [0, ""]);
  assertEquals(c.full, true); assertEquals(c.messages.map((m: any) => m.id), [1, 3]); assertEquals(c.last, 3);
  const m = await call("postChat", ["  hello  "]);
  assertEquals(m.id, 4); assertEquals(m.text, "hello"); assertEquals(m.name, "Jonathan");
  c = await call("getChat", [3, c.gen]);
  assertEquals(c.full, false); assertEquals(c.messages.length, 1);
  await assertRejects(() => call("deleteChat", [4], LUKE), Error, "own messages");
  await call("deleteChat", [4], JON);
  const c2 = await call("getChat", [4, c.gen]);
  assertEquals(c2.full, true);

  // Live channel details: none without Supabase's settings, a websocket address with them.
  assertEquals(await call("chatLive", []), null);
  Deno.env.set("SUPABASE_URL", "https://abc.supabase.co"); Deno.env.set("SUPABASE_ANON_KEY", "anon-key");
  assertEquals(await call("chatLive", []), { url: "wss://abc.supabase.co/realtime/v1/websocket", key: "anon-key", topic: "club-chat" });
  Deno.env.delete("SUPABASE_URL"); Deno.env.delete("SUPABASE_ANON_KEY");
});

Deno.test("sign in with a code, app key, sign out", async () => {
  sentMail.length = 0;
  const r = await call("requestCode", ["Nathan"], "");
  assertEquals(r.hint, "na•••••@example.com");
  const code = sentMail[0].subject.match(/\d{6}/)[0];
  assertEquals(sentMail[0].to, "nathan@example.com");
  await assertRejects(() => call("verifyCode", ["Nathan", "000000"], ""), Error, "isn't right");
  const v = await call("verifyCode", ["Nathan", code], "");
  assertEquals(v.name, "Nathan");
  const k = await call("appKey", [], v.session);
  const v2 = await call("useAppKey", [k.key], "");
  assertEquals(v2.name, "Nathan");
  await assertRejects(() => call("useAppKey", [k.key], ""), Error, "already been used");
  await call("signOut", [], v.session);
  await assertRejects(() => call("getData", [], v.session), Error, "SIGNED_OUT");
  assertEquals((await call("getData", [], v2.session)).me.name, "Nathan");
});

Deno.test("phone notifications: subscribe, prefs, chat, ratings, test, cron", async () => {
  const pushed: { endpoint: string; headers: Headers }[] = [];
  const before = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url || input);
    if (url.startsWith("https://fcm.googleapis.com/fcm/send/")) {
      pushed.push({ endpoint: url, headers: new Headers(init.headers) });
      return new Response("", { status: url.endsWith("gone") ? 410 : 201 });
    }
    return before(input, init);
  }) as typeof fetch;
  const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sub = async (name: string) => {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    return { endpoint: "https://fcm.googleapis.com/fcm/send/" + name, keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
  };
  try {
    const key = await call("pushKey", [], "");
    assert(/^[A-Za-z0-9_-]{87}$/.test(key), "public key");
    assertEquals(await call("pushKey", [], ""), key);                       // made once, then kept
    const bad = { ...(await sub("x")), endpoint: "https://evil.example/x" };
    await assertRejects(() => call("pushSubscribe", [bad], LUKE), Error, "isn't supported");
    await call("pushSubscribe", [await sub("luke")], LUKE);
    await call("pushSubscribe", [await sub("luke-gone")], LUKE);
    await call("pushSubscribe", [await sub("jon")], JON);
    assertEquals((await call("getData", [], LUKE)).me.push, { chat: true, picks: true, ratings: true, reminders: true });

    // Chat goes to everyone but the sender; a subscription the service says is gone is dropped.
    await call("postChat", ["new one"], JON);
    assertEquals(pushed.map((p) => p.endpoint.split("/").pop()).sort(), ["luke", "luke-gone"]);
    assertEquals(pushed[0].headers.get("Content-Encoding"), "aes128gcm");
    assert(String(pushed[0].headers.get("Authorization")).startsWith("vapid t="));
    pushed.length = 0;
    await call("postChat", ["again"], JON);
    assertEquals(pushed.map((p) => p.endpoint.split("/").pop()), ["luke"]);

    // Luke has the app open on screen: no buzz. Once it goes to the background, notes come again.
    pushed.length = 0;
    await call("getChat", [0, "", true], LUKE);
    await call("postChat", ["you're here"], JON);
    assertEquals(pushed.length, 0);
    await call("pushTest", [], LUKE);                       // the test button still works in the app
    assertEquals(pushed.length, 1);
    pushed.length = 0;
    await call("chatAway", [], LUKE);
    await call("postChat", ["you left"], JON);
    assertEquals(pushed.map((p) => p.endpoint.split("/").pop()), ["luke"]);

    // Switching chat off stops chat notes only.
    pushed.length = 0;
    assertEquals((await call("pushPrefs", [{ chat: false, bogus: true }], LUKE)).chat, false);
    await call("postChat", ["quiet"], JON);
    assertEquals(pushed.length, 0);

    // First rating notifies the others; changing it later doesn't.
    const d = await call("getData", [], LUKE);
    const a = d.albums.find((x: any) => x.ratings.Luke == null);
    await call("submitRating", [a.row, "Luke", 6.5, null, null, null], LUKE);
    assertEquals(pushed.map((p) => p.endpoint.split("/").pop()), ["jon"]);
    pushed.length = 0;
    await call("submitRating", [a.row, "Luke", 7, null, null, null], LUKE);
    assertEquals(pushed.length, 0);

    // Test button reaches only your own phones.
    assertEquals(await call("pushTest", [], JON), 1);
    assertEquals(pushed.map((p) => p.endpoint.split("/").pop()), ["jon"]);

    // Scheduled reminders need the secret, and never send the same note twice.
    await assertRejects(() => call("pushCron", ["nope"], ""), Error, "Not allowed");
    Deno.env.set("CRON_SECRET", "z".repeat(40));
    const r1 = await call("pushCron", ["z".repeat(40)], "");
    assertEquals(typeof r1.today, "string");
    const r2 = await call("pushCron", ["z".repeat(40)], "");
    assertEquals(r2.sent, []);

    // Unsubscribing removes the phone.
    await call("pushUnsubscribe", ["https://fcm.googleapis.com/fcm/send/jon"], JON);
    await assertRejects(() => call("pushTest", [], JON), Error, "Couldn't reach");
  } finally {
    globalThis.fetch = before;
  }
});

Deno.test("songLinks, avatars, platform", async () => {
  const d = await call("getData");
  const added = d.albums[0];
  const links = await call("songLinks", [added.row, "apple", ["One", "Nope"]]);
  assert(links.Nope.includes("/search"));
  assertEquals((await call("avatars")).Luke, "data:image/jpeg;base64,AAAA");
  assertEquals(await call("setPlatform", ["spotify"]), "spotify");
  await assertRejects(() => call("setPlatform", ["tidal"]), Error, "Pick Spotify");
  await sql.end();
});
