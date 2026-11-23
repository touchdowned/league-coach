import { useEffect, useRef } from "react";
import { add, ARENA, HITBOX, missileTip, mul, Shot, timeToReach, Vec } from "../../../core/mechanics/sim";

/** Colors read from the app's CSS tokens so the arena matches the theme. */
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f;
  return {
    bg: v("--bg-2", "#0d0f15"),
    grid: "rgba(255,255,255,0.035)",
    you: v("--cyan", "#5cc8ff"),
    enemy: v("--bad", "#ff6b6b"),
    accent: v("--accent", "#f0b54a"),
    good: v("--good", "#3ddc97"),
    text: v("--text-2", "#b4bac7"),
    muted: v("--muted", "#7b8394"),
  };
}
export type Palette = ReturnType<typeof palette>;

/**
 * Runs a fixed-rate simulation on a canvas sized to its container, with mouse
 * position in arena units. `tick` advances the world; `draw` paints it.
 */
export function useArena(opts: {
  canvas: React.RefObject<HTMLCanvasElement | null>;
  running: boolean;
  tick: (dt: number) => void;
  draw: (ctx: CanvasRenderingContext2D, pal: Palette) => void;
}) {
  const mouse = useRef<Vec>({ x: ARENA.w / 2, y: ARENA.h / 2 });
  const fns = useRef(opts);
  fns.current = opts;

  useEffect(() => {
    const c = opts.canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const pal = palette();
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const STEP = 1 / 120;

    const resize = () => {
      const w = c.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(w * dpr);
      c.height = Math.round(((w * ARENA.h) / ARENA.w) * dpr);
      c.style.height = `${(w * ARENA.h) / ARENA.w}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(c);

    const onMove = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      mouse.current = { x: ((e.clientX - r.left) / r.width) * ARENA.w, y: ((e.clientY - r.top) / r.height) * ARENA.h };
    };
    window.addEventListener("mousemove", onMove);

    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (fns.current.running) {
        acc += dt;
        while (acc >= STEP) {
          fns.current.tick(STEP);
          acc -= STEP;
        }
      } else acc = 0;
      const k = c.width / ARENA.w;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      paintFloor(ctx, pal);
      fns.current.draw(ctx, pal);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
    };
  }, [opts.canvas]);

  return mouse;
}

/** Converts a mouse event on the canvas to arena units. */
export function toArena(e: { clientX: number; clientY: number }, c: HTMLCanvasElement): Vec {
  const r = c.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * ARENA.w, y: ((e.clientY - r.top) / r.height) * ARENA.h };
}

function paintFloor(ctx: CanvasRenderingContext2D, pal: Palette) {
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, ARENA.w, ARENA.h);
  ctx.strokeStyle = pal.grid;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 100; x < ARENA.w; x += 100) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ARENA.h);
  }
  for (let y = 100; y < ARENA.h; y += 100) {
    ctx.moveTo(0, y);
    ctx.lineTo(ARENA.w, y);
  }
  ctx.stroke();
}

export function drawUnit(ctx: CanvasRenderingContext2D, p: Vec, color: string, label: string, facing?: Vec) {
  ctx.save();
  ctx.fillStyle = color + "26";
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, HITBOX, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (facing && (facing.x || facing.y)) {
    const tip = add(p, mul(facing, HITBOX + 22));
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.font = "600 34px Inter Variable, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, p.x, p.y + 1);
  ctx.restore();
}

export function drawRange(ctx: CanvasRenderingContext2D, p: Vec, r: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color + "40";
  ctx.setLineDash([18, 14]);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Paints a spell: the telegraph during its cast time (when `telegraph`), then the missile or landing zone. */
export function drawShot(ctx: CanvasRenderingContext2D, s: Shot, color: string, telegraph: boolean) {
  const a = s.ability;
  ctx.save();
  if (a.shape === "circle") {
    const land = timeToReach(a, Math.hypot(s.target.x - s.origin.x, s.target.y - s.origin.y));
    const k = Math.min(1, s.age / Math.max(land, 0.01));
    if (telegraph || s.owner === "you") {
      ctx.strokeStyle = color + "80";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(s.target.x, s.target.y, a.width, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = color + "40";
    ctx.beginPath();
    ctx.arc(s.target.x, s.target.y, a.width * k, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const end = add(s.origin, mul(s.dir, a.range));
    if (telegraph && s.age < a.delay + 0.05) {
      ctx.strokeStyle = color + "30";
      ctx.lineWidth = a.width;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(s.origin.x, s.origin.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    const tip = missileTip(s);
    if (tip) {
      if (a.speed > 0) {
        const tail = add(tip, mul(s.dir, -Math.min(140, s.travelled)));
        const g = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
        g.addColorStop(0, color + "00");
        g.addColorStop(1, color);
        ctx.strokeStyle = g;
        ctx.lineWidth = a.width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tail.x, tail.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      } else {
        ctx.strokeStyle = color + "a0";
        ctx.lineWidth = a.width;
        ctx.beginPath();
        ctx.moveTo(s.origin.x, s.origin.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
    } else if (!telegraph) {
      // Wind-up: a pulse on the caster so you can read the cast without an indicator.
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(s.origin.x, s.origin.y, HITBOX + 12 + 30 * (s.age / Math.max(a.delay, 0.01)), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawGhost(ctx: CanvasRenderingContext2D, from: Vec, to: Vec, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.setLineDash([16, 12]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(to.x, to.y, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}
