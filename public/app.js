// Lastping dashboard. Vanilla JS, hash routing, project keys kept in localStorage.
const DEMO_SLUG = "lastping-demo";
const STORE = "lastping:projects";
const app = document.getElementById("app");
let refreshTimer = null;

// ---------- utilities ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// replaceChildren would print null/false as text, so drop them first.
const mount = (...nodes) => app.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false));

const projects = {
  all() {
    try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
  },
  save(list) {
    try { localStorage.setItem(STORE, JSON.stringify(list)); } catch {}
  },
  get(slug) { return this.all().find((p) => p.slug === slug); },
  put(p) { this.save([p, ...this.all().filter((x) => x.slug !== p.slug)]); },
  remove(slug) { this.save(this.all().filter((x) => x.slug !== slug)); },
};

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Copy failed, select the text manually");
  }
}

function ago(ms, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

function duration(sec) {
  if (sec % 86400 === 0) return `${sec / 86400} d`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  return `${Math.round(sec / 60)} min`;
}

function schedule(c) {
  if (c.kind === "http") return `GET every ${duration(c.interval_s)}`;
  if (c.cron) return `cron ${c.cron} · grace ${duration(c.grace_s)}`;
  return `every ${duration(c.period_s)} · grace ${duration(c.grace_s)}`;
}

const STATE_LABEL = { new: "waiting", up: "up", late: "late", down: "down", paused: "paused" };

// ---------- routing ----------

function route() {
  clearInterval(refreshTimer);
  const hash = location.hash.slice(1) || "/";
  const [path, query] = hash.split("?");
  const m = path.match(/^\/p\/([a-z0-9-]+)$/);
  if (m) {
    const key = new URLSearchParams(query || "").get("key");
    if (key) return importKey(m[1], key);
    return renderProject(m[1]);
  }
  renderHome();
}
window.addEventListener("hashchange", route);

// A dashboard link carries a key. Check it works before storing it, and never silently replace a key we have.
async function importKey(slug, key) {
  history.replaceState(null, "", `#/p/${slug}`);
  const existing = projects.get(slug);
  if (existing?.token === key) return renderProject(slug);
  try {
    const r = await api(`/api/projects/${slug}`, { token: key });
    if (existing && !confirm(`Replace the saved key for "${existing.name}" with the one from this link?`)) return renderProject(slug);
    projects.put({ slug, name: r.project.name, token: key });
  } catch {
    toast("That dashboard link is invalid or expired");
  }
  renderProject(slug);
}

// ---------- home ----------

function renderHome() {
  document.title = "Lastping: know when your jobs stop running";
  const err = h("div", { class: "error" });
  const input = h("input", { placeholder: "Project name, e.g. side-projects", maxlength: "60", "aria-label": "Project name", required: true });
  const create = h("form", {
    class: "create",
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      try {
        const r = await api("/api/projects", { method: "POST", body: { name: input.value } });
        projects.put({ slug: r.project.slug, name: r.project.name, token: r.token, fresh: true });
        location.hash = `#/p/${r.project.slug}`;
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  }, input, h("button", { class: "primary", type: "submit" }, "Create project"));

  const mine = projects.all();
  mount(
    h("section", { class: "hero" },
      h("h1", {}, "Know when your jobs stop running."),
      h("p", { class: "lead" },
        "Cron jobs, backups and workers fail quietly. Lastping expects a ping on schedule and alerts you the moment one is missing. It also watches your sites from the edge. No signup, free."),
      create, err,
      h("div", { class: "actions", style: "margin-top:14px" },
        h("a", { class: "btn", href: `/s/${DEMO_SLUG}` }, "See a live status page →")),
      h("div", { class: "terminal" },
        h("div", { class: "head" }, "crontab -e"),
        h("pre", {},
          h("span", { class: "c" }, "# back up the database every night, then report in\n"),
          "0 3 * * *  ./backup.sh && curl -fsS ", h("span", { class: "k" }, `${location.origin}/ping/8f2c…`), "\n\n",
          h("span", { class: "c" }, "# or report the exit code, so failures alert immediately\n"),
          "0 3 * * *  ./backup.sh; curl -fsS ", h("span", { class: "k" }, `${location.origin}/ping/8f2c…/$?`)),
      ),
    ),
    h("section", { class: "features" },
      h("div", {}, h("h3", {}, "Heartbeats"), h("p", {}, "Fixed intervals or real cron expressions with a grace window. Measure run time with /start.")),
      h("div", {}, h("h3", {}, "Uptime probes"), h("p", {}, "HTTP checks every minute from Cloudflare's edge, with flap damping so one blip doesn't page you.")),
      h("div", {}, h("h3", {}, "Alerts & status pages"), h("p", {}, "Discord, Slack, ntfy push or any webhook. A public status page and README badge per project.")),
    ),
    mine.length
      ? h("section", { class: "mine" },
          h("h2", {}, "Your projects on this device"),
          mine.map((p) => h("a", { href: `#/p/${p.slug}` }, h("span", { class: "name" }, p.name), h("span", { class: "slug" }, p.slug))))
      : null,
    h("footer", {}, "Open source · runs on Cloudflare Workers + D1 · ", h("a", { href: "https://github.com/youssef-110/lastping" }, "source")),
  );
}

// ---------- project ----------

async function renderProject(slug) {
  const saved = projects.get(slug);
  if (!saved) {
    mount(h("div", { class: "empty", style: "padding-top:80px" },
      h("p", {}, "This device has no key for that project."),
      h("p", {}, "Open the dashboard link from project settings on the device where you created it."),
      h("a", { class: "btn", href: `/s/${slug}` }, "View its public status page")));
    return;
  }
  let data;
  try {
    data = await api(`/api/projects/${slug}`, { token: saved.token });
  } catch (ex) {
    mount(h("div", { class: "empty", style: "padding-top:80px" }, h("p", {}, ex.message),
      h("button", { onclick: () => { projects.remove(slug); location.hash = "#/"; } }, "Forget this project")));
    return;
  }
  if (saved.name !== data.project.name) projects.put({ ...saved, name: data.project.name });
  document.title = `${data.project.name} · Lastping`;

  const open = new Set([...document.querySelectorAll(".check.open")].map((el) => el.dataset.id));
  const counts = { up: 0, late: 0, down: 0 };
  for (const c of data.checks) if (counts[c.status] !== undefined) counts[c.status]++;
  const statusUrl = `${location.origin}/s/${slug}`;
  const badge = `[![status](${location.origin}/badge/${slug}.svg)](${statusUrl})`;

  mount(
    saved.fresh ? keyBox(slug, saved) : null,
    h("div", { class: "phead" },
      h("div", {},
        h("h1", {}, data.project.name),
        h("div", { class: "meta" },
          h("a", { href: statusUrl, target: "_blank", rel: "noopener" }, "Public status page ↗"),
          h("a", { href: "#", onclick: (e) => { e.preventDefault(); copy(badge); } }, "Copy README badge"),
          h("span", {}, data.project.alert_url ? "Alerts on" : h("a", { href: "#", onclick: (e) => { e.preventDefault(); openSettings(slug, saved, data); } }, "Set up alerts")))),
      h("div", { class: "tools" },
        h("button", { onclick: () => openSettings(slug, saved, data) }, "Settings"),
        h("button", { class: "primary", onclick: () => openCheckDialog(slug, saved) }, "New check"))),
    data.checks.length
      ? h("div", { class: "summary" },
          h("span", {}, h("b", {}, counts.up), " up"),
          h("span", {}, h("b", {}, counts.late), " late"),
          h("span", {}, h("b", {}, counts.down), " down"),
          h("span", { style: "margin-left:auto" }, `${data.checks.length} / 25 checks`))
      : null,
    h("div", { class: "checks" },
      data.checks.length
        ? data.checks.map((c) => checkRow(c, data.now, slug, saved, open.has(c.id)))
        : h("div", { class: "empty" },
            h("p", {}, "No checks yet. Add a heartbeat for a cron job, or an HTTP check for a website."),
            h("button", { class: "primary", onclick: () => openCheckDialog(slug, saved) }, "Add your first check"))),
    h("footer", {}, "Refreshes every 30 seconds."),
  );
  refreshTimer = setInterval(() => {
    if (!document.querySelector("dialog[open]")) renderProject(slug);
  }, 30_000);
}

function keyBox(slug, saved) {
  const link = `${location.origin}/#/p/${slug}?key=${saved.token}`;
  return h("div", { class: "keybox" },
    h("p", {}, h("b", {}, "Save your dashboard link."), " There are no accounts: this link (it holds your project key) is the only way to manage the project from another device."),
    h("div", { class: "copyline" }, h("code", {}, link), h("button", { type: "button", class: "ghost", onclick: () => copy(link) }, "Copy")),
    h("button", { class: "ghost", style: "margin-top:8px", onclick: () => { projects.put({ ...saved, fresh: false }); renderProject(slug); } }, "I saved it, hide this"));
}

function snippets(c) {
  const u = c.ping_url;
  return {
    curl: `curl -fsS -m 10 --retry 3 ${u}`,
    cron: `# report success or the exit code\n*/30 * * * *  /path/to/job.sh; curl -fsS -m 10 ${u}/$?`,
    "with timing": `curl -fsS -m 10 ${u}/start\n./job.sh && curl -fsS -m 10 ${u} || curl -fsS -m 10 --data-raw "$(tail -c 900 job.log)" ${u}/fail`,
    "GitHub Actions": `- name: Report to Lastping\n  if: always()\n  run: curl -fsS -m 10 ${u}/\${{ job.status == 'success' && '0' || '1' }}`,
    Python: `import urllib.request\nurllib.request.urlopen("${u}", timeout=10)`,
  };
}

function checkRow(c, now, slug, saved, isOpen) {
  const row = h("div", { class: `check${isOpen ? " open" : ""}`, "data-id": c.id });
  const lastText = c.kind === "http"
    ? c.fail_streak ? `${c.fail_streak} failed probe${c.fail_streak > 1 ? "s" : ""} in a row` : c.last_ping_at ? `${ago(c.last_ping_at, now)}${c.last_duration_ms ? ` · ${c.last_duration_ms} ms` : ""}` : "not probed yet"
    : c.last_ping_at ? `pinged ${ago(c.last_ping_at, now)}${c.last_duration_ms ? ` · ran ${(c.last_duration_ms / 1000).toFixed(1)} s` : ""}` : "no pings yet";

  const events = h("div", { class: "events" }, h("div", { class: "sub" }, "Loading events…"));
  const detail = h("div", { class: "detail" });

  const loadEvents = async () => {
    try {
      const r = await api(`/api/checks/${c.id}/events`, { token: saved.token });
      events.replaceChildren(...[
        h("div", { class: "section-title", style: "margin-top:4px" }, "Recent events"),
        r.events.length
          ? r.events.slice(0, 12).map((e) => h("div", { class: "ev" },
              h("span", {}, new Date(e.at).toLocaleString()),
              h("span", { class: `k ${e.kind}` }, e.kind.replace("_", " ")),
              h("span", {}, e.detail || "")))
          : h("div", { class: "sub" }, "Nothing yet.")].flat());
    } catch (ex) {
      events.replaceChildren(h("div", { class: "error" }, ex.message));
    }
  };

  if (c.kind === "heartbeat") {
    const snips = snippets(c);
    const pre = h("pre", {}, snips.curl);
    const tabs = h("div", { class: "tabs", role: "tablist" });
    for (const name of Object.keys(snips)) {
      tabs.append(h("button", {
        type: "button", role: "tab", "aria-selected": name === "curl" ? "true" : "false",
        onclick: (e) => {
          tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", "false"));
          e.currentTarget.setAttribute("aria-selected", "true");
          pre.textContent = snips[name];
        },
      }, name));
    }
    detail.append(
      h("div", { class: "copyline" }, h("code", {}, c.ping_url), h("button", { class: "ghost", onclick: () => copy(c.ping_url) }, "Copy")),
      h("div", { class: "snips" }, tabs, pre, h("button", { class: "ghost", style: "margin-top:4px", onclick: () => copy(pre.textContent) }, "Copy snippet")),
    );
  } else {
    detail.append(h("div", { class: "copyline" }, h("code", {}, c.url), h("a", { class: "btn ghost", href: c.url, target: "_blank", rel: "noopener" }, "Open")));
  }
  detail.append(events, h("div", { class: "acts" },
    h("button", { onclick: () => openCheckDialog(slug, saved, c) }, "Edit"),
    h("button", {
      onclick: async () => {
        await api(`/api/checks/${c.id}`, { method: "PATCH", token: saved.token, body: { paused: c.status !== "paused" } });
        toast(c.status === "paused" ? "Resumed" : "Paused");
        renderProject(slug);
      },
    }, c.status === "paused" ? "Resume" : "Pause"),
    h("button", {
      class: "danger",
      onclick: async () => {
        if (!confirm(`Delete "${c.name}" and its history?`)) return;
        await api(`/api/checks/${c.id}`, { method: "DELETE", token: saved.token });
        toast("Deleted");
        renderProject(slug);
      },
    }, "Delete")));

  const line = h("button", {
    class: "line", type: "button", "aria-expanded": isOpen ? "true" : "false",
    onclick: () => {
      const nowOpen = row.classList.toggle("open");
      line.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      if (nowOpen) loadEvents();
    },
  },
    h("span", { class: `dot ${c.status}` }),
    h("span", { class: "name" }, c.name),
    h("span", { class: "sched mono" }, schedule(c)),
    h("span", { class: "last" }, lastText),
    h("span", { class: `state ${c.status}` }, STATE_LABEL[c.status] || c.status));

  row.append(line, detail);
  if (isOpen) loadEvents();
  return row;
}

// ---------- dialogs ----------

const dlg = document.getElementById("checkDialog");
const form = document.getElementById("checkForm");
const $ = (id) => document.getElementById(id);
let dlgState = {};

function setPressed(group, attr, value) {
  form.querySelectorAll(`[${attr}]`).forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)));
}
function setKind(kind) {
  dlgState.kind = kind;
  setPressed(form, "data-kind", kind);
  form.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== kind));
}
function setSched(mode) {
  dlgState.sched = mode;
  setPressed(form, "data-sched", mode);
  form.querySelectorAll("[data-sched-panel]").forEach((el) => (el.hidden = el.dataset.schedPanel !== mode));
}
form.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => !dlgState.editing && setKind(b.dataset.kind)));
form.querySelectorAll("[data-sched]").forEach((b) => b.addEventListener("click", () => setSched(b.dataset.sched)));
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("[data-copy-from]").forEach((b) => b.addEventListener("click", () => copy($(b.dataset.copyFrom).textContent)));

let cronTimer;
$("fCron").addEventListener("input", () => {
  clearTimeout(cronTimer);
  cronTimer = setTimeout(async () => {
    const expr = $("fCron").value.trim();
    const out = $("cronPreview");
    if (!expr) { out.textContent = "Times are UTC."; return; }
    try {
      const r = await api(`/api/cron?expr=${encodeURIComponent(expr)}`);
      out.replaceChildren("Next runs (UTC):", ...r.next.slice(0, 3).map((t) => h("div", {}, new Date(t).toISOString().replace("T", " ").slice(0, 16))));
    } catch (ex) {
      out.textContent = ex.message;
    }
  }, 250);
});

function openCheckDialog(slug, saved, existing) {
  dlgState = { slug, saved, editing: existing || null };
  $("checkTitle").textContent = existing ? `Edit ${existing.name}` : "New check";
  $("checkSubmit").textContent = existing ? "Save" : "Create check";
  $("checkError").textContent = "";
  $("cronPreview").textContent = "Times are UTC.";
  form.querySelector(".seg").style.display = existing ? "none" : "";
  const c = existing || {};
  $("fName").value = c.name || "";
  $("fPublic").checked = c.is_public === undefined ? true : !!c.is_public;
  setKind(c.kind || "heartbeat");
  setSched(c.cron ? "cron" : "period");
  $("fCron").value = c.cron || "";
  const period = c.period_s || 3600;
  const unit = period % 86400 === 0 ? 86400 : period % 3600 === 0 ? 3600 : 60;
  $("fUnit").value = String(unit);
  $("fEvery").value = String(period / unit);
  $("fGrace").value = String(Math.round((c.grace_s || 300) / 60));
  $("fUrl").value = c.url || "";
  $("fInterval").value = String(c.interval_s || 300);
  $("fExpect").value = String(c.expect_status || 200);
  dlg.showModal();
  $("fName").focus();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const { slug, saved, editing, kind } = dlgState;
  const body = { name: $("fName").value, is_public: $("fPublic").checked };
  if (kind === "heartbeat") {
    if (dlgState.sched === "cron") body.cron = $("fCron").value.trim();
    else {
      body.cron = null;
      body.period_s = Math.round(Number($("fEvery").value) * Number($("fUnit").value));
    }
    body.grace_s = Math.round(Number($("fGrace").value) * 60);
  } else {
    body.url = $("fUrl").value.trim();
    body.interval_s = Number($("fInterval").value);
    body.expect_status = Number($("fExpect").value);
  }
  if (!editing) body.kind = kind;
  try {
    if (editing) await api(`/api/checks/${editing.id}`, { method: "PATCH", token: saved.token, body });
    else await api(`/api/projects/${slug}/checks`, { method: "POST", token: saved.token, body });
    dlg.close();
    toast(editing ? "Saved" : "Check created");
    renderProject(slug);
  } catch (ex) {
    $("checkError").textContent = ex.message;
  }
});

const sdlg = document.getElementById("settingsDialog");
let sState = {};
function openSettings(slug, saved, data) {
  sState = { slug, saved };
  $("sName").value = data.project.name;
  $("sAlert").value = data.project.alert_url || "";
  $("sLink").textContent = `${location.origin}/#/p/${slug}?key=${saved.token}`;
  $("settingsError").textContent = "";
  sdlg.showModal();
}
$("settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api(`/api/projects/${sState.slug}`, { method: "PATCH", token: sState.saved.token, body: { name: $("sName").value, alert_url: $("sAlert").value.trim() } });
    sdlg.close();
    toast("Saved");
    renderProject(sState.slug);
  } catch (ex) {
    $("settingsError").textContent = ex.message;
  }
});
$("testAlert").addEventListener("click", async () => {
  $("settingsError").textContent = "";
  try {
    await api(`/api/projects/${sState.slug}`, { method: "PATCH", token: sState.saved.token, body: { alert_url: $("sAlert").value.trim() } });
    await api(`/api/projects/${sState.slug}/alert-test`, { method: "POST", token: sState.saved.token });
    toast("Test alert sent");
  } catch (ex) {
    $("settingsError").textContent = ex.message;
  }
});
$("deleteProject").addEventListener("click", async () => {
  if (!confirm("Delete this project, all checks and history? This cannot be undone.")) return;
  try {
    await api(`/api/projects/${sState.slug}`, { method: "DELETE", token: sState.saved.token });
    projects.remove(sState.slug);
    sdlg.close();
    location.hash = "#/";
  } catch (ex) {
    $("settingsError").textContent = ex.message;
  }
});

route();
