// Landing page: hero quick-start, animated product preview, live stats, snippet tabs.
const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- signed-in state in the nav ----
fetch("/api/me").then((r) => r.json()).then((d) => {
  if (!d.user) return;
  const a = $("navSignin");
  a.textContent = "Dashboard";
  a.href = "/app";
}).catch(() => {});

// ---- hero: create a project straight from the landing page ----
$("heroForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lastping": "1" },
      body: JSON.stringify({ name: $("heroName").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    // Hand the key to the dashboard; it stores it and shows onboarding.
    location.href = `/app#/p/${data.project.slug}?key=${data.token}&welcome=1`;
  } catch (err) {
    $("heroNote").textContent = err.message;
    btn.disabled = false;
  }
});

// ---- fake uptime bars for illustrations ----
function fillBars(el, n, badIndex = -1) {
  el.replaceChildren(...Array.from({ length: n }, (_, i) => {
    const b = document.createElement("i");
    if (i === badIndex) b.className = "minor";
    return b;
  }));
}
document.querySelectorAll("[data-fake-bars]").forEach((el) => fillBars(el, Number(el.dataset.fakeBars), Number(el.dataset.bad ?? -1)));

// ---- animated product preview ----
const rows = [
  { name: "nightly-backup", sched: "cron 0 3 * * *", last: "ran 38.2 s · 6 h ago", state: "up" },
  { name: "api.acme.dev", sched: "GET every 1 min", last: "84 ms · just now", state: "up" },
  { name: "billing-worker", sched: "every 5 min · grace 10 min", last: "pinged 2 min ago", state: "up" },
  { name: "sitemap-rebuild", sched: "cron 0 */6 * * *", last: "ran 4.1 s · 1 h ago", state: "up" },
  { name: "status.acme.dev", sched: "GET every 1 min", last: "112 ms · just now", state: "up" },
];
const LABEL = { up: "Up", late: "Late", down: "Down" };
const rowEls = rows.map((r, i) => {
  const el = document.createElement("div");
  el.className = "mrow";
  el.innerHTML = `<span class="dot"></span><span class="name"></span><span class="sched"></span><div class="bars"></div><span class="state"><span class="chip"></span></span>`;
  el.querySelector(".name").textContent = r.name;
  el.querySelector(".sched").textContent = r.sched;
  fillBars(el.querySelector(".bars"), 30, i === 2 ? 17 : i === 4 ? 8 : -1);
  $("mockRows").append(el);
  return el;
});
function paint(i, state, last) {
  const el = rowEls[i];
  el.querySelector(".dot").className = `dot ${state}`;
  const chip = el.querySelector(".chip");
  chip.className = `chip ${state}`;
  chip.textContent = LABEL[state];
  if (last) el.querySelector(".sched").textContent = last;
  $("mUp").textContent = rowEls.filter((r) => r.querySelector(".dot").classList.contains("up")).length;
  $("mDown").textContent = rowEls.filter((r) => r.querySelector(".dot").classList.contains("down")).length;
}
rows.forEach((r, i) => paint(i, r.state));

function toast(title, body, ok) {
  $("mtTitle").textContent = title;
  $("mtBody").textContent = body;
  $("mockToast").classList.toggle("ok", ok);
  $("mockToast").classList.add("show");
  setTimeout(() => $("mockToast").classList.remove("show"), 2800);
}

if (!reduced) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async function loop() {
    for (;;) {
      await sleep(2600);
      paint(2, "late", "no ping for 6 min · late");
      await sleep(2200);
      paint(2, "down", "no ping for 15 min");
      rowEls[2].classList.add("flash");
      toast("billing-worker is DOWN", "No ping for 15 min · sent to #ops on Discord", false);
      await sleep(3800);
      rowEls[2].classList.remove("flash");
      paint(2, "up", "every 5 min · grace 10 min");
      toast("billing-worker is back UP", "Recovered after 17 min", true);
      await sleep(3200);
    }
  })();
}

// ---- live stats ----
async function stats() {
  try {
    const d = await (await fetch("/api/stats")).json();
    document.querySelectorAll("[data-stat]").forEach((el) => {
      const v = d[el.dataset.stat];
      if (typeof v === "number") el.textContent = v.toLocaleString("en-US");
    });
  } catch {}
}
stats();
setInterval(stats, 60_000);

// ---- integration snippets ----
const U = "https://lastping.a2a-cloud.workers.dev/ping/<check-id>";
const SNIPS = {
  crontab: `# run every 15 minutes, report success or the exit code\n*/15 * * * *  /opt/jobs/sync.sh; curl -fsS -m 10 --retry 3 ${U}/$?`,
  "GitHub Actions": `- name: Report to Lastping\n  if: always()\n  run: curl -fsS -m 10 ${U}/\${{ job.status == 'success' && '0' || '1' }}`,
  Python: `import urllib.request\n\ndef main():\n    ...  # your job\n\nmain()\nurllib.request.urlopen("${U}", timeout=10)`,
  "Node.js": `await runJob();\nawait fetch("${U}", { signal: AbortSignal.timeout(10_000) });`,
  Kubernetes: `containers:\n  - name: report\n    image: curlimages/curl\n    args: ["-fsS", "-m", "10", "${U}"]`,
  "With timing": `curl -fsS ${U}/start\n./job.sh && curl -fsS ${U} \\\n  || curl -fsS --data-raw "$(tail -c 900 job.log)" ${U}/fail`,
};
const tabs = $("docTabs");
function showSnip(name) {
  tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.textContent === name)));
  $("docCode").textContent = SNIPS[name];
}
for (const name of Object.keys(SNIPS)) {
  const b = document.createElement("button");
  b.type = "button";
  b.role = "tab";
  b.textContent = name;
  b.addEventListener("click", () => showSnip(name));
  tabs.append(b);
}
showSnip("crontab");
$("docCopy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("docCode").textContent);
    $("docCopy").textContent = "Copied";
  } catch {
    $("docCopy").textContent = "Select to copy";
  }
  setTimeout(() => ($("docCopy").textContent = "Copy"), 1400);
});
