// Landing page motion. Runs only when html.motion is set (JS on, reduced motion off).
const root = document.documentElement;
if (root.classList.contains("motion")) init();

function init() {
  splitHeadline();
  heartbeat();
  frameTilt();
  navDepth();
  reveals();
  scenes();
  finalEkg();
}

// ---- hero headline: one masked span per word, staggered by --i ----
function splitHeadline() {
  const h1 = document.querySelector(".hero h1");
  const words = h1.textContent.trim().split(/\s+/);
  h1.setAttribute("aria-label", h1.textContent.trim());
  h1.replaceChildren(...words.flatMap((w, i) => {
    const outer = document.createElement("span");
    outer.className = "w";
    outer.setAttribute("aria-hidden", "true");
    const inner = document.createElement("span");
    inner.className = "wi";
    inner.style.setProperty("--i", i);
    inner.textContent = w;
    outer.append(inner);
    return i < words.length - 1 ? [outer, " "] : [outer];
  }));
}

// ---- heartbeat: a scrolling ECG line that misses one beat per cycle ----
function heartbeat() {
  const wrap = document.querySelector(".signal");
  const svg = wrap.querySelector(".signal-svg");
  const track = wrap.querySelector(".signal-track");
  const path = wrap.querySelector(".signal-path");
  const head = wrap.querySelector(".signal-head");
  const P = 96;                 // px per beat
  const N = 14;                 // beats per cycle (wider than the screen, so one gap is visible at a time)
  const MISSED = 9;             // the beat that never arrives
  const PEAK = 56;              // x of the R-peak inside a beat
  const W = P * N;
  const SPEED = 84;             // px per second (constant motion, so linear)
  const beat = "h30 l5 -6 l5 6 h8 l3 4 l5 -30 l5 40 l4 -14 h31";
  const flat = `h${P}`;

  let width = 0;
  function build() {
    width = wrap.clientWidth;
    const h = wrap.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${width} ${h}`);
    const cycles = Math.ceil(width / W) + 2;
    let d = `M0 ${h / 2}`;
    for (let c = 0; c < cycles; c++) for (let b = 0; b < N; b++) d += " " + (b === MISSED ? flat : beat);
    path.setAttribute("d", d);
  }
  build();
  addEventListener("resize", build);

  let offset = 0;
  let last = performance.now();
  let lastBeat = -1;
  let running = true;
  let labelTimer;
  const flash = (cls, ms) => {
    clearTimeout(labelTimer);
    wrap.classList.remove("ok", "missed");
    wrap.classList.add(cls);
    labelTimer = setTimeout(() => wrap.classList.remove(cls), ms);
  };

  function frame(now) {
    if (!running) return;
    const dt = Math.min(64, now - last);
    last = now;
    offset = (offset + (SPEED * dt) / 1000) % W;
    track.setAttribute("transform", `translate(${-offset} 0)`);

    // Which beat is passing under the dot at the right edge?
    const x = (offset + width) % W;
    const idx = Math.floor(x / P) % N;
    const local = x % P;
    if (local >= PEAK && lastBeat !== idx) {
      lastBeat = idx;
      if (idx === MISSED) {
        head.classList.remove("ping");
        head.classList.add("miss");
        flash("missed", 1700);
        setTimeout(() => head.classList.remove("miss"), 1700);
      } else {
        head.classList.remove("ping");
        void head.offsetWidth; // restart the ring animation
        head.classList.add("ping");
        if (idx === (MISSED + 1) % N) flash("ok", 1200);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Pause when off-screen or in a background tab.
  const resume = () => { if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); } };
  new IntersectionObserver(([e]) => (e.isIntersecting ? resume() : (running = false))).observe(wrap);
  document.addEventListener("visibilitychange", () => (document.hidden ? (running = false) : resume()));
}

// ---- product frame: tilted back, flattens as it scrolls into view ----
function frameTilt() {
  const stage = document.querySelector(".frame-stage");
  const frame = stage.querySelector(".frame");
  let ticking = false;
  function update() {
    ticking = false;
    const r = stage.getBoundingClientRect();
    const vh = innerHeight;
    if (r.bottom < 0 || r.top > vh) return;
    const raw = Math.min(1, Math.max(0, 1 - (r.top - vh * 0.12) / (vh * 0.7)));
    const p = 1 - (1 - raw) * (1 - raw); // ease-out on the scroll mapping
    frame.style.transform = `rotateX(${(1 - p) * 14}deg) scale(${0.93 + 0.07 * p})`;
  }
  addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update);
  update();
}

function navDepth() {
  const nav = document.getElementById("nav");
  const set = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", set, { passive: true });
  set();
}

// ---- scroll reveals with per-group stagger ----
function reveals() {
  const groups = [
    [".section-head"], [".feature-copy"], [".feature-visual"], [".steps > .step"], [".plans > .plan"],
    [".faq-grid > div:first-child"], [".faq-list details"], [".docs-grid > *"], [".works .eyebrow", ".works-grid"],
    [".final h2", ".final .btn"], [".footer-row > *"],
  ];
  for (const sels of groups) {
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        el.dataset.reveal = "";
        const siblings = [...el.parentElement.children].filter((c) => c.matches(sel));
        el.style.setProperty("--d", Math.max(0, siblings.indexOf(el)));
      });
    }
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.12 });
  document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
}

// ---- feature visuals: each plays a short scene once ----
function scenes() {
  // crontab card: wrap each line so it can type in
  const pre = document.querySelector(".code-card pre");
  if (pre) {
    const lines = pre.innerHTML.split("\n");
    pre.innerHTML = lines.map((l, i) => `<span class="ln" style="--i:${i}">${l}</span>`).join("\n");
  }
  document.querySelectorAll(".probe-card .probe").forEach((el, i) => el.style.setProperty("--i", i));
  document.querySelectorAll(".status-card .bars").forEach((b) => [...b.children].forEach((el, i) => el.style.setProperty("--i", i)));

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("play"); io.unobserve(e.target); }
  }, { threshold: 0.45 });
  document.querySelectorAll(".code-card, .probe-card, .alert-card, .status-card, .final").forEach((el) => io.observe(el));
}

// ---- faint ECG that draws across the final call to action ----
function finalEkg() {
  const final = document.querySelector(".final");
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "final-ekg");
  svg.setAttribute("viewBox", "0 0 1200 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  let d = "M0 30";
  for (let i = 0; i < 13; i++) d += i === 8 ? " h100" : " h40 l4 -5 l4 5 h6 l3 3 l4 -22 l4 30 l3 -11 h32";
  path.setAttribute("d", d);
  path.setAttribute("pathLength", "1");
  svg.append(path);
  final.prepend(svg);
}
