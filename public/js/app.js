// Lastping dashboard. Vanilla JS, hash routing.
// A project is reachable either with its key (kept in localStorage) or through the signed-in passkey account.
const STORE = "lastping:projects";
const view = document.getElementById("view");
const drawerEl = document.getElementById("drawer");
const scrim = document.getElementById("scrim");
const modal = document.getElementById("modal");
const WA = window.SimpleWebAuthnBrowser;

let me = null; // { user, passkeys, projects } when signed in
let pollTimer = null;
let drawerState = null; // { slug, id, tab }

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only ever used with static SVG strings below
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const clear = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));

const ICON = {
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  key: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  ext: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
};
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0c0a08"/><path d="M5.5 17h5l2.6-6.5 4.2 12 2.6-5.5h2.3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25.6" cy="17" r="2.7" fill="#e4f222"/></svg>`;

// ---------- local key store ----------
const local = {
  all() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } },
  save(list) { try { localStorage.setItem(STORE, JSON.stringify(list)); } catch {} },
  get(slug) { return this.all().find((p) => p.slug === slug); },
  put(p) { this.save([p, ...this.all().filter((x) => x.slug !== p.slug)]); },
  remove(slug) { this.save(this.all().filter((x) => x.slug !== slug)); },
};

// ---------- api ----------
async function api(path, { method = "GET", body, slug } = {}) {
  const key = slug ? local.get(slug)?.token : null;
  const res = await fetch(path, {
    method,
    headers: {
      "x-lastping": "1",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2000);
}
async function copy(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Couldn't copy, select it manually"); }
}

// ---------- formatting ----------
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
const dur = (sec) => (sec % 86400 === 0 ? `${sec / 86400} d` : sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.round(sec / 60)} min`);
const pct = (x) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(x >= 0.9995 ? 2 : 2).replace(/\.00$/, "")}%`);
function schedule(c) {
  if (c.kind === "http") return `GET every ${dur(c.interval_s)}`;
  if (c.cron) return `cron ${c.cron}`;
  return `every ${dur(c.period_s)}`;
}
function lastSignal(c, now) {
  if (c.status === "paused") return "paused";
  if (c.kind === "http") {
    if (c.fail_streak) return `${c.fail_streak} failed probe${c.fail_streak > 1 ? "s" : ""}`;
    return c.last_ping_at ? `${c.last_duration_ms ?? "?"} ms · ${ago(c.last_ping_at, now)}` : "first probe within a minute";
  }
  if (!c.last_ping_at) return "waiting for first ping";
  return `${ago(c.last_ping_at, now)}${c.last_duration_ms ? ` · ran ${(c.last_duration_ms / 1000).toFixed(1)} s` : ""}`;
}
const STATE = { new: "Waiting", up: "Up", late: "Late", down: "Down", paused: "Paused" };
const chip = (status) => h("span", { class: `chip ${status}` }, STATE[status] || status);
function bars(days, n = 30) {
  const list = (days || []).slice(-n);
  return h("div", { class: "bars", "aria-hidden": "true" },
    list.map((u) => h("i", { class: u === null ? "none" : u >= 0.999 ? "" : u >= 0.95 ? "minor" : "major" })));
}

// ---------- auth ----------
async function loadMe() {
  try {
    const d = await api("/api/me");
    me = d.user ? d : null;
  } catch { me = null; }
}

async function claimLocal() {
  const list = local.all();
  if (!me || !list.length) return 0;
  const { claimed } = await api("/api/me/claim", { method: "POST", body: { projects: list.map((p) => ({ slug: p.slug, token: p.token })) } });
  return claimed;
}

async function passkeySignIn() {
  const options = await api("/api/auth/login/options", { method: "POST", body: {} });
  const response = await WA.startAuthentication({ optionsJSON: options });
  await api("/api/auth/login/verify", { method: "POST", body: response });
}
async function passkeyRegister(name) {
  const options = await api("/api/auth/register/options", { method: "POST", body: { name } });
  const response = await WA.startRegistration({ optionsJSON: options });
  await api("/api/auth/register/verify", { method: "POST", body: response });
}
function friendlyAuthError(e) {
  if (e?.name === "NotAllowedError") return "The passkey prompt was closed or timed out.";
  if (e?.name === "InvalidStateError") return "This device already has a passkey for your account. Use Sign in instead.";
  return e?.message || "Something went wrong.";
}
async function afterSignIn(message) {
  await loadMe();
  const claimed = await claimLocal().catch(() => 0);
  await loadMe();
  toast(claimed ? `${message} · ${claimed} project${claimed > 1 ? "s" : ""} added to your account` : message);
  location.hash = "#/";
}

// ---------- top bar ----------
function renderTopbar(crumbs = []) {
  clear(document.getElementById("crumbs"), crumbs.map((c, i) =>
    i === crumbs.length - 1 ? h("b", {}, c.label) : [h("a", { href: c.href }, c.label), h("span", { class: "ash" }, "/")]));
  const area = document.getElementById("userArea");
  if (!me) {
    clear(area, h("a", { class: "btn btn-ghost btn-sm", href: "/" }, "Home"), h("a", { class: "btn btn-dark btn-sm", href: "#/signin" }, "Sign in"));
    return;
  }
  const initials = me.user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const menu = h("div", { class: "menu", role: "menu" },
    h("div", { class: "who" }, h("div", {}, me.user.name), h("small", {}, `${me.passkeys.length} passkey${me.passkeys.length === 1 ? "" : "s"}`)),
    h("a", { href: "#/" }, "Projects"),
    h("a", { href: "#/account" }, "Account & passkeys"),
    h("a", { href: "/" }, "Lastping home"),
    h("button", { onclick: signOut }, "Sign out"));
  const btn = h("button", { class: "avatar", "aria-label": "Account menu", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); menu.classList.toggle("open"); } }, initials);
  clear(area, h("a", { class: "btn btn-primary btn-sm", href: "#/new" }, "New project"), h("div", { class: "menu-wrap" }, btn, menu));
}
document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open")));

async function signOut() {
  await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
  me = null;
  toast("Signed out");
  location.hash = "#/signin";
}

// ---------- router ----------
async function route() {
  clearInterval(pollTimer);
  closeDrawer(true);
  const hash = location.hash.slice(1) || "/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query || "");
  let m;
  if (path === "/signin") return renderSignin();
  if (path === "/new") return renderNew();
  if (path === "/account") return renderAccount();
  if ((m = path.match(/^\/p\/([a-z0-9-]+)$/))) {
    if (params.get("key")) {
      await importKey(m[1], params.get("key"));
      history.replaceState(null, "", `#/p/${m[1]}${params.get("welcome") ? "?welcome=1" : ""}`);
    }
    return renderProject(m[1], { welcome: params.has("welcome") });
  }
  return renderHome();
}
window.addEventListener("hashchange", route);

function mount(nodes, crumbs) {
  renderTopbar(crumbs);
  view.className = "view enter";
  clear(view, nodes);
  requestAnimationFrame(() => setTimeout(() => view.classList.remove("enter"), 700));
}

/** A key from a link is verified before it is stored, and never silently replaces a different saved key. */
async function importKey(slug, key) {
  const existing = local.get(slug);
  if (existing?.token === key) return;
  try {
    const res = await fetch(`/api/projects/${slug}`, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error();
    const d = await res.json();
    if (existing && !confirm(`Replace the saved key for "${existing.name}" with the one from this link?`)) return;
    local.put({ slug, name: d.project.name, token: key });
    if (me && !d.project.owned) {
      await api("/api/me/claim", { method: "POST", body: { projects: [{ slug, token: key }] } }).catch(() => {});
    }
  } catch {
    toast("That dashboard link is invalid");
  }
}

// ---------- sign in ----------
function renderSignin() {
  if (me) { location.hash = "#/"; return; }
  const supported = WA?.browserSupportsWebAuthn();
  const err = h("div", { class: "error-text", role: "alert" });
  const nameInput = h("input", { class: "input", placeholder: "Your name", maxlength: "60", autocomplete: "name", "aria-label": "Your name", required: true });
  const busy = async (btn, fn) => {
    err.textContent = "";
    btn.disabled = true;
    try { await fn(); } catch (e) { err.textContent = friendlyAuthError(e); } finally { btn.disabled = false; }
  };
  const signBtn = h("button", { class: "btn btn-primary btn-lg", type: "button", disabled: !supported, onclick: () => busy(signBtn, async () => { await passkeySignIn(); await afterSignIn("Signed in"); }) },
    h("span", { html: ICON.key, style: "display:contents" }), "Sign in with a passkey");
  const createForm = h("form", {
    onsubmit: (e) => {
      e.preventDefault();
      const btn = e.submitter;
      busy(btn, async () => { await passkeyRegister(nameInput.value.trim()); await afterSignIn("Account created"); });
    },
  }, h("div", { class: "field" }, nameInput), h("button", { class: "btn btn-outline btn-lg", type: "submit", disabled: !supported }, "Create an account"));

  mount([
    h("div", { class: "auth" },
      h("div", { class: "card auth-card" },
        h("div", { class: "mark", html: LOGO }),
        h("h1", {}, "Welcome to Lastping"),
        h("p", { class: "lead" }, "Sign in with your fingerprint, face or device PIN. No passwords, nothing to remember."),
        supported ? null : h("div", { class: "banner quiet" }, h("p", {}, "This browser doesn't support passkeys. You can still use Lastping without an account from the ", h("a", { href: "#/new" }, "new project page"), ".")),
        signBtn,
        h("div", { class: "divider" }, "New here?"),
        createForm,
        err,
        h("div", { class: "auth-foot" }, h("span", { html: ICON.shield, style: "display:contents" }),
          h("span", {}, "Your passkey stays on your device and syncs through iCloud Keychain, Google Password Manager or Windows Hello. Lastping only stores a public key.")))),
  ], [{ label: "Sign in" }]);
}

// ---------- projects home ----------
async function renderHome() {
  mount([h("div", { class: "skeleton" }), h("div", { class: "skeleton" })], []);
  if (me) await loadMe(); // project summaries change as pings arrive
  const owned = me ? me.projects : [];
  const ownedSlugs = new Set(owned.map((p) => p.slug));
  const deviceOnly = local.all().filter((p) => !ownedSlugs.has(p.slug));

  // Summaries for device-only projects come from their own endpoint.
  const deviceCards = await Promise.all(deviceOnly.map(async (p) => {
    try {
      const d = await api(`/api/projects/${p.slug}`, { slug: p.slug });
      const count = (s) => d.checks.filter((c) => c.status === s).length;
      return { slug: p.slug, name: d.project.name, up: count("up"), late: count("late"), down: count("down"), total: d.checks.length, device: true };
    } catch (e) {
      if (e.status === 401) local.remove(p.slug);
      return null;
    }
  }));
  const cards = [...owned.map((p) => ({ ...p, device: false })), ...deviceCards.filter(Boolean)];

  const banners = [];
  if (!me && cards.length) {
    banners.push(h("div", { class: "banner dark" },
      h("p", {}, h("b", {}, "Keep your projects safe. "), "They're saved in this browser only. Sign in with a passkey to see them on every device."),
      h("a", { class: "btn btn-primary", href: "#/signin" }, "Sign in")));
  }
  const unclaimed = me ? deviceCards.filter(Boolean) : [];
  if (unclaimed.length) {
    banners.push(h("div", { class: "banner accent" },
      h("p", {}, h("b", {}, `${unclaimed.length} project${unclaimed.length > 1 ? "s are" : " is"} only on this device. `), "Add them to your account to manage them anywhere."),
      h("button", { class: "btn btn-dark", onclick: async () => { const n = await claimLocal(); await loadMe(); toast(`${n} added to your account`); renderHome(); } }, "Add to account")));
  }

  if (!cards.length) {
    mount([
      h("div", { class: "card empty-big" },
        h("h2", {}, me ? `Welcome, ${me.user.name.split(" ")[0]}.` : "Start monitoring in a minute."),
        h("p", {}, "Create a project for an app or server, then add checks for its cron jobs, workers and websites."),
        h("a", { class: "btn btn-primary btn-lg", href: "#/new" }, "Create your first project")),
    ], [{ label: "Projects" }]);
    return;
  }

  mount([
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Projects"), h("div", { class: "sub" }, `${cards.length} project${cards.length > 1 ? "s" : ""}`)),
      h("div", { class: "actions" }, h("a", { class: "btn btn-primary", href: "#/new" }, "New project"))),
    banners,
    h("div", { class: "grid" },
      cards.map((p) => {
        const status = p.down ? "down" : p.late ? "late" : p.up ? "up" : "";
        return h("a", { class: "card pcard", href: `#/p/${p.slug}` },
          h("div", { class: "pcard-top" },
            h("div", { style: "min-width:0" }, h("h3", {}, p.name), h("div", { class: "slug" }, p.slug)),
            h("span", { class: `dot ${status}` })),
          h("div", { class: "pcard-foot" },
            p.total
              ? [p.up ? h("span", { class: "chip up" }, `${p.up} up`) : null, p.late ? h("span", { class: "chip late" }, `${p.late} late`) : null, p.down ? h("span", { class: "chip down" }, `${p.down} down`) : null,
                 !p.up && !p.late && !p.down ? h("span", { class: "chip" }, `${p.total} waiting`) : null]
              : h("span", { class: "chip" }, "No checks yet"),
            h("span", { class: "tag" }, p.device ? "This device" : "")));
      }),
      h("a", { class: "card pcard new", href: "#/new" }, h("span", { class: "plus" }, "+"), "New project")),
  ], [{ label: "Projects" }]);
}

// ---------- new project ----------
function renderNew() {
  const err = h("div", { class: "error-text", role: "alert" });
  const input = h("input", { class: "input", placeholder: "e.g. my-saas-production", maxlength: "60", required: true, "aria-label": "Project name" });
  mount([
    h("div", { class: "auth" },
      h("form", {
        class: "card auth-card",
        onsubmit: async (e) => {
          e.preventDefault();
          e.submitter.disabled = true;
          try {
            const r = await api("/api/projects", { method: "POST", body: { name: input.value.trim() } });
            if (!me) local.put({ slug: r.project.slug, name: r.project.name, token: r.token });
            await loadMe();
            location.hash = `#/p/${r.project.slug}?welcome=1`;
          } catch (ex) {
            err.textContent = ex.message;
            e.submitter.disabled = false;
          }
        },
      },
        h("div", { class: "mark", html: LOGO }),
        h("h1", {}, "Create a project"),
        h("p", { class: "lead" }, "A project groups the checks for one app, server or team, and gets its own status page."),
        h("div", { class: "field" }, h("label", { class: "label" }, "Project name"), input),
        h("button", { class: "btn btn-primary btn-lg", type: "submit" }, "Create project"),
        err,
        me ? null : h("p", { class: "hint", style: "margin-top:16px" }, "You're not signed in, so the project is saved in this browser. ", h("a", { href: "#/signin" }, "Sign in"), " to keep it on every device."))),
  ], [{ label: "Projects", href: "#/" }, { label: "New project" }]);
  setTimeout(() => input.focus(), 50);
}

// ---------- project ----------
let current = null; // { slug, data }

async function renderProject(slug, { welcome = false, silent = false } = {}) {
  if (!silent) mount([h("div", { class: "skeleton", style: "height:90px" }), h("div", { class: "skeleton", style: "height:300px" })], [{ label: "Projects", href: "#/" }, { label: slug }]);
  let data;
  try {
    data = await api(`/api/projects/${slug}`, { slug });
  } catch (e) {
    if (silent) return;
    mount([h("div", { class: "card empty-big" },
      h("h2", {}, "You don't have access to this project"),
      h("p", {}, me ? "It isn't in your account. Open its dashboard link on this device to add it." : "Sign in, or open the project's dashboard link on this device."),
      h("div", { class: "actions", style: "justify-content:center" },
        me ? null : h("a", { class: "btn btn-primary", href: "#/signin" }, "Sign in"),
        h("a", { class: "btn btn-quiet", href: `/s/${slug}` }, "View public status page")))], [{ label: "Projects", href: "#/" }, { label: slug }]);
    return;
  }
  current = { slug, data };
  const p = data.project;
  const checks = data.checks;
  const now = data.now;
  const count = (s) => checks.filter((c) => c.status === s).length;
  const active = checks.filter((c) => c.status !== "paused");
  const upt = checks.map((c) => c.uptime_30d).filter((x) => x !== null && x !== undefined);
  const avgUptime = upt.length ? upt.reduce((a, b) => a + b, 0) / upt.length : null;
  const key = local.get(slug)?.token;
  const statusUrl = `${location.origin}/s/${slug}`;

  const headline = !checks.length ? "No checks yet"
    : count("down") ? `${count("down")} of ${active.length} down`
    : count("late") ? `${count("late")} running late`
    : count("up") === active.length ? `All ${active.length} check${active.length === 1 ? "" : "s"} up`
    : `${count("up")} of ${active.length} up`;

  const banners = [];
  if (key && !p.owned) {
    const link = `${location.origin}/app#/p/${slug}?key=${key}`;
    banners.push(me
      ? h("div", { class: "banner accent" },
          h("p", {}, h("b", {}, "This project is only on this device. "), "Add it to your account so it's safe and available everywhere."),
          h("button", { class: "btn btn-dark", onclick: async () => { await api("/api/me/claim", { method: "POST", body: { projects: [{ slug, token: key }] } }); await loadMe(); toast("Added to your account"); renderProject(slug, { silent: true }); } }, "Add to account"))
      : h("div", { class: "banner dark" },
          h("p", {}, h("b", {}, welcome ? "Project created. " : "Saved in this browser only. "), "Sign in with a passkey to keep it on all your devices, or save this private link."),
          h("a", { class: "btn btn-primary", href: "#/signin" }, "Sign in"),
          h("div", { class: "copyline" }, h("code", {}, link), h("button", { class: "btn btn-ghost btn-sm", style: "color:inherit", onclick: () => copy(link, "Private link copied") }, "Copy"))));
  }

  const table = checks.length
    ? h("div", { class: "card table" },
        h("div", { class: "thead" }, h("span"), h("span", {}, "Check"), h("span", {}, "Schedule"), h("span", {}, "Last signal"), h("span", {}, "Last 30 days"), h("span", { style: "text-align:right" }, "Status")),
        checks.map((c) => h("button", {
          class: `trow${drawerState?.id === c.id ? " active" : ""}`, type: "button", "data-id": c.id,
          onclick: () => openDrawer(slug, c.id, c.status === "new" ? "setup" : "activity"),
        },
          h("span", { class: `dot ${c.status}` }),
          h("span", { class: "name" }, c.name, h("span", { class: "kind" }, c.kind === "http" ? "Uptime check" : "Heartbeat")),
          h("span", { class: "sched" }, schedule(c)),
          h("span", { class: "last" }, lastSignal(c, now)),
          h("span", { class: "upt" }, bars(c.days), h("span", { class: "pct num" }, pct(c.uptime_30d))),
          h("span", { class: "st" }, chip(c.status)))))
    : onboarding(slug);

  mount([
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", {}, p.name),
        h("div", { class: "sub" },
          checks.length ? chip(count("down") ? "down" : count("late") ? "late" : count("up") ? "up" : "new") : null,
          h("span", {}, headline),
          h("a", { href: statusUrl, target: "_blank", rel: "noopener" }, "Status page ↗"))),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-quiet", onclick: () => openProjectSettings(slug) }, "Settings"),
        h("button", { class: "btn btn-primary", onclick: () => openCheckModal(slug) }, "New check"))),
    banners,
    checks.length
      ? h("div", { class: "stats" },
          h("div", { class: "wash stat" }, h("div", { class: "eyebrow" }, "Up"), h("div", { class: "v num" }, String(count("up")), h("small", {}, ` / ${active.length}`))),
          h("div", { class: "wash stat" }, h("div", { class: "eyebrow" }, "Down now"), h("div", { class: `v num${count("down") ? " bad" : ""}` }, String(count("down")))),
          h("div", { class: "wash stat" }, h("div", { class: "eyebrow" }, "30-day uptime"), h("div", { class: "v num" }, pct(avgUptime))),
          h("div", { class: "wash stat" }, h("div", { class: "eyebrow" }, "Alerts"),
            h("div", { class: "v", style: "font-size:20px;margin-top:14px" }, p.alert_url ? channelName(p.alert_url) : h("a", { href: "#", onclick: (e) => { e.preventDefault(); openProjectSettings(slug); } }, "Off · set up →"))))
      : null,
    table,
  ], [{ label: "Projects", href: "#/" }, { label: p.name }]);

  if (drawerState?.slug === slug) renderDrawer();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!modal.open) refreshProject(slug); }, 15_000);
}

/** Quiet refresh that keeps scroll position and the open drawer. */
async function refreshProject(slug) {
  try {
    const data = await api(`/api/projects/${slug}`, { slug });
    current = { slug, data };
    const y = scrollY;
    await renderProject(slug, { silent: true });
    scrollTo(0, y);
  } catch {}
}

function onboarding(slug) {
  return h("div", { class: "card onboard" },
    h("h2", {}, "What do you want to monitor?"),
    h("p", {}, "Pick one to start. You can add up to 25 checks per project."),
    h("div", { class: "choices" },
      h("button", { class: "choice", onclick: () => openCheckModal(slug, "heartbeat") },
        h("div", { class: "ic", html: ICON.clock }), h("h3", {}, "A cron job or worker"),
        h("p", {}, "It pings Lastping when it runs. If the ping doesn't come on time, you get an alert.")),
      h("button", { class: "choice", onclick: () => openCheckModal(slug, "http") },
        h("div", { class: "ic", html: ICON.globe }), h("h3", {}, "A website or API"),
        h("p", {}, "Lastping requests the URL every minute and alerts you when it stops answering."))));
}

function channelName(url) {
  try {
    const host = new URL(url).hostname;
    if (host.includes("discord")) return "Discord";
    if (host === "hooks.slack.com") return "Slack";
    if (host.startsWith("ntfy")) return "ntfy push";
    return "Webhook";
  } catch { return "Webhook"; }
}

// ---------- drawer ----------
function openDrawer(slug, id, tab = "setup") {
  drawerState = { slug, id, tab };
  document.querySelectorAll(".trow").forEach((r) => r.classList.toggle("active", r.dataset.id === id));
  renderDrawer();
  drawerEl.classList.add("open");
  drawerEl.setAttribute("aria-hidden", "false");
  scrim.classList.add("open");
}
function closeDrawer(instant) {
  drawerState = null;
  clearInterval(drawerEl._poll);
  drawerEl.classList.remove("open");
  drawerEl.setAttribute("aria-hidden", "true");
  scrim.classList.remove("open");
  document.querySelectorAll(".trow.active").forEach((r) => r.classList.remove("active"));
  if (instant) clear(drawerEl);
}
scrim.addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawerState && !modal.open) closeDrawer(); });

function renderDrawer() {
  if (!drawerState || !current) return;
  const c = current.data.checks.find((x) => x.id === drawerState.id);
  if (!c) return closeDrawer();
  const tabs = [["setup", "Setup"], ["activity", "Activity"], ["settings", "Settings"]];
  const body = h("div", { class: "dr-body" });
  clear(drawerEl,
    h("div", { class: "dr-head" },
      h("div", { class: "dr-title" },
        h("span", { class: `dot ${c.status}` }),
        h("h2", {}, c.name),
        chip(c.status),
        h("button", { class: "btn btn-ghost btn-icon btn-sm", "aria-label": "Close", onclick: () => closeDrawer(), html: ICON.x })),
      h("div", { class: "dr-meta" }, `${c.kind === "http" ? "Uptime check" : "Heartbeat"} · ${schedule(c)}${c.kind === "heartbeat" ? ` · grace ${dur(c.grace_s)}` : ""}`),
      h("div", { class: "dr-tabs", role: "tablist" },
        tabs.map(([k, label]) => h("button", { role: "tab", "aria-selected": String(drawerState.tab === k), onclick: () => { drawerState.tab = k; renderDrawer(); } }, label)))),
    body);
  clearInterval(drawerEl._poll);
  if (drawerState.tab === "setup") setupTab(body, c);
  if (drawerState.tab === "activity") activityTab(body, c);
  if (drawerState.tab === "settings") settingsTab(body, c);
}

function snippets(u) {
  return {
    curl: `curl -fsS -m 10 --retry 3 ${u}`,
    crontab: `# report success, or the exit code so failures alert at once\n*/15 * * * *  /path/to/job.sh; curl -fsS -m 10 ${u}/$?`,
    "GitHub Actions": `- name: Report to Lastping\n  if: always()\n  run: curl -fsS -m 10 ${u}/\${{ job.status == 'success' && '0' || '1' }}`,
    Python: `import urllib.request\nurllib.request.urlopen("${u}", timeout=10)`,
    "Node.js": `await fetch("${u}", { signal: AbortSignal.timeout(10_000) });`,
    "With timing": `curl -fsS ${u}/start\n./job.sh && curl -fsS ${u} \\\n  || curl -fsS --data-raw "$(tail -c 900 job.log)" ${u}/fail`,
  };
}

function setupTab(body, c) {
  const now = current.data.now;
  if (c.kind === "heartbeat") {
    const waiting = !c.last_ping_at;
    const state = waiting
      ? h("div", { class: "waiting" }, h("span", { class: "pulse" }),
          h("p", {}, "Waiting for the first ping…", h("small", {}, "Add the line below to your job, or send a test ping now.")),
          h("button", { class: "btn btn-dark btn-sm", onclick: async (e) => {
            e.currentTarget.disabled = true;
            await fetch(c.ping_url, { method: "POST", body: "test ping from the dashboard" }).catch(() => {});
            await refreshProject(current.slug);
          } }, "Send test ping"))
      : h("div", { class: `waiting ${c.status === "down" ? "bad" : "ok"}` }, h("span", { class: "pulse" }),
          h("p", {}, c.status === "down" ? "This check is down" : "Receiving pings",
            h("small", {}, `Last ping ${ago(c.last_ping_at, now)}${c.due_at ? ` · next expected ${new Date(c.due_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}`)));
    const snips = snippets(c.ping_url);
    const pre = h("pre", {}, snips.curl);
    const tabRow = h("div", { class: "tabs", role: "tablist" });
    for (const name of Object.keys(snips)) {
      tabRow.append(h("button", { type: "button", role: "tab", "aria-selected": String(name === "curl"), onclick: (e) => {
        tabRow.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", "false"));
        e.currentTarget.setAttribute("aria-selected", "true");
        pre.textContent = snips[name];
      } }, name));
    }
    clear(body,
      state,
      h("div", { class: "dr-section" }, h("span", { class: "eyebrow" }, "Ping URL"),
        h("div", { class: "copyline" }, h("code", {}, c.ping_url), h("button", { class: "btn btn-quiet btn-sm", onclick: () => copy(c.ping_url, "Ping URL copied") }, "Copy")),
        h("p", { class: "hint" }, "Keep it private: anyone with this URL can report pings for this check.")),
      h("div", { class: "dr-section snips" }, h("span", { class: "eyebrow" }, "Add it to your job"), tabRow, pre,
        h("button", { class: "btn btn-ghost btn-sm", style: "margin-top:8px", onclick: () => copy(pre.textContent, "Snippet copied") }, "Copy snippet")),
      h("div", { class: "dr-section" }, h("span", { class: "eyebrow" }, "Endpoints"),
        h("dl", { class: "kv" },
          h("dt", {}, "/ping/<id>"), h("dd", {}, "Success"),
          h("dt", {}, "/ping/<id>/start"), h("dd", {}, "Job started, measures run time"),
          h("dt", {}, "/ping/<id>/fail"), h("dd", {}, "Failed: alert now, POST body is kept as the log"),
          h("dt", {}, "/ping/<id>/<code>"), h("dd", {}, "Exit code: 0 is success, anything else fails"))));
    if (waiting) drawerEl._poll = setInterval(() => refreshProject(current.slug), 4000);
  } else {
    clear(body,
      h("div", { class: `waiting ${c.status === "down" ? "bad" : c.last_ping_at ? "ok" : ""}` }, h("span", { class: "pulse" }),
        h("p", {}, c.status === "down" ? "Not responding" : c.last_ping_at ? "Responding" : "First probe within a minute…",
          h("small", {}, c.last_ping_at ? `Last success ${ago(c.last_ping_at, now)}${c.last_duration_ms ? ` · ${c.last_duration_ms} ms` : ""}` : "Lastping checks every minute."))),
      h("div", { class: "dr-section" }, h("span", { class: "eyebrow" }, "Monitoring"),
        h("dl", { class: "kv" },
          h("dt", {}, "URL"), h("dd", {}, h("a", { href: c.url, target: "_blank", rel: "noopener" }, c.url)),
          h("dt", {}, "Interval"), h("dd", {}, `every ${dur(c.interval_s)}`),
          h("dt", {}, "Expected"), h("dd", {}, c.expect_status === 200 ? "any 2xx or 3xx" : `HTTP ${c.expect_status}`),
          h("dt", {}, "Goes down after"), h("dd", {}, "2 failed probes in a row"),
          h("dt", {}, "30-day uptime"), h("dd", { class: "num" }, pct(c.uptime_30d)))),
      h("div", { class: "dr-section" }, h("span", { class: "eyebrow" }, "Last 30 days"), h("div", { style: "height:34px;display:flex" }, bars(c.days))));
    if (!c.last_ping_at && c.status !== "down") drawerEl._poll = setInterval(() => refreshProject(current.slug), 5000);
  }
}

const EVENT_TEXT = {
  ping: "Ping received", start: "Job started", fail: "Job reported failure", late: "Running late",
  down: "Went down", up: "Recovered", probe_fail: "Probe failed", paused: "Paused", resumed: "Resumed",
};
async function activityTab(body, c) {
  clear(body, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
  try {
    const { events } = await api(`/api/checks/${c.id}/events`, { slug: current.slug });
    clear(body, events.length
      ? h("ul", { class: "timeline" }, events.map((e) => h("li", {},
          h("span", { class: `tdot ${e.kind}` }),
          h("span", { class: "what" }, h("b", {}, EVENT_TEXT[e.kind] || e.kind), e.detail ? h("small", {}, e.detail) : null),
          h("time", { datetime: new Date(e.at).toISOString(), title: new Date(e.at).toLocaleString() }, ago(e.at)))))
      : h("div", { class: "empty-big", style: "padding:40px 0" }, h("p", {}, "No activity yet.")));
  } catch (e) {
    clear(body, h("div", { class: "error-text" }, e.message));
  }
}

function settingsTab(body, c) {
  const form = checkForm(c.kind, c);
  const err = h("div", { class: "error-text", role: "alert" });
  clear(body,
    h("form", {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          await api(`/api/checks/${c.id}`, { method: "PATCH", slug: current.slug, body: form.values() });
          toast("Saved");
          await refreshProject(current.slug);
        } catch (ex) { err.textContent = ex.message; }
      },
    }, form.el, err, h("div", { class: "mfoot" }, h("button", { class: "btn btn-primary", type: "submit" }, "Save changes"))),
    h("hr", { class: "sep" }),
    h("div", { class: "actions" },
      h("button", { class: "btn btn-quiet", onclick: async () => {
        await api(`/api/checks/${c.id}`, { method: "PATCH", slug: current.slug, body: { paused: c.status !== "paused" } });
        toast(c.status === "paused" ? "Resumed" : "Paused, no alerts until you resume");
        await refreshProject(current.slug);
      } }, c.status === "paused" ? "Resume monitoring" : "Pause monitoring"),
      h("button", { class: "btn btn-danger", onclick: async () => {
        if (!confirm(`Delete "${c.name}" and its history? This can't be undone.`)) return;
        await api(`/api/checks/${c.id}`, { method: "DELETE", slug: current.slug });
        closeDrawer();
        toast("Check deleted");
        await refreshProject(current.slug);
      } }, "Delete check")));
}

// ---------- check form (create + edit) ----------
const PRESETS = [["Every 5 min", 300], ["Every 15 min", 900], ["Hourly", 3600], ["Daily", 86400], ["Cron expression", "cron"]];

function checkForm(kind, c = {}) {
  const name = h("input", { class: "input", maxlength: "80", value: c.name || "", placeholder: kind === "http" ? "Optional, defaults to the hostname" : "e.g. nightly-backup", "aria-label": "Name" });
  const isPublic = h("input", { type: "checkbox", checked: c.is_public === undefined ? true : !!c.is_public });
  const pub = h("label", { class: "check-line" }, isPublic, "Show on the public status page");

  if (kind === "http") {
    const url = h("input", { class: "input mono", type: "url", value: c.url || "", placeholder: "https://example.com/health", required: true, "aria-label": "URL" });
    const interval = h("select", { class: "input", "aria-label": "Interval" },
      [[60, "Every minute"], [300, "Every 5 minutes"], [900, "Every 15 minutes"], [3600, "Every hour"]].map(([v, l]) => h("option", { value: v, selected: (c.interval_s || 60) === v }, l)));
    const expect = h("input", { class: "input", type: "number", min: "100", max: "599", value: c.expect_status || 200, "aria-label": "Expected status" });
    return {
      el: h("div", {},
        h("div", { class: "field" }, h("label", { class: "label" }, "URL"), url),
        h("div", { class: "field" }, h("label", { class: "label" }, "Name"), name),
        h("div", { class: "field" }, h("label", { class: "label" }, "Check"), interval),
        h("details", { class: "adv" }, h("summary", {}, "Advanced"),
          h("div", { class: "field" }, h("label", { class: "label" }, "Expected status code"), expect,
            h("p", { class: "hint" }, "200 accepts any 2xx or 3xx response."))),
        pub),
      values() {
        let n = name.value.trim();
        if (!n) { try { n = new URL(url.value).hostname; } catch { n = url.value; } }
        return { name: n, url: url.value.trim(), interval_s: Number(interval.value), expect_status: Number(expect.value), is_public: isPublic.checked };
      },
      focus: () => url.focus(),
    };
  }

  let mode = c.cron ? "cron" : PRESETS.find(([, v]) => v === (c.period_s || 3600))?.[1] ?? "custom";
  const cron = h("input", { class: "input mono", value: c.cron || "", placeholder: "0 3 * * *", autocomplete: "off", spellcheck: "false", "aria-label": "Cron expression" });
  const preview = h("div", { class: "preview" }, "Times are in UTC.");
  const every = h("input", { class: "input", type: "number", min: "1", value: String(Math.max(1, Math.round((c.period_s || 3600) / 60))), "aria-label": "Minutes" });
  const cronBox = h("div", { class: "field", hidden: mode !== "cron" }, h("label", { class: "label" }, "Cron expression (UTC)"), cron, preview);
  const customBox = h("div", { class: "field", hidden: mode !== "custom" }, h("label", { class: "label" }, "Every N minutes"), every);
  const presetRow = h("div", { class: "presets" });
  const paint = () => {
    presetRow.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(mode))));
    cronBox.hidden = mode !== "cron";
    customBox.hidden = mode !== "custom";
  };
  for (const [label, v] of [...PRESETS, ["Custom", "custom"]]) {
    presetRow.append(h("button", { type: "button", "data-v": String(v), onclick: () => { mode = v; paint(); if (v === "cron") cron.focus(); } }, label));
  }
  paint();
  let t;
  const updatePreview = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const expr = cron.value.trim();
      if (!expr) { preview.textContent = "Times are in UTC."; return; }
      try {
        const r = await api(`/api/cron?expr=${encodeURIComponent(expr)}`);
        clear(preview, "Next runs: ", r.next.slice(0, 3).map((x, i) => [i ? " · " : "", new Date(x).toISOString().slice(5, 16).replace("T", " ")]));
      } catch (e) { preview.textContent = e.message; }
    }, 250);
  };
  cron.addEventListener("input", updatePreview);
  if (c.cron) updatePreview();
  const grace = h("select", { class: "input", "aria-label": "Grace time" },
    [[300, "5 minutes"], [900, "15 minutes"], [1800, "30 minutes"], [3600, "1 hour"], [21600, "6 hours"]].map(([v, l]) => h("option", { value: v, selected: (c.grace_s || 900) === v }, l)));

  return {
    el: h("div", {},
      h("div", { class: "field" }, h("label", { class: "label" }, "Name"), name),
      h("div", { class: "field" }, h("label", { class: "label" }, "How often does it run?"), presetRow),
      cronBox, customBox,
      h("div", { class: "field" }, h("label", { class: "label" }, "Alert if it's late by"), grace,
        h("p", { class: "hint" }, "Extra time allowed after the expected run before the check goes down.")),
      pub),
    values() {
      const v = { name: name.value.trim(), grace_s: Number(grace.value), is_public: isPublic.checked };
      if (mode === "cron") { v.cron = cron.value.trim(); }
      else { v.cron = null; v.period_s = mode === "custom" ? Math.round(Number(every.value) * 60) : Number(mode); }
      return v;
    },
    focus: () => name.focus(),
  };
}

function openCheckModal(slug, kind = "heartbeat") {
  let form;
  const err = h("div", { class: "error-text", role: "alert" });
  const slot = h("div");
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Check type" });
  const setKind = (k) => {
    kind = k;
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.k === k)));
    form = checkForm(k);
    clear(slot, form.el);
    setTimeout(() => form.focus(), 30);
  };
  seg.append(
    h("button", { type: "button", "data-k": "heartbeat", onclick: () => setKind("heartbeat") }, "Cron job or worker", h("small", {}, "It pings Lastping")),
    h("button", { type: "button", "data-k": "http", onclick: () => setKind("http") }, "Website or API", h("small", {}, "Lastping checks it")));
  clear(modal, h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      e.submitter.disabled = true;
      try {
        const created = await api(`/api/projects/${slug}/checks`, { method: "POST", slug, body: { kind, ...form.values() } });
        modal.close();
        toast("Check created");
        await renderProject(slug, { silent: true });
        openDrawer(slug, created.id, "setup");
      } catch (ex) {
        err.textContent = ex.message;
        e.submitter.disabled = false;
      }
    },
  },
    h("h2", {}, "New check"),
    h("p", { class: "lead" }, "Get alerted the moment something stops."),
    seg, slot, err,
    h("div", { class: "mfoot" }, h("button", { class: "btn btn-ghost", type: "button", onclick: () => modal.close() }, "Cancel"), h("button", { class: "btn btn-primary", type: "submit" }, "Create check"))));
  setKind(kind);
  modal.showModal();
}

// ---------- project settings ----------
const CHANNELS = {
  ntfy: { label: "Phone push (ntfy)", placeholder: "https://ntfy.sh/pick-a-secret-topic", help: "Install the free ntfy app, subscribe to a topic name only you know, and paste its URL here." },
  discord: { label: "Discord", placeholder: "https://discord.com/api/webhooks/…", help: "Channel settings → Integrations → Webhooks → New webhook → Copy URL." },
  slack: { label: "Slack", placeholder: "https://hooks.slack.com/services/…", help: "Create an Incoming Webhook in your Slack app settings and paste its URL." },
  webhook: { label: "Webhook", placeholder: "https://example.com/hooks/lastping", help: "Lastping POSTs JSON with project, check, status, detail and a status page link." },
};
function guessChannel(url) {
  const n = url ? channelName(url) : "";
  return n === "Discord" ? "discord" : n === "Slack" ? "slack" : n === "ntfy push" ? "ntfy" : url ? "webhook" : "ntfy";
}

function openProjectSettings(slug) {
  const p = current.data.project;
  const key = local.get(slug)?.token;
  const err = h("div", { class: "error-text", role: "alert" });
  const name = h("input", { class: "input", value: p.name, maxlength: "60", required: true, "aria-label": "Project name" });
  const alertUrl = h("input", { class: "input mono", value: p.alert_url || "", "aria-label": "Alert URL" });
  const help = h("p", { class: "hint" });
  let channel = guessChannel(p.alert_url);
  const chans = h("div", { class: "presets" });
  const paintChannel = () => {
    chans.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === channel)));
    alertUrl.placeholder = CHANNELS[channel].placeholder;
    help.textContent = CHANNELS[channel].help;
  };
  for (const [k, v] of Object.entries(CHANNELS)) chans.append(h("button", { type: "button", "data-c": k, onclick: () => { channel = k; paintChannel(); alertUrl.focus(); } }, v.label));
  paintChannel();

  const statusUrl = `${location.origin}/s/${slug}`;
  const badge = `[![status](${location.origin}/badge/${slug}.svg)](${statusUrl})`;
  const save = async () => api(`/api/projects/${slug}`, { method: "PATCH", slug, body: { name: name.value.trim(), alert_url: alertUrl.value.trim() } });

  clear(modal, h("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      try { await save(); modal.close(); toast("Settings saved"); await loadMe(); renderProject(slug, { silent: true }); } catch (ex) { err.textContent = ex.message; }
    },
  },
    h("h2", {}, "Project settings"),
    h("p", { class: "lead" }, p.owned ? "This project belongs to your account." : "This project is managed with its private key."),
    h("div", { class: "field" }, h("label", { class: "label" }, "Name"), name),
    h("div", { class: "field" }, h("label", { class: "label" }, "Send alerts to"), chans),
    h("div", { class: "field" }, alertUrl, help),
    h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: async () => {
      err.textContent = "";
      try { await save(); await api(`/api/projects/${slug}/alert-test`, { method: "POST", slug, body: {} }); toast("Test alert sent"); } catch (ex) { err.textContent = ex.message; }
    } }, "Send a test alert"),
    h("hr", { class: "sep" }),
    h("div", { class: "field" }, h("label", { class: "label" }, "Public status page"),
      h("div", { class: "copyline" }, h("code", {}, statusUrl), h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => copy(statusUrl) }, "Copy"))),
    h("div", { class: "field" }, h("label", { class: "label" }, "README badge"),
      h("div", { class: "copyline" }, h("img", { src: `/badge/${slug}.svg`, alt: "", height: "20" }), h("code", {}, badge), h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => copy(badge, "Badge markdown copied") }, "Copy"))),
    key ? h("div", { class: "field" }, h("label", { class: "label" }, "Private dashboard link"),
      h("div", { class: "copyline" }, h("code", {}, `${location.origin}/app#/p/${slug}?key=${key}`), h("button", { class: "btn btn-quiet btn-sm", type: "button", onclick: () => copy(`${location.origin}/app#/p/${slug}?key=${key}`, "Private link copied") }, "Copy")),
      h("p", { class: "hint" }, "Anyone with this link can manage the project. Keep it private.")) : null,
    err,
    h("div", { class: "mfoot" },
      h("button", { class: "btn btn-danger left", type: "button", onclick: async () => {
        if (!confirm("Delete this project, all its checks and history? This can't be undone.")) return;
        try { await api(`/api/projects/${slug}`, { method: "DELETE", slug }); local.remove(slug); modal.close(); await loadMe(); toast("Project deleted"); location.hash = "#/"; } catch (ex) { err.textContent = ex.message; }
      } }, "Delete project"),
      h("button", { class: "btn btn-ghost", type: "button", onclick: () => modal.close() }, "Cancel"),
      h("button", { class: "btn btn-primary", type: "submit" }, "Save"))));
  modal.showModal();
}

// ---------- account ----------
function renderAccount() {
  if (!me) { location.hash = "#/signin"; return; }
  const err = h("div", { class: "error-text", role: "alert" });
  mount([
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Account"), h("div", { class: "sub" }, `Member since ${new Date(me.user.created_at).toLocaleDateString([], { dateStyle: "long" })}`))),
    h("div", { style: "max-width:720px" },
      h("div", { class: "card panel" },
        h("h2", {}, "Passkeys"),
        h("p", {}, "Each passkey can sign you in. Synced passkeys follow you across devices; add one per device that doesn't sync."),
        h("ul", { class: "passkeys" }, me.passkeys.map((k) => h("li", {},
          h("span", { class: "ic", html: ICON.key }),
          h("p", {}, k.label || "Passkey", h("small", {}, `Added ${new Date(k.created_at).toLocaleDateString()} · last used ${ago(k.last_used_at)}`)),
          me.passkeys.length > 1 ? h("button", { class: "btn btn-danger btn-sm", onclick: async () => {
            if (!confirm("Remove this passkey? It will no longer sign you in.")) return;
            try { await api(`/api/me/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" }); await loadMe(); renderAccount(); toast("Passkey removed"); } catch (e) { err.textContent = e.message; }
          } }, "Remove") : null))),
        h("div", { class: "actions", style: "margin-top:18px" },
          h("button", { class: "btn btn-dark", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await passkeyRegister(me.user.name); await loadMe(); renderAccount(); toast("Passkey added"); } catch (ex) { err.textContent = friendlyAuthError(ex); e.currentTarget.disabled = false; }
          } }, "Add a passkey on this device")),
        err),
      h("div", { class: "card panel" },
        h("h2", {}, "Session"),
        h("p", {}, "You stay signed in on this browser for 30 days."),
        h("button", { class: "btn btn-quiet", onclick: signOut }, "Sign out"))),
  ], [{ label: "Account" }]);
}

// ---------- boot ----------
await loadMe();
route();
