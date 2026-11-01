// Passkey (WebAuthn) accounts. No passwords and no email: the browser's platform authenticator
// (Touch ID, Windows Hello, Android, a security key) proves the user, and a synced passkey
// follows them across their devices.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { body, HttpError, json, randomToken, sha256, str } from "./http";

interface AuthEnv {
  DB: D1Database;
}

export interface User {
  id: string;
  name: string;
  created_at: number;
}

const SESSION_COOKIE = "lp_session";
const CHALLENGE_COOKIE = "lp_chal";
const SESSION_TTL = 30 * 86400_000;
const CHALLENGE_TTL = 5 * 60_000;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function setCookie(name: string, value: string, maxAgeMs: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function rp(req: Request) {
  const url = new URL(req.url);
  return { rpID: url.hostname, origin: url.origin };
}

export async function currentUser(req: Request, env: AuthEnv): Promise<User | null> {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  ).bind(await sha256(token), Date.now()).first<User>();
}

/**
 * Cookie-authenticated writes must carry a custom header. Browsers cannot add one cross-site
 * without a CORS preflight we never approve, so this blocks CSRF on top of SameSite=Lax.
 */
export function requireCsrfHeader(req: Request): void {
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers.get("x-lastping") !== "1") {
    throw new HttpError(403, "missing x-lastping header");
  }
}

async function startSession(env: AuthEnv, userId: string, data: unknown): Promise<Response> {
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_TTL).run();
  const res = json(data);
  res.headers.append("set-cookie", setCookie(SESSION_COOKIE, token, SESSION_TTL));
  res.headers.append("set-cookie", setCookie(CHALLENGE_COOKIE, "", 0));
  return res;
}

async function saveChallenge(env: AuthEnv, challenge: string, userId: string | null, name: string | null, data: unknown) {
  const id = randomToken(18);
  await env.DB.prepare("INSERT INTO challenges (id, challenge, user_id, name, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, challenge, userId, name, Date.now() + CHALLENGE_TTL).run();
  const res = json(data);
  res.headers.append("set-cookie", setCookie(CHALLENGE_COOKIE, id, CHALLENGE_TTL));
  return res;
}

/** Single-use: the challenge row is deleted as it is read. */
async function takeChallenge(req: Request, env: AuthEnv) {
  const id = cookie(req, CHALLENGE_COOKIE);
  if (!id) throw new HttpError(400, "sign-in expired, try again");
  const row = await env.DB.prepare("DELETE FROM challenges WHERE id = ? RETURNING *")
    .bind(id).first<{ challenge: string; user_id: string | null; name: string | null; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) throw new HttpError(400, "sign-in expired, try again");
  return row;
}

function labelFor(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${browser} on ${os}` : os;
}

/** Handles /api/auth/* and /api/me routes. Returns null for paths it does not own. */
export async function authRoute(req: Request, env: AuthEnv, path: string): Promise<Response | null> {
  const { rpID, origin } = rp(req);

  // New account, or another passkey for the signed-in user.
  if (path === "/api/auth/register/options" && req.method === "POST") {
    const b = await body(req);
    const user = await currentUser(req, env);
    const name = user ? user.name : str(b.name, "name", 60)!;
    const existing = user
      ? (await env.DB.prepare("SELECT id, transports FROM credentials WHERE user_id = ?").bind(user.id).all<{ id: string; transports: string | null }>()).results
      : [];
    const options = await generateRegistrationOptions({
      rpName: "Lastping",
      rpID,
      userName: name,
      userDisplayName: name,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? (JSON.parse(c.transports) as AuthenticatorTransportFuture[]) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return saveChallenge(env, options.challenge, user?.id ?? null, name, options);
  }

  if (path === "/api/auth/register/verify" && req.method === "POST") {
    const ch = await takeChallenge(req, env);
    const b = await body(req);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: b as never,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (e) {
      throw new HttpError(400, `passkey could not be verified: ${(e as Error).message}`);
    }
    if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, "passkey could not be verified");
    const { credential } = verification.registrationInfo;
    const now = Date.now();
    const userId = ch.user_id ?? crypto.randomUUID();
    const stmts = [];
    if (!ch.user_id) stmts.push(env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").bind(userId, ch.name ?? "Lastping user", now));
    stmts.push(
      env.DB.prepare("INSERT INTO credentials (id, user_id, public_key, counter, transports, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(credential.id, userId, b64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), labelFor(req), now, now),
    );
    await env.DB.batch(stmts);
    return startSession(env, userId, { ok: true });
  }

  if (path === "/api/auth/login/options" && req.method === "POST") {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    return saveChallenge(env, options.challenge, null, null, options);
  }

  if (path === "/api/auth/login/verify" && req.method === "POST") {
    const ch = await takeChallenge(req, env);
    const b = await body(req);
    const credId = typeof b.id === "string" ? b.id : "";
    const cred = await env.DB.prepare("SELECT * FROM credentials WHERE id = ?").bind(credId)
      .first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
    if (!cred) throw new HttpError(400, "this passkey isn't registered with Lastping");
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: b as never,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
        credential: {
          id: cred.id,
          publicKey: fromB64url(cred.public_key),
          counter: cred.counter,
          transports: cred.transports ? JSON.parse(cred.transports) : undefined,
        },
      });
    } catch (e) {
      throw new HttpError(400, `passkey could not be verified: ${(e as Error).message}`);
    }
    if (!verification.verified) throw new HttpError(400, "passkey could not be verified");
    await env.DB.prepare("UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?")
      .bind(verification.authenticationInfo.newCounter, Date.now(), cred.id).run();
    return startSession(env, cred.user_id, { ok: true });
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const token = cookie(req, SESSION_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    const res = json({ ok: true });
    res.headers.append("set-cookie", setCookie(SESSION_COOKIE, "", 0));
    return res;
  }

  if (path === "/api/me" && req.method === "GET") {
    const user = await currentUser(req, env);
    if (!user) return json({ user: null });
    const [{ results: passkeys }, { results: projects }] = await env.DB.batch([
      env.DB.prepare("SELECT id, label, created_at, last_used_at FROM credentials WHERE user_id = ? ORDER BY created_at").bind(user.id),
      env.DB.prepare(
        `SELECT p.slug, p.name, p.created_at,
           SUM(c.status = 'up') AS up, SUM(c.status = 'late') AS late, SUM(c.status = 'down') AS down, COUNT(c.id) AS total
         FROM projects p LEFT JOIN checks c ON c.project_id = p.id
         WHERE p.user_id = ? GROUP BY p.id ORDER BY p.created_at`,
      ).bind(user.id),
    ]);
    return json({ user: { name: user.name, created_at: user.created_at }, passkeys, projects });
  }

  // Move key-only projects saved in this browser into the account.
  if (path === "/api/me/claim" && req.method === "POST") {
    const user = await currentUser(req, env);
    if (!user) throw new HttpError(401, "sign in first");
    requireCsrfHeader(req);
    const b = await body(req);
    const list = Array.isArray(b.projects) ? b.projects.slice(0, 50) : [];
    const claimed: string[] = [];
    for (const p of list as { slug?: unknown; token?: unknown }[]) {
      if (typeof p.slug !== "string" || typeof p.token !== "string") continue;
      // The key is rotated to a value nobody knows, so whoever held the old key loses access once it's claimed.
      const r = await env.DB.prepare("UPDATE projects SET user_id = ?, token_hash = ? WHERE slug = ? AND token_hash = ? AND user_id IS NULL")
        .bind(user.id, await sha256(randomToken(32)), p.slug, await sha256(p.token)).run();
      if (r.meta.changes) claimed.push(p.slug);
    }
    return json({ claimed: claimed.length, slugs: claimed });
  }

  if (path.startsWith("/api/me/passkeys/") && req.method === "DELETE") {
    const user = await currentUser(req, env);
    if (!user) throw new HttpError(401, "sign in first");
    requireCsrfHeader(req);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?").bind(user.id).first<{ n: number }>();
    if ((count?.n ?? 0) <= 1) throw new HttpError(400, "you can't remove your only passkey");
    // A removed passkey may belong to a lost device: end every other session along with it.
    const current = await sha256(cookie(req, SESSION_COOKIE) ?? "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM credentials WHERE id = ? AND user_id = ?").bind(decodeURIComponent(path.slice(17)), user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, current),
    ]);
    return json({ ok: true });
  }

  return null;
}
