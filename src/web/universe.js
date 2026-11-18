// The universe behind Atlas (the noisysource.com look): faint stars, and
// photons drifting through them. Typing, they drift very slowly; while Atlas
// speaks they move faster; while he thinks they stream in and out of the star
// (the brain's core). Drawn on one fixed canvas behind the page.
//
// Cheap on purpose: a few hundred points, the device pixel ratio capped,
// nothing drawn while the tab is hidden, and a still sky for people who ask
// their system for less motion.

/** How fast the drifting photons go, by what Atlas is doing. */
export const PACE = { idle: 1, listening: 1.6, thinking: 2.2, speaking: 6 };

/**
 * The pace for a page state: speaking wins, then thinking, then listening.
 * @param {{ phase?: string }} s
 * @returns {number}
 */
export const paceOf = (s) => PACE[/** @type {keyof typeof PACE} */ (s.phase ?? "idle")] ?? PACE.idle;

/** A small seeded random, so the sky is the same on every load. @param {number} seed */
export const seeded = (seed) => {
  let s = seed % 2147483647 || 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
};

/**
 * The sky for a window: stars by area (capped), photons by area (capped).
 * @param {number} w @param {number} h @param {() => number} rand
 */
export const makeSky = (w, h, rand) => {
  const area = w * h;
  const stars = Array.from({ length: Math.min(320, Math.round(area / 6500)) }, () => ({
    x: rand() * w,
    y: rand() * h,
    r: 0.25 + rand() * rand() * 1.15,
    a: 0.15 + rand() * 0.55,
    tw: rand() * Math.PI * 2,
    sp: 0.4 + rand() * 1.4,
  }));
  const photons = Array.from({ length: Math.min(90, Math.round(area / 22000)) }, () => {
    const dir = rand() * Math.PI * 2;
    return { x: rand() * w, y: rand() * h, dx: Math.cos(dir), dy: Math.sin(dir), v: 2 + rand() * 6, r: 0.6 + rand() * 0.9 };
  });
  return { stars, photons };
};

/** A soft round glow, drawn once and stamped. @param {string} colour @param {number} size */
const glowSprite = (colour, size) => {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext("2d"));
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, colour);
  grad.addColorStop(0.25, colour.replace(/[\d.]+\)$/, "0.35)"));
  grad.addColorStop(1, colour.replace(/[\d.]+\)$/, "0)"));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
};

/**
 * Starts the universe on `canvas`. `state()` says what Atlas is doing now;
 * `star()` where the star is on screen, or undefined when it isn't shown.
 * @param {HTMLCanvasElement} canvas
 * @param {{ state: () => { phase?: string }, star: () => { x: number, y: number } | undefined }} deps
 */
export const startUniverse = (canvas, deps) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { stop: () => {} };
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const blue = glowSprite("rgba(74,123,255,1)", 32);
  const white = glowSprite("rgba(207,224,255,1)", 32);
  let w = 0;
  let h = 0;
  let sky = makeSky(1, 1, seeded(7));
  /** Photons streaming in and out of the star while he thinks. @type {{ x: number, y: number, tx: number, ty: number, t: number, life: number, out: boolean }[]} */
  let streams = [];
  let pace = PACE.idle;
  let last = performance.now();
  let frame = 0;
  let spawn = 0;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sky = makeSky(w, h, seeded(7));
    if (still) draw(0, 0);
  };

  /** @param {number} now @param {number} dt seconds */
  const draw = (now, dt) => {
    ctx.clearRect(0, 0, w, h);
    const t = now / 1000;
    for (const s of sky.stars) {
      const a = still ? s.a : s.a * (0.65 + 0.35 * Math.sin(t * s.sp + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = "#cfe0ff";
      ctx.fillRect(s.x, s.y, s.r * 1.6, s.r * 1.6);
    }
    for (const p of sky.photons) {
      p.x += p.dx * p.v * pace * dt;
      p.y += p.dy * p.v * pace * dt;
      if (p.x < -10) p.x = w + 10;
      else if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      else if (p.y > h + 10) p.y = -10;
      // A short trail when they're fast.
      if (pace > 2) {
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = "#4a7bff";
        ctx.lineWidth = p.r;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.dx * p.v * pace * 0.6, p.y - p.dy * p.v * pace * 0.6);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.55;
      const s = 6 + p.r * 6;
      ctx.drawImage(blue, p.x - s / 2, p.y - s / 2, s, s);
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#e6ecff";
      ctx.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
    }
    // Thinking: photons come in from around the star, and some go back out.
    const star = deps.star();
    if (star && deps.state().phase === "thinking") {
      spawn += dt * 38;
      while (spawn >= 1) {
        spawn -= 1;
        const a = Math.random() * Math.PI * 2;
        const d = 140 + Math.random() * 260;
        const out = Math.random() < 0.4;
        const far = { x: star.x + Math.cos(a) * d, y: star.y + Math.sin(a) * d };
        streams.push(out ? { x: star.x, y: star.y, tx: far.x, ty: far.y, t: 0, life: 1.1 + Math.random() * 0.8, out } : { ...far, tx: star.x, ty: star.y, t: 0, life: 0.9 + Math.random() * 0.8, out });
      }
    }
    if (streams.length > 0) {
      streams = streams.filter((s) => (s.t += dt) < s.life);
      for (const s of streams) {
        const k = s.t / s.life;
        const e = s.out ? 1 - (1 - k) ** 3 : k * k * k;
        const x = s.x + (s.tx - s.x) * e;
        const y = s.y + (s.ty - s.y) * e;
        ctx.globalAlpha = s.out ? 1 - k : Math.min(1, k * 2.5) * (1 - k * 0.3);
        ctx.drawImage(white, x - 5, y - 5, 10, 10);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
      }
    }
    ctx.globalAlpha = 1;
  };

  const tick = (/** @type {number} */ now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // Ease into the new pace, so speeding up and slowing down feel natural.
    pace += (paceOf(deps.state()) - pace) * Math.min(1, dt * 1.8);
    draw(now, dt);
    frame = requestAnimationFrame(tick);
  };

  const onVisibility = () => {
    cancelAnimationFrame(frame);
    if (!document.hidden && !still) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };

  resize();
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);
  if (!still) frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
};
