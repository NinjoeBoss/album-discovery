// Web Push (the standard behind phone notifications for home screen web apps:
// iPhone 16.4+ once the app is on the home screen, Android, desktop browsers).
//
// No Firebase or outside service: each phone's browser gives the app a "subscription"
// (an address at Apple / Google / Mozilla plus two keys). To notify a phone we encrypt the
// message for it (RFC 8291) and post it to that address, signed with the club's own
// VAPID key (RFC 8292). Everything here uses Web Crypto only.

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export function b64u(bytes: Uint8Array | ArrayBuffer) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s: string): Bytes {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
async function hmac(key: Bytes, data: Bytes) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };
export type Subscription = { endpoint: string; p256dh: string; auth: string };

/** A new VAPID key pair (made once and saved by the caller). */
export async function makeVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
  };
}

/** The signed "who is sending" header (RFC 8292). */
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string) {
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Encrypts one message for one phone (RFC 8291, aes128gcm). */
export async function encrypt(sub: Subscription, payload: Bytes) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, sealed);
}

export type Note = {
  title: string; body: string;
  tag?: string;      // a newer note with the same tag replaces the older one on the phone
  url?: string;      // where a tap opens, inside the app (e.g. "./?go=chat")
  ttl?: number;      // seconds the push service may hold it while the phone is off
  urgency?: "very-low" | "low" | "normal" | "high";
};

/** Sends one note to one phone. Returns "ok", "gone" (subscription no longer valid) or "error". */
export async function sendOne(sub: Subscription, note: Note, keys: VapidKeys, subject: string): Promise<"ok" | "gone" | "error"> {
  try {
    const body = await encrypt(sub, enc.encode(JSON.stringify({ title: note.title, body: note.body, tag: note.tag || "", url: note.url || "./" })));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidHeader(sub.endpoint, keys, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": String(note.ttl ?? 24 * 3600),
        "Urgency": note.urgency || "normal",
        ...(note.tag ? { "Topic": note.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "club" } : {}),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) { console.error("push", new URL(sub.endpoint).host, res.status); return "error"; }
    return "ok";
  } catch (e) {
    console.error("push", (e as Error).message);
    return "error";
  }
}

/** Only real push services, so the server never posts to an address someone made up. */
export function okEndpoint(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && u.length <= 1000 &&
      /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chrome\.google\.com)$/.test(url.hostname);
  } catch { return false; }
}
