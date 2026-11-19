// Checks the new server against the old one: runs the new getData and compares it,
// field by field, with the getData the old Apps Script server returned in the export.
//
//   CLUB_TEST=1 DB_URL=... deno run -A supabase/scripts/compare.ts <export.json>
//
// Prints only row numbers and field names (the Actions log is public), and exits
// non zero if anything that matters differs.

import { getData, sql } from "../functions/api/index.ts";

const ex = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const old = ex.data;
const admin = ex.admins[0];
const now = await getData({ member: admin, email: "", admin: true, hash: "" }) as any;

const problems: string[] = [];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isSearch = (u: string) => !u || /\/search(\/|\?)/.test(u);
const round = (x: number | null) => x == null ? null : Math.round(x * 1e6) / 1e6;

for (const k of ["season", "currentSeason", "members", "rotation", "turn", "shareDays", "commentMax", "today"]) {
  if (!same(old[k], now[k])) problems.push(`${k} differs`);
}
if (!same(old.seasons, now.seasons)) problems.push("seasons differ");
if (old.me?.name !== now.me?.name || old.me?.admin !== now.me?.admin) problems.push("me differs");

const slotKeys = ["row", "date", "season", "reserved", "turn"];
(old.slots || []).forEach((s: any, i: number) => {
  const n = now.slots[i];
  if (!n) { problems.push(`slot ${i} missing`); return; }
  for (const k of slotKeys) if (!same(s[k], n[k])) problems.push(`slot ${i} (${s.row}): ${k} differs`);
});

const fields = ["number", "date", "season", "album", "artist", "year", "pickedBy", "ratings", "fav", "least", "comments",
  "groupFav", "groupLeast", "tracks", "count", "cover", "ratedAt", "spotifyArtist", "appleArtist"];
function check(list: "albums" | "shared") {
  const byRow = new Map(now[list].map((a: any) => [a.row, a]));
  if (old[list].length !== now[list].length) problems.push(`${list}: ${old[list].length} before, ${now[list].length} now`);
  for (const a of old[list]) {
    const b: any = byRow.get(a.row);
    if (!b) { problems.push(`${list} row ${a.row} missing`); continue; }
    for (const k of fields) {
      if ((k === "spotifyArtist" || k === "appleArtist") && !a[k]) continue;  // new server may have found one
      if (!same(a[k], b[k])) problems.push(`${list} row ${a.row}: ${k} differs` +
        (k === "groupFav" || k === "groupLeast" ? ` (before ${JSON.stringify(a[k])}, now ${JSON.stringify(b[k])})` : ""));
    }
    if (round(a.avg) !== round(b.avg)) problems.push(`${list} row ${a.row}: avg differs`);
    for (const p of ["spotify", "apple"]) if (!isSearch(a[p]) && a[p] !== b[p]) problems.push(`${list} row ${a.row}: ${p} link differs`);
  }
}
check("albums");
check("shared");

console.log(`Compared ${old.albums.length} albums, ${old.shared.length} shares, ${(old.slots || []).length} open weeks.`);
if (problems.length) {
  console.log(`${problems.length} differences:\n  ` + problems.join("\n  "));
  await sql.end();
  Deno.exit(1);
}
console.log("Everything matches.");
await sql.end();
