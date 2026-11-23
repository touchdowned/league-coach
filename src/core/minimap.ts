/**
 * Reads minions off League's minimap, from screen captures of a replay.
 *
 * No game memory, no packet decoding: the app plays your own replay through the
 * official Replay API and looks at the pixels, the same thing a recording sees.
 *
 *  - findMinimap: diff a capture with the minimap shown against one with it hidden;
 *    the pixels that change are the minimap, on any resolution or minimap scale.
 *  - medianFrame: the empty map, from captures taken before minions spawn.
 *  - detectDots: small saturated blue/red blobs that aren't part of the empty map.
 *    Champion icons and structures are much bigger and are skipped by size.
 */
import { RIFT } from "./track";

/** RGBA pixels, row by row. */
export interface Frame {
  w: number;
  h: number;
  data: Uint8Array | Uint8ClampedArray;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Dot {
  team: 100 | 200;
  /** Game units. */
  x: number;
  y: number;
  area: number;
}

const diffAt = (a: Frame["data"], b: Frame["data"], i: number) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);

/** Locates the minimap from two full-screen captures of a paused replay: minimap on, minimap off. */
export function findMinimap(on: Frame, off: Frame, threshold = 45): Rect | null {
  if (on.w !== off.w || on.h !== off.h) return null;
  const { w, h } = on;
  // The minimap lives in the bottom-right quarter of the screen.
  const x0 = Math.floor(w / 2);
  const y0 = Math.floor(h / 2);
  const cols = new Array(w).fill(0);
  const rows = new Array(h).fill(0);
  for (let y = y0; y < h; y++)
    for (let x = x0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (diffAt(on.data, off.data, i) > threshold) {
        cols[x]++;
        rows[y]++;
      }
    }
  // Keep columns/rows where a solid run of pixels changed, so stray noise doesn't stretch the box.
  const minRun = Math.max(8, Math.round(h * 0.04));
  const xs = cols.map((n, x) => (n >= minRun ? x : -1)).filter((x) => x >= 0);
  const ys = rows.map((n, y) => (n >= minRun ? y : -1)).filter((y) => y >= 0);
  if (!xs.length || !ys.length) return null;
  const bx = xs[0];
  const by = ys[0];
  const bw = xs[xs.length - 1] - bx + 1;
  const bh = ys[ys.length - 1] - by + 1;
  const side = Math.min(bw, bh);
  if (side < 80) return null;
  // The map itself is a square tucked into the bottom-right of the frame; trim the border.
  const inset = Math.round(side * 0.015);
  return { x: bx + bw - side + inset, y: by + bh - side + inset, w: side - inset * 2, h: side - inset * 2 };
}

export function crop(f: Frame, r: Rect): Frame {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * f.w + r.x) * 4;
    out.set(f.data.subarray(src, src + r.w * 4), y * r.w * 4);
  }
  return { w: r.w, h: r.h, data: out };
}

/** Per-pixel median: moving icons vanish and the empty map stays. */
export function medianFrame(frames: Frame[]): Frame {
  const { w, h } = frames[0];
  const out = new Uint8ClampedArray(w * h * 4);
  const vals = new Array<number>(frames.length);
  for (let i = 0; i < w * h * 4; i++) {
    if (i % 4 === 3) {
      out[i] = 255;
      continue;
    }
    for (let k = 0; k < frames.length; k++) vals[k] = frames[k].data[i];
    vals.sort((a, b) => a - b);
    out[i] = vals[vals.length >> 1];
  }
  return { w, h, data: out };
}

/** Which team's minion colour a pixel is, if any. Spectator view: blue side blue, red side red. */
export function teamColor(r: number, g: number, b: number): 0 | 100 | 200 {
  if (b >= 120 && b > r + 50 && b > g + 5) return 100;
  if (r >= 140 && r > g + 60 && r > b + 40) return 200;
  return 0;
}

export function pixelToGame(px: number, py: number, size: number): { x: number; y: number } {
  return {
    x: RIFT.minX + (px / size) * (RIFT.maxX - RIFT.minX),
    y: RIFT.maxY - (py / size) * (RIFT.maxY - RIFT.minY),
  };
}

export function gameToPixel(x: number, y: number, size: number): { px: number; py: number } {
  return { px: ((x - RIFT.minX) / (RIFT.maxX - RIFT.minX)) * size, py: ((RIFT.maxY - y) / (RIFT.maxY - RIFT.minY)) * size };
}

export interface DotOpts {
  /** How different from the empty map a pixel must be (sum of RGB differences). */
  diff?: number;
  /** Blob size limits as a fraction of the minimap's width (diameter). */
  minD?: number;
  maxD?: number;
}

/** Minion dots in a cropped minimap frame, given the empty map behind it. */
export function detectDots(frame: Frame, bg: Frame, o: DotOpts = {}): Dot[] {
  const { w, h, data } = frame;
  const diff = o.diff ?? 70;
  const minA = Math.max(2, Math.round(((o.minD ?? 0.008) * w) ** 2 * 0.6));
  const maxD = (o.maxD ?? 0.032) * w;
  const maxA = Math.round(maxD ** 2);
  const label = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (diffAt(data, bg.data, i) < diff) continue;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) label[p] = t === 100 ? 1 : 2;
  }
  const seen = new Uint8Array(w * h);
  const dots: Dot[] = [];
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (!label[p] || seen[p]) continue;
    const l = label[p];
    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w;
      const y = (q - x) / w;
      area++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const n = [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1];
      for (const k of n) if (k >= 0 && !seen[k] && label[k] === l) {
        seen[k] = 1;
        stack.push(k);
      }
    }
    if (area < minA || area > maxA) continue;
    if (maxX - minX + 1 > maxD || maxY - minY + 1 > maxD) continue; // a ring or bar, not a dot
    const g = pixelToGame(sx / area + 0.5, sy / area + 0.5, w);
    dots.push({ team: l === 1 ? 100 : 200, x: Math.round(g.x), y: Math.round(g.y), area });
  }
  return dots;
}

/** BGRA (what Electron's NativeImage.toBitmap gives on Windows) to RGBA, in place. */
export function bgraToRgba(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const b = data[i];
    data[i] = data[i + 2];
    data[i + 2] = b;
  }
}

// ---------- champions ----------

/** A champion portrait to match against, sampled to a small grid (see portraitGrid). */
export interface PortraitRef {
  id: number;
  team: 100 | 200;
  grid: number[];
}
export interface ChampDot {
  id: number;
  x: number;
  y: number;
  /** Mean colour difference to the matched portrait; lower is surer. */
  score: number;
}

const GRID = 8;

/** Average colours on an 8x8 grid inside a circle of radius r at (cx, cy). */
export function portraitGrid(f: Frame, cx: number, cy: number, r: number): number[] {
  const out: number[] = [];
  const step = (2 * r * 0.62) / GRID;
  const x0 = cx - r * 0.62;
  const y0 = cy - r * 0.62;
  for (let gy = 0; gy < GRID; gy++)
    for (let gx = 0; gx < GRID; gx++) {
      let rr = 0;
      let gg = 0;
      let bb = 0;
      let n = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const x = Math.round(x0 + (gx + (sx + 0.5) / 2) * step);
          const y = Math.round(y0 + (gy + (sy + 0.5) / 2) * step);
          if (x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
          const i = (y * f.w + x) * 4;
          rr += f.data[i];
          gg += f.data[i + 1];
          bb += f.data[i + 2];
          n++;
        }
      out.push(n ? rr / n : 0, n ? gg / n : 0, n ? bb / n : 0);
    }
  return out;
}

/** The grid for a square champion icon (e.g. Data Dragon's), as the minimap clips it to a circle. */
export function iconGrid(icon: Frame): number[] {
  return portraitGrid(icon, icon.w / 2, icon.h / 2, icon.w / 2);
}

function gridDiff(a: number[], b: number[]): number {
  // Compare shapes of colour, not brightness: fogged or dimmed portraits stay matchable.
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - ma - (b[i] - mb));
  return s / a.length;
}

/**
 * Champion icons on a cropped minimap: team-coloured rings, identified by matching the
 * portrait inside against the ten champions in the game.
 */
export function detectChampions(frame: Frame, refs: PortraitRef[], maxScore = 38): ChampDot[] {
  const { w, h, data } = frame;
  const label = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) label[p] = t === 100 ? 1 : 2;
  }
  const seen = new Uint8Array(w * h);
  const rings: { team: 100 | 200; cx: number; cy: number; r: number }[] = [];
  const stack: number[] = [];
  const minD = w * 0.045;
  const maxD = w * 0.13;
  for (let p = 0; p < w * h; p++) {
    if (!label[p] || seen[p]) continue;
    const l = label[p];
    let area = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w;
      const y = (q - x) / w;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const k of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1])
        if (k >= 0 && !seen[k] && label[k] === l) {
          seen[k] = 1;
          stack.push(k);
        }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < minD || bh < minD || bw > maxD || bh > maxD) continue;
    if (bw / bh > 1.35 || bh / bw > 1.35) continue;
    if (area / (bw * bh) > 0.6) continue; // a filled shape, not a ring
    rings.push({ team: l === 1 ? 100 : 200, cx: minX + bw / 2 - 0.5, cy: minY + bh / 2 - 0.5, r: Math.min(bw, bh) / 2 });
  }
  // Match each ring to the best unused champion of its team.
  const pairs: { ring: number; ref: PortraitRef; score: number }[] = [];
  rings.forEach((ring, i) => {
    const g = portraitGrid(frame, ring.cx, ring.cy, ring.r);
    for (const ref of refs) if (ref.team === ring.team) pairs.push({ ring: i, ref, score: gridDiff(g, ref.grid) });
  });
  pairs.sort((a, b) => a.score - b.score);
  const usedRing = new Set<number>();
  const usedRef = new Set<number>();
  const out: ChampDot[] = [];
  for (const p of pairs) {
    if (p.score > maxScore || usedRing.has(p.ring) || usedRef.has(p.ref.id)) continue;
    usedRing.add(p.ring);
    usedRef.add(p.ref.id);
    const ring = rings[p.ring];
    const g = pixelToGame(ring.cx + 0.5, ring.cy + 0.5, w);
    out.push({ id: p.ref.id, x: Math.round(g.x), y: Math.round(g.y), score: Math.round(p.score) });
  }
  return out;
}
