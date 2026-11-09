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
