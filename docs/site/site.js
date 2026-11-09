// Copy buttons and animated FAQ. The page is fully readable without this file.
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

  // Hero video: only mounted when the figure says data-video="on" (files exist). Muted by default,
  // autoplay only without reduced motion, visible play/pause (WCAG 2.2.2) and unmute controls.
  const fig = document.querySelector(".shot");
  const tpl = document.getElementById("hero-video");
  if (fig && tpl && fig.dataset.video === "on") {
    const box = fig.querySelector(".shot-box");
    box.replaceChildren(tpl.content.cloneNode(true));
    fig.classList.add("has-video");
    const v = box.querySelector("video");
    const play = box.querySelector('[data-act="play"]');
    const sound = box.querySelector('[data-act="sound"]');
    const icon = (btn, id) => btn.querySelector("use").setAttribute("href", id);
    const sync = () => {
      const on = !v.paused;
      icon(play, on ? "#i-pause" : "#i-play");
      play.setAttribute("aria-label", on ? "Pause video" : "Play video");
      icon(sound, v.muted ? "#i-muted" : "#i-sound");
      sound.setAttribute("aria-pressed", String(!v.muted));
      sound.setAttribute("aria-label", v.muted ? "Unmute" : "Mute");
      sound.querySelector("span").textContent = v.muted ? "Unmute" : "Mute";
    };
    v.addEventListener("play", sync); v.addEventListener("pause", sync); v.addEventListener("volumechange", sync);
    play.addEventListener("click", () => { v.paused ? v.play().catch(() => {}) : v.pause(); });
    sound.addEventListener("click", () => { v.muted = !v.muted; if (!v.muted && v.paused) v.play().catch(() => {}); });
    if (!reduce.matches) v.play().catch(() => {});
    sync();
  }

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
