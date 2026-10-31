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

export function validAlertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && raw.length <= 500;
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
    return { body: JSON.stringify({ content: `${line}\n${p.statusPage}` }), headers: { "content-type": "application/json" } };
  }
  if (host === "hooks.slack.com") {
    return { body: JSON.stringify({ text: `${line}\n${p.statusPage}` }), headers: { "content-type": "application/json" } };
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

export async function sendAlert(url: string, p: AlertPayload): Promise<boolean> {
  if (!validAlertUrl(url)) return false;
  const { body, headers } = formatAlert(url, p);
  try {
    const res = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
