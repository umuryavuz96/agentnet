// Copy buttons, scroll steps and animated FAQ. The page is fully readable without this file.
(() => {
  const live = document.getElementById("live");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");

  // Copy buttons stay hidden without JS or without clipboard access.
  if (navigator.clipboard) {
    for (const btn of document.querySelectorAll(".copy")) {
      btn.hidden = false;
      const label = btn.querySelector("span");
      btn.addEventListener("click", async () => {
        const text = btn.parentElement.querySelector("code").textContent;
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add("done");
          label.textContent = "Copied";
          live.textContent = "Commands copied";
          setTimeout(() => { btn.classList.remove("done"); label.textContent = "Copy"; }, 1600);
        } catch { live.textContent = "Copy failed. Select the text instead."; }
      });
    }
  }

  // Scroll steps: the section most in view plays its loop, the rest pause. Reduced motion shows posters only.
  const root = document.documentElement;
  root.classList.add("js");
  const steps = [...document.querySelectorAll(".step")];
  const secs = [document.querySelector(".hero"), ...steps].filter(Boolean);
  const ol = document.querySelector(".rail ol"), prog = document.querySelector(".prog");
  steps.forEach((s) => {
    ol.insertAdjacentHTML("beforeend", `<li><a href="#${s.id}">${s.dataset.name}</a></li>`);
    prog.insertAdjacentHTML("beforeend", "<i></i>");
  });
  const links = [...ol.querySelectorAll("a")], segs = [...prog.children];
  let userPaused = reduce.matches;   // a pause by the reader sticks; reduced motion starts paused
  let current = null;
  const medias = [...document.querySelectorAll(".media")];
  // A decode or load error: retry once with the mp4 first, then give up and keep the poster with a play button.
  const fail = (m, v) => {
    m.classList.remove("playing", "on");
    if (v.dataset.retry) { v.dataset.failed = "1"; return; }
    v.dataset.retry = "1";
    for (const s of [...v.querySelectorAll("source")].filter((s) => s.type === "video/mp4").reverse()) v.prepend(s);
    v.load();
    if (m === current && !userPaused) v.play().catch(() => {});
  };
  for (const m of medias) {
    const v = m.querySelector("video"), pp = m.querySelector(".pp");
    v.addEventListener("playing", () => { m.classList.add("on", "playing"); pp.setAttribute("aria-label", "Pause"); });
    v.addEventListener("pause", () => { m.classList.remove("playing"); pp.setAttribute("aria-label", "Play"); });
    v.addEventListener("error", () => fail(m, v));
    v.querySelector("source:last-of-type").addEventListener("error", () => fail(m, v));
    pp.hidden = false;
    pp.addEventListener("click", () => { userPaused = !v.paused; if (userPaused) v.pause(); else { delete v.dataset.failed; v.play().catch(() => {}); } });
  }
  // The first loop starts after the page has loaded and settled, so the poster paints first and nothing competes with it.
  let ready = false;
  // Starting a decode is heavy on slow phones, so the loop starts on the first touch, key or scroll, or after 5 s.
  const go = () => { if (ready) return; ready = true; sync(); };
  const start = () => { const t = setTimeout(go, 5000); for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"]) addEventListener(ev, () => { clearTimeout(t); go(); }, { once: true, passive: true }); };
  if (document.readyState === "complete") start(); else addEventListener("load", start, { once: true });
  function sync() {
    if (!ready) return;
    for (const m of medias) {
      const v = m.querySelector("video");
      if (m === current && !userPaused) { if (!v.dataset.failed && v.paused) v.play().catch(() => {}); } else if (!v.paused) v.pause();
    }
  }
  const ratio = new Map();
  const io = new IntersectionObserver((es) => {
    for (const e of es) { ratio.set(e.target, e.isIntersecting ? e.intersectionRatio : 0); if (e.intersectionRatio >= 0.35) e.target.classList.add("in"); }
    let best = null, top = 0.35;
    for (const s of secs) { const r = ratio.get(s) || 0; if (r > top) { top = r; best = s; } }
    current = best ? best.querySelector(".media") : null;
    const i = steps.indexOf(best);
    links.forEach((a, n) => (n === i ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    if (i >= 0) ol.style.setProperty("--i", i);
    segs.forEach((g, n) => g.classList.toggle("cur", n === i));
    prog.classList.toggle("on", i >= 0);
    sync();
  }, { threshold: [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1] });
  secs.forEach((s) => io.observe(s));
  reduce.addEventListener("change", () => { userPaused = reduce.matches; sync(); });

  // FAQ: animate the answer's height and opacity on open and close.
  for (const d of document.querySelectorAll(".faq details")) {
    const summary = d.querySelector("summary");
    const ans = d.querySelector(".ans");
    let anim = null;
    summary.addEventListener("click", (e) => {
      if (reduce.matches || !ans.animate) return;
      e.preventDefault();
      if (anim) anim.cancel();
      const opening = !d.open;
      if (opening) d.open = true;
      const h = ans.scrollHeight;
      anim = ans.animate(
        opening
          ? [{ height: "0px", opacity: 0 }, { height: h + "px", opacity: 1 }]
          : [{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }],
        { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
      anim.onfinish = () => { anim = null; if (!opening) d.open = false; };
      anim.oncancel = () => { anim = null; };
    });
  }
})();

// Glass lens (Chromium only). Safari and Firefox cannot use an SVG filter as backdrop-filter,
// so they keep the plain CSS frost. Skipped under reduced transparency.
(() => {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  if (!brands.some((b) => b.brand === "Chromium") || matchMedia("(prefers-reduced-transparency: reduce)").matches) return;
  const N = 128, STRENGTH = 16, BAND = 0.22;
  const c = document.createElement("canvas"); c.width = c.height = N;
  const ctx = c.getContext("2d"), img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = (x + .5) / N - .5, py = (y + .5) / N - .5, r = Math.hypot(px, py);
    const d = Math.max(0, (r - (.5 - BAND)) / BAND); // 0 in the middle, 1 at the rim
    const k = Math.min(1, d) ** 2.2, i = (y * N + x) * 4;
    // Pull toward the centre at the rim: the lens shows content from further in.
    img.data[i] = 128 - (px / (r || 1)) * k * 127; img.data[i + 1] = 128 - (py / (r || 1)) * k * 127; img.data[i + 2] = 128; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
  s.setAttribute("width", 0); s.setAttribute("height", 0); s.setAttribute("aria-hidden", "true"); s.style.cssText = "position:absolute;pointer-events:none";
  s.innerHTML = `<defs><filter id="lg-lens" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feImage href="${c.toDataURL()}" preserveAspectRatio="none" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="${STRENGTH}" xChannelSelector="R" yChannelSelector="G"/></filter></defs>`;
  document.body.append(s);
  document.documentElement.classList.add("lg-refract");
})();
