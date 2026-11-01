// Formats one alert for the webhook flavour detected from the URL.
// Discord, Slack and ntfy.sh get their native shape; anything else gets plain JSON.

export interface AlertPayload {
  project: string;
  check: string;
  status: "up" | "down" | "test";
  detail?: string;
  at: number;
  statusPage: string;
}

/**
 * Rejects IP literals, localhost-style names and our own host. Workers egress cannot reach private
 * networks, but this still stops probes or alerts from looping back into Lastping or hitting raw IPs.
 */
export function isPublicHost(hostname: string, ownHost?: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return false; // "localhost", single-label intranet names
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
  if (/\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return false;
  if (ownHost && (h === ownHost || h.endsWith(`.${ownHost}`))) return false;
  return true;
}

export function validAlertUrl(raw: string, ownHost?: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && raw.length <= 500 && isPublicHost(u.hostname, ownHost);
  } catch {
    return false;
  }
}

export function formatAlert(url: string, p: AlertPayload): { body: string; headers: Record<string, string> } {
  const icon = p.status === "down" ? "🔴" : p.status === "up" ? "🟢" : "🔔";
  const verb = p.status === "down" ? "is DOWN" : p.status === "up" ? "is back UP" : "test alert";
  const line = `${icon} ${p.project} / ${p.check} ${verb}${p.detail ? ` (${p.detail})` : ""}`;
  const host = new URL(url).hostname;

  if (host === "discord.com" || host === "discordapp.com") {
    // Check names are user input: never let them trigger @everyone or role pings.
    return {
      body: JSON.stringify({ content: `${line}\n${p.statusPage}`, allowed_mentions: { parse: [] } }),
      headers: { "content-type": "application/json" },
    };
  }
  if (host === "hooks.slack.com") {
    const safe = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return { body: JSON.stringify({ text: `${safe}\n${p.statusPage}` }), headers: { "content-type": "application/json" } };
  }
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) {
    return {
      body: line,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // Header values must be ASCII-safe; check names may contain anything.
        Title: `Lastping: ${p.check} ${p.status}`.replace(/[^\x20-\x7e]/g, "?"),
        Priority: p.status === "down" ? "high" : "default",
        Click: p.statusPage,
      },
    };
  }
  return { body: JSON.stringify({ ...p, message: line }), headers: { "content-type": "application/json" } };
}

/** Reads at most `max` bytes of a response body, then cancels it: the URL is user-chosen. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // a broken body just means no detail
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all.slice(0, max)).trim();
}

export async function sendAlert(url: string, p: AlertPayload): Promise<{ ok: boolean; error?: string }> {
  if (!validAlertUrl(url)) return { ok: false, error: "alert URL is not an https URL on a public host" };
  const { body, headers } = formatAlert(url, p);
  try {
    const res = await fetch(url, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (res.ok) return { ok: true };
    const text = await readCapped(res, 200);
    return { ok: false, error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
