import { CronError, nextRuns, parseCron, nextRun } from "./cron";
import {
  applyPing,
  applyProbe,
  sweepHeartbeat,
  uptimeByDay,
  type Check,
  type Outcome,
  type Signal,
  type Transition,
} from "./monitor";
import { isPublicHost, sendAlert, validAlertUrl } from "./alerts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  PUBLIC_URL: string;
}

const MAX_CHECKS_PER_PROJECT = 25;
const PROJECTS_PER_IP_PER_DAY = 5;
// Free plan allows 50 subrequests per invocation; probes, their alerts and D1 share the budget.
const PROBES_PER_SWEEP = 25;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "project";
  const suffix = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 5);
  return `${base}-${suffix}`;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "body must be a JSON object");
}

function str(v: unknown, field: string, max: number, required = true): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (typeof v !== "string" || v.length > max) throw new HttpError(400, `${field} must be a string up to ${max} chars`);
  return v.trim();
}

function int(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be an integer ${min}-${max}`);
  return n;
}

async function rateLimit(env: Env, key: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN reset_at < ?3 THEN 1 ELSE count + 1 END,
       reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at END
     RETURNING count`,
  )
    .bind(key, now + windowMs, now)
    .first<{ count: number }>();
  if (row && row.count > limit) throw new HttpError(429, "rate limit reached, try again later");
}

// ---------- persistence ----------

interface Project {
  id: string;
  slug: string;
  name: string;
  token_hash: string;
  alert_url: string | null;
  created_at: number;
}

const PATCHABLE = new Set([
  "status", "last_ping_at", "due_at", "started_at", "last_duration_ms", "fail_streak",
]);

/** Persists an outcome from the state machine and fires the alert if there was a transition. */
async function commit(env: Env, check: Check & { project_id: string; name: string }, out: Outcome, now: number): Promise<void> {
  const keys = Object.keys(out.patch).filter((k) => PATCHABLE.has(k));
  const stmts: D1PreparedStatement[] = [];
  if (keys.length) {
    stmts.push(
      env.DB.prepare(`UPDATE checks SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`).bind(
        check.id,
        ...keys.map((k) => (out.patch as Record<string, unknown>)[k] ?? null),
      ),
    );
  }
  if (out.event) {
    stmts.push(
      env.DB.prepare("INSERT INTO events (check_id, at, kind, detail) VALUES (?1, ?2, ?3, ?4)").bind(
        check.id, now, out.event.kind, out.event.detail?.slice(0, 1000) ?? null,
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  if (out.transition) {
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(check.project_id).first<Project>();
    if (project?.alert_url) {
      await sendAlert(project.alert_url, {
        project: project.name,
        check: check.name,
        status: out.transition,
        detail: out.event?.detail,
        at: now,
        statusPage: `${env.PUBLIC_URL}/s/${project.slug}`,
      });
    }
  }
}

async function auth(req: Request, env: Env, slug: string): Promise<Project> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const project = await env.DB.prepare("SELECT * FROM projects WHERE slug = ?").bind(slug).first<Project>();
  if (!project || !token || (await sha256(token)) !== project.token_hash) throw new HttpError(401, "invalid project or key");
  return project;
}

async function checkWithProject(req: Request, env: Env, id: string): Promise<{ project: Project; check: Check & { project_id: string } }> {
  const check = await env.DB.prepare("SELECT * FROM checks WHERE id = ?").bind(id).first<Check & { project_id: string }>();
  if (!check) throw new HttpError(404, "check not found");
  const slugRow = await env.DB.prepare("SELECT slug FROM projects WHERE id = ?").bind(check.project_id).first<{ slug: string }>();
  const project = await auth(req, env, slugRow!.slug);
  return { project, check };
}

function validateCheckInput(b: Record<string, unknown>, ownHost: string, existing?: Check): Record<string, unknown> {
  const kind = existing?.kind ?? (b.kind === "http" ? "http" : "heartbeat");
  const out: Record<string, unknown> = { kind };
  if (b.name !== undefined || !existing) out.name = str(b.name, "name", 80);
  if (b.is_public !== undefined) out.is_public = b.is_public ? 1 : 0;
  if (kind === "heartbeat") {
    if (b.cron !== undefined) {
      const cron = str(b.cron, "cron", 100, false);
      if (cron) {
        try {
          nextRun(parseCron(cron), Date.now());
        } catch (e) {
          throw new HttpError(400, `cron: ${(e as Error).message}`);
        }
      }
      out.cron = cron;
    }
    if (b.period_s !== undefined || !existing) out.period_s = int(b.period_s, "period_s", 60, 31 * 86400, 3600);
    if (b.grace_s !== undefined || !existing) out.grace_s = int(b.grace_s, "grace_s", 60, 7 * 86400, 300);
  } else {
    if (b.url !== undefined || !existing) {
      const url = str(b.url, "url", 500)!;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, "url is not a valid URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new HttpError(400, "url must be http(s)");
      if (!isPublicHost(parsed.hostname, ownHost)) throw new HttpError(400, "url must point to a public hostname");
      out.url = url;
    }
    if (b.interval_s !== undefined || !existing) out.interval_s = int(b.interval_s, "interval_s", 60, 86400, 300);
    if (b.expect_status !== undefined || !existing) out.expect_status = int(b.expect_status, "expect_status", 100, 599, 200);
  }
  return out;
}

function publicCheckJson(c: Check, base: string) {
  return {
    ...c,
    ping_url: c.kind === "heartbeat" ? `${base}/ping/${c.id}` : null,
  };
}

// ---------- route handlers ----------

async function handlePing(req: Request, env: Env, id: string, suffix: string | undefined): Promise<Response> {
  const now = Date.now();
  let signal: Signal = "success";
  let detail: string | undefined;
  if (suffix === "start") signal = "start";
  else if (suffix === "fail") signal = "fail";
  else if (suffix !== undefined) {
    const code = Number(suffix);
    if (!Number.isInteger(code) || code < 0 || code > 255) return new Response("bad exit code\n", { status: 400, headers: CORS });
    if (code !== 0) {
      signal = "fail";
      detail = `exit code ${code}`;
    }
  }
  if (req.method === "POST") {
    const text = (await req.text()).slice(0, 1000).trim();
    if (text) detail = detail ? `${detail}: ${text}` : text;
  }
  const check = await env.DB.prepare("SELECT * FROM checks WHERE id = ? AND kind = 'heartbeat'").bind(id).first<Check & { project_id: string; name: string }>();
  if (!check) return new Response("not found\n", { status: 404, headers: CORS });
  await commit(env, check, applyPing(check, signal, now, detail), now);
  return new Response("OK\n", { headers: { "content-type": "text/plain", ...CORS } });
}

async function publicStatus(env: Env, slug: string) {
  const project = await env.DB.prepare("SELECT id, slug, name, created_at FROM projects WHERE slug = ?").bind(slug).first<Project>();
  if (!project) throw new HttpError(404, "status page not found");
  const { results: checks } = await env.DB.prepare(
    "SELECT * FROM checks WHERE project_id = ? AND is_public = 1 ORDER BY created_at",
  ).bind(project.id).all<Check & { name: string }>();
  const now = Date.now();
  const days = 90;
  const from = Math.floor(now / 86400_000) * 86400_000 - (days - 1) * 86400_000;

  const out = [];
  for (const c of checks) {
    const [{ results: trans }, prior] = await env.DB.batch([
      env.DB.prepare("SELECT at, kind FROM events WHERE check_id = ? AND kind IN ('up','down') AND at >= ? ORDER BY at").bind(c.id, from),
      env.DB.prepare("SELECT kind FROM events WHERE check_id = ? AND kind IN ('up','down') AND at < ? ORDER BY at DESC LIMIT 1").bind(c.id, from),
    ]);
    const transitions = (trans as { at: number; kind: "up" | "down" }[]).map((t) => ({ at: t.at, to: t.kind }) as Transition);
    const downAtStart = (prior.results[0] as { kind?: string } | undefined)?.kind === "down";
    const buckets = uptimeByDay(transitions, downAtStart, c.created_at, now, days);
    const totalMs = now - Math.max(from, c.created_at);
    const downMs = buckets.reduce((s, b) => s + b.downMs, 0);
    const lastDown = [...transitions].reverse().find((t) => t.to === "down");
    out.push({
      name: c.name,
      kind: c.kind,
      status: c.status,
      last_ping_at: c.last_ping_at,
      last_duration_ms: c.last_duration_ms,
      uptime_90d: totalMs ? Math.max(0, 1 - downMs / totalMs) : null,
      down_since: c.status === "down" ? (lastDown?.at ?? null) : null,
      days: buckets.map((b) => (b.uptime === null ? null : Math.round(b.uptime * 10000) / 10000)),
    });
  }
  return { name: project.name, slug: project.slug, generated_at: now, from_day: new Date(from).toISOString().slice(0, 10), checks: out };
}

function overall(statuses: string[]): { label: string; color: string } {
  const active = statuses.filter((s) => s !== "paused" && s !== "new");
  if (!active.length) return { label: "no data", color: "#8a8a80" };
  if (active.includes("down")) return { label: "down", color: "#c2412d" };
  if (active.includes("late")) return { label: "degraded", color: "#c98a1b" };
  return { label: "operational", color: "#2f7d4f" };
}

function badgeSvg(label: string, value: string, color: string): string {
  const w = (s: string) => Math.round(s.length * 6.4 + 12);
  const lw = w(label);
  const vw = w(value);
  const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
<rect width="${lw}" height="20" fill="#2b2b28"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = (re: string) => path.match(new RegExp(`^${re}$`));
  let r: RegExpMatchArray | null;

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // Ping endpoints: /ping/<uuid>, /ping/<uuid>/start, /ping/<uuid>/fail, /ping/<uuid>/<exit code>
  if ((r = m(`/ping/(${UUID})(?:/([a-z0-9]+))?`))) return handlePing(req, env, r[1], r[2]);

  if ((r = m("/s/([a-z0-9-]+)"))) return env.ASSETS.fetch(new Request(new URL("/status", url), req));

  if ((r = m("/badge/([a-z0-9-]+)\\.svg"))) {
    const project = await env.DB.prepare("SELECT id FROM projects WHERE slug = ?").bind(r[1]).first<{ id: string }>();
    const { results } = project
      ? await env.DB.prepare("SELECT status FROM checks WHERE project_id = ? AND is_public = 1").bind(project.id).all<{ status: string }>()
      : { results: [] };
    const o = project ? overall(results.map((x) => x.status)) : { label: "unknown", color: "#8a8a80" };
    return new Response(badgeSvg("status", o.label, o.color), {
      headers: { "content-type": "image/svg+xml", "cache-control": "max-age=60", ...CORS },
    });
  }

  if (path === "/api/cron" && req.method === "GET") {
    const expr = url.searchParams.get("expr") ?? "";
    try {
      return json({ next: nextRuns(expr, Date.now(), 5) });
    } catch (e) {
      if (e instanceof CronError) return json({ error: e.message }, 400);
      throw e;
    }
  }

  if ((r = m("/api/status/([a-z0-9-]+)")) && req.method === "GET") {
    return json(await publicStatus(env, r[1]), 200, { "cache-control": "max-age=30" });
  }

  if (path === "/api/projects" && req.method === "POST") {
    const ip = req.headers.get("cf-connecting-ip") ?? "local";
    await rateLimit(env, `project:${ip}`, PROJECTS_PER_IP_PER_DAY, 86400_000);
    const b = await body(req);
    const name = str(b.name, "name", 60)!;
    const token = randomToken();
    const project = { id: crypto.randomUUID(), slug: slugify(name), name, created_at: Date.now() };
    await env.DB.prepare("INSERT INTO projects (id, slug, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(project.id, project.slug, name, await sha256(token), project.created_at)
      .run();
    return json({ project: { slug: project.slug, name }, token }, 201);
  }

  if ((r = m("/api/projects/([a-z0-9-]+)"))) {
    const project = await auth(req, env, r[1]);
    if (req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM checks WHERE project_id = ? ORDER BY created_at").bind(project.id).all<Check & Record<string, unknown>>();
      return json({
        project: { slug: project.slug, name: project.name, alert_url: project.alert_url, created_at: project.created_at },
        checks: results.map((c) => publicCheckJson(c, env.PUBLIC_URL)),
        now: Date.now(),
      });
    }
    if (req.method === "PATCH") {
      const b = await body(req);
      const name = b.name !== undefined ? str(b.name, "name", 60) : project.name;
      let alert = project.alert_url;
      if (b.alert_url !== undefined) {
        alert = str(b.alert_url, "alert_url", 500, false);
        if (alert && !validAlertUrl(alert, new URL(env.PUBLIC_URL).hostname)) throw new HttpError(400, "alert_url must be an https URL on a public host");
      }
      await env.DB.prepare("UPDATE projects SET name = ?, alert_url = ? WHERE id = ?").bind(name, alert, project.id).run();
      return json({ ok: true });
    }
    if (req.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM events WHERE check_id IN (SELECT id FROM checks WHERE project_id = ?)").bind(project.id),
        env.DB.prepare("DELETE FROM checks WHERE project_id = ?").bind(project.id),
        env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project.id),
      ]);
      return json({ ok: true });
    }
  }

  if ((r = m("/api/projects/([a-z0-9-]+)/alert-test")) && req.method === "POST") {
    const project = await auth(req, env, r[1]);
    if (!project.alert_url) throw new HttpError(400, "set an alert URL first");
    await rateLimit(env, `alert-test:${project.id}`, 10, 3600_000);
    const ok = await sendAlert(project.alert_url, {
      project: project.name, check: "test", status: "test", at: Date.now(), statusPage: `${env.PUBLIC_URL}/s/${project.slug}`,
    });
    return json({ ok }, ok ? 200 : 502);
  }

  if ((r = m("/api/projects/([a-z0-9-]+)/checks")) && req.method === "POST") {
    const project = await auth(req, env, r[1]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM checks WHERE project_id = ?").bind(project.id).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_CHECKS_PER_PROJECT) throw new HttpError(400, `limit of ${MAX_CHECKS_PER_PROJECT} checks per project`);
    const v = validateCheckInput(await body(req), new URL(env.PUBLIC_URL).hostname);
    const now = Date.now();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO checks (id, project_id, name, kind, period_s, grace_s, cron, url, interval_s, expect_status, is_public, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, project.id, v.name, v.kind, v.period_s ?? 3600, v.grace_s ?? 300, v.cron ?? null, v.url ?? null,
        v.interval_s ?? 300, v.expect_status ?? 200, v.is_public ?? 1,
        v.kind === "http" ? now : null, // probes start on the next sweep; heartbeats wait for the first ping
        now,
      )
      .run();
    const created = await env.DB.prepare("SELECT * FROM checks WHERE id = ?").bind(id).first<Check & Record<string, unknown>>();
    return json(publicCheckJson(created!, env.PUBLIC_URL), 201);
  }

  if ((r = m(`/api/checks/(${UUID})`))) {
    const { check } = await checkWithProject(req, env, r[1]);
    if (req.method === "PATCH") {
      const b = await body(req);
      const v = validateCheckInput(b, new URL(env.PUBLIC_URL).hostname, check);
      delete v.kind;
      const now = Date.now();
      let event: string | null = null;
      if (b.paused === true && check.status !== "paused") {
        v.status = "paused";
        event = "paused";
      } else if (b.paused === false && check.status === "paused") {
        v.status = "new";
        v.fail_streak = 0;
        v.due_at = check.kind === "http" ? now : null;
        event = "resumed";
      }
      const keys = Object.keys(v);
      if (keys.length) {
        const stmts = [
          env.DB.prepare(`UPDATE checks SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(", ")} WHERE id = ?1`).bind(check.id, ...keys.map((k) => v[k] ?? null)),
        ];
        if (event) stmts.push(env.DB.prepare("INSERT INTO events (check_id, at, kind) VALUES (?, ?, ?)").bind(check.id, now, event));
        await env.DB.batch(stmts);
      }
      const updated = await env.DB.prepare("SELECT * FROM checks WHERE id = ?").bind(check.id).first<Check & Record<string, unknown>>();
      return json(publicCheckJson(updated!, env.PUBLIC_URL));
    }
    if (req.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM events WHERE check_id = ?").bind(check.id),
        env.DB.prepare("DELETE FROM checks WHERE id = ?").bind(check.id),
      ]);
      return json({ ok: true });
    }
  }

  if ((r = m(`/api/checks/(${UUID})/events`)) && req.method === "GET") {
    const { check } = await checkWithProject(req, env, r[1]);
    const { results } = await env.DB.prepare("SELECT at, kind, detail FROM events WHERE check_id = ? ORDER BY at DESC LIMIT 50").bind(check.id).all();
    return json({ events: results });
  }

  if (path.startsWith("/api/") || path.startsWith("/ping/")) throw new HttpError(404, "not found");
  return env.ASSETS.fetch(req);
}

// ---------- scheduled sweep ----------

async function probe(c: Check): Promise<{ ok: boolean; latency: number | null; detail?: string }> {
  const started = Date.now();
  try {
    // Redirects are not followed: a redirect target is never re-validated, and each hop costs a subrequest.
    // A 3xx still proves the site answers, so it counts as up when the expected status is 200.
    const res = await fetch(c.url!, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Lastping/1.0 uptime probe (+https://github.com/youssef-110/lastping)" },
    });
    await res.body?.cancel();
    const latency = Date.now() - started;
    const ok = c.expect_status === 200 ? res.status >= 200 && res.status < 400 : res.status === c.expect_status;
    return { ok, latency, detail: ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    const name = (e as Error).name;
    return { ok: false, latency: null, detail: name === "TimeoutError" ? "timeout after 10s" : (e as Error).message.slice(0, 200) };
  }
}

export async function sweep(env: Env, now = Date.now()): Promise<{ heartbeats: number; probes: number }> {
  type Row = Check & { project_id: string; name: string };
  const { results: late } = await env.DB.prepare(
    "SELECT * FROM checks WHERE kind = 'heartbeat' AND status IN ('up','late') AND due_at <= ? LIMIT 500",
  ).bind(now).all<Row>();
  // One bad check must never stall the sweep for everyone else.
  for (const c of late) {
    try {
      const out = sweepHeartbeat(c, now);
      if (out) await commit(env, c, out, now);
    } catch (e) {
      console.error("heartbeat sweep failed", c.id, e);
    }
  }

  const { results: due } = await env.DB.prepare(
    "SELECT * FROM checks WHERE kind = 'http' AND status != 'paused' AND due_at <= ? ORDER BY due_at LIMIT ?",
  ).bind(now, PROBES_PER_SWEEP).all<Row>();
  await Promise.allSettled(
    due.map(async (c) => {
      try {
        const res = await probe(c);
        await commit(env, c, applyProbe(c, res.ok, Date.now(), res.latency, res.detail), Date.now());
      } catch (e) {
        console.error("probe failed", c.id, e);
      }
    }),
  );

  // Hourly housekeeping: keep transitions forever (they drive uptime), trim noisy events after 30 days.
  if (new Date(now).getUTCMinutes() === 0) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM events WHERE kind NOT IN ('up','down') AND at < ?").bind(now - 30 * 86400_000),
      env.DB.prepare("DELETE FROM rate WHERE reset_at < ?").bind(now),
    ]);
  }
  return { heartbeats: late.length, probes: due.length };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;
