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

/**
 * The empty map from two sets of frames: `early` (before minions spawn) everywhere, except
 * inside the fountains, where champions sit at the start, so there it takes the median of
 * `later` frames instead (no minion ever enters a fountain).
 */
export function backgroundFrame(early: Frame[], later: Frame[]): Frame {
  const bg = medianFrame(early);
  if (!later.length) return bg;
  const late = medianFrame(later);
  const m = new Uint8Array(bg.w * bg.h);
  for (const f of FOUNTAINS) {
    const c = gameToPixel(f.x, f.y, bg.w);
    markDisc(m, bg.w, bg.h, c.px, c.py, (f.r / (RIFT.maxX - RIFT.minX)) * bg.w);
  }
  for (let p = 0; p < m.length; p++) if (m[p]) for (let k = 0; k < 4; k++) bg.data[p * 4 + k] = late.data[p * 4 + k];
  return bg;
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
  /** Champion rings: anything inside one is part of the icon, not a minion. */
  exclude?: { cx: number; cy: number; r: number }[];
}

/** Fountains, where champion icons sit and no minion ever is (game units). */
export const FOUNTAINS = [
  { x: 400, y: 420, r: 1500 },
  { x: 14340, y: 14390, r: 1500 },
];

/** Minion dots in a cropped minimap frame, given the empty map behind it. */
export function detectDots(frame: Frame, bg: Frame, o: DotOpts = {}): Dot[] {
  const { w, h, data } = frame;
  const diff = o.diff ?? 70;
  const minA = Math.max(2, Math.round(((o.minD ?? 0.008) * w) ** 2 * 0.6));
  const maxD = (o.maxD ?? 0.032) * w;
  const maxA = Math.round(maxD ** 2);
  const label = new Uint8Array(w * h);
  const masked = new Uint8Array(w * h);
  for (const f of FOUNTAINS) {
    const c = gameToPixel(f.x, f.y, w);
    const r = (f.r / (RIFT.maxX - RIFT.minX)) * w;
    markDisc(masked, w, h, c.px, c.py, r);
  }
  for (const e of o.exclude ?? []) markDisc(masked, w, h, e.cx, e.cy, e.r + 2);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (masked[p]) continue;
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
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw > maxD || bh > maxD) continue; // a ring or bar, not a dot
    // Minion dots are filled; a thin arc (a ring edge, an ability circle) is not.
    if (bw * bh >= 9 && area / (bw * bh) < 0.45) continue;
    const g = pixelToGame(sx / area + 0.5, sy / area + 0.5, w);
    dots.push({ team: l === 1 ? 100 : 200, x: Math.round(g.x), y: Math.round(g.y), area });
  }
  return dots;
}

function markDisc(m: Uint8Array, w: number, h: number, cx: number, cy: number, r: number) {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
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

/** A champion icon's ring on the minimap, in minimap pixels. */
export interface Ring {
  team: 100 | 200;
  cx: number;
  cy: number;
  r: number;
  /** Share of the ring's circumference that shows (1 = whole ring; lower when another icon covers it). */
  cover: number;
}

/** Team-coloured pixels: 1 blue, 2 red. With a background, only pixels that aren't part of the empty map. */
function teamLabels(frame: Frame, bg?: Frame, minDiff = 60): Uint8Array {
  const { w, h, data } = frame;
  const label = new Uint8Array(w * h);
  const useBg = !!bg && bg.w === w && bg.h === h;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    // Bright blue river edges and blue structures are on the empty map too: not icons.
    if (useBg && diffAt(data, bg!.data, i) < minDiff) continue;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) label[p] = t === 100 ? 1 : 2;
  }
  return label;
}

interface Blob {
  l: number;
  px: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function blobs(label: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (!label[p] || seen[p]) continue;
    const b: Blob = { l: label[p], px: [], minX: w, maxX: 0, minY: h, maxY: 0 };
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w;
      const y = (q - x) / w;
      b.px.push(q);
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
      for (const k of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1])
        if (k >= 0 && !seen[k] && label[k] === b.l) {
          seen[k] = 1;
          stack.push(k);
        }
    }
    out.push(b);
  }
  return out;
}

/** How much of a circle of radius r at (cx, cy) the pixels trace, in 24 sectors. */
function coverage(px: number[], w: number, cx: number, cy: number, r: number, tol = 2.2): { cover: number; on: number[] } {
  const sectors = new Uint8Array(24);
  const on: number[] = [];
  for (const q of px) {
    const x = q % w;
    const y = (q - x) / w;
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - r) > tol) continue;
    on.push(q);
    const a = Math.atan2(y - cy, x - cx);
    sectors[Math.min(23, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 24))] = 1;
  }
  return { cover: sectors.reduce((s, x) => s + x, 0) / 24, on };
}

/**
 * Circles of radius r traced by a blob's pixels, strongest first. Used where icons overlap:
 * two rings that touch are one blob, and a ring under another icon is only an arc.
 */
function houghRings(b: Blob, w: number, r: number, minCover: number): { cx: number; cy: number; cover: number }[] {
  const pad = Math.ceil(r) + 2;
  const ox = b.minX - pad;
  const oy = b.minY - pad;
  const aw = b.maxX - b.minX + 1 + pad * 2;
  const ah = b.maxY - b.minY + 1 + pad * 2;
  const steps = Math.max(24, Math.round(2 * Math.PI * r));
  const cos = Array.from({ length: steps }, (_, k) => Math.cos((k / steps) * 2 * Math.PI) * r);
  const sin = Array.from({ length: steps }, (_, k) => Math.sin((k / steps) * 2 * Math.PI) * r);
  let left = b.px;
  const found: { cx: number; cy: number; cover: number }[] = [];
  for (let iter = 0; iter < 6 && left.length > r * 2; iter++) {
    const acc = new Float32Array(aw * ah);
    for (const q of left) {
      const x = q % w;
      const y = (q - x) / w;
      let prev = -1;
      for (let k = 0; k < steps; k++) {
        const ax = Math.round(x - cos[k]) - ox;
        const ay = Math.round(y - sin[k]) - oy;
        if (ax < 0 || ay < 0 || ax >= aw || ay >= ah) continue;
        const c = ay * aw + ax;
        if (c !== prev) acc[c]++;
        prev = c;
      }
    }
    // 3x3 sum, so a centre between pixels still peaks.
    let best = -1;
    let bestV = 0;
    for (let y = 1; y < ah - 1; y++)
      for (let x = 1; x < aw - 1; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += acc[(y + dy) * aw + x + dx];
        if (v > bestV) {
          bestV = v;
          best = y * aw + x;
        }
      }
    if (best < 0) break;
    // Refine to the vote-weighted centre of the 3x3 peak.
    const bx = best % aw;
    const by = (best - bx) / aw;
    let sx = 0;
    let sy = 0;
    let sv = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const v = acc[(by + dy) * aw + bx + dx];
        sx += (bx + dx) * v;
        sy += (by + dy) * v;
        sv += v;
      }
    const cx = sx / sv + ox;
    const cy = sy / sv + oy;
    const { cover, on } = coverage(left, w, cx, cy, r);
    // Enough of the ring, and enough pixels on it (portrait art scattered around a centre isn't a ring).
    if (cover < minCover || on.length < 2 * Math.PI * r * cover * 0.8) break;
    // Leftovers of a ring already found: the same circle, slightly off.
    if (found.some((f) => Math.hypot(f.cx - cx, f.cy - cy) < r * 0.75)) break;
    found.push({ cx, cy, cover });
    const used = new Set(on);
    left = left.filter((q) => !used.has(q));
  }
  return found;
}

/**
 * Champion icon rings on a cropped minimap. Clean rings come straight from blob shape;
 * blobs that are several touching rings, or a ring partly under another icon, are split
 * with a circle search at the ring size the clean ones show.
 */
export function findRings(frame: Frame, bg?: Frame): Ring[] {
  const { w, h } = frame;
  const all = blobs(teamLabels(frame, bg), w, h);
  const minD = w * 0.045;
  const maxD = w * 0.13;
  const rings: Ring[] = [];
  const rest: Blob[] = [];
  for (const b of all) {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    const clean = bw >= minD && bh >= minD && bw <= maxD && bh <= maxD && bw / bh <= 1.2 && bh / bw <= 1.2 && b.px.length / (bw * bh) <= 0.6;
    if (clean) {
      const cx = b.minX + bw / 2 - 0.5;
      const cy = b.minY + bh / 2 - 0.5;
      const r = Math.min(bw, bh) / 2;
      const { cover } = coverage(b.px, w, cx, cy, r - 1, 2.2);
      if (cover >= 0.75) {
        rings.push({ team: b.l === 1 ? 100 : 200, cx, cy, r, cover });
        continue;
      }
    }
    rest.push(b);
  }
  // Ring size on this minimap: from the clean rings, else the usual share of the width.
  const rs = rings.map((x) => x.r).sort((a, b) => a - b);
  const r0 = rs.length ? rs[Math.floor(rs.length / 2)] : w * 0.04;
  for (const b of rest) {
    const bw = b.maxX - b.minX + 1;
    const bh = b.maxY - b.minY + 1;
    // Too small to hold an arc of a ring, or too big to be a few icons.
    if (Math.max(bw, bh) < r0 * 1.1 || bw > r0 * 9 || bh > r0 * 9 || b.px.length < r0 * 2.5) continue;
    if (b.px.length / (bw * bh) > 0.6) continue; // filled: a structure, not icons
    for (const c of houghRings(b, w, r0 - 1, 0.42)) rings.push({ team: b.l === 1 ? 100 : 200, cx: c.cx, cy: c.cy, r: r0, cover: c.cover });
  }
  return rings;
}

/**
 * Champion icons on a cropped minimap: team-coloured rings, identified by matching the
 * portrait inside against the ten champions in the game. Rings that match no one well
 * enough come back with id 0, so tracking can still name them.
 */
export function detectChampions(frame: Frame, refs: PortraitRef[], maxScore = 38, rings = findRings(frame)): (ChampDot & { team: 100 | 200 })[] {
  const w = frame.w;
  const pairs: { ring: number; ref: PortraitRef; score: number }[] = [];
  rings.forEach((ring, i) => {
    // A covered ring's portrait is partly someone else's: judge it more loosely.
    const g = portraitGrid(frame, ring.cx, ring.cy, ring.r);
    const slack = ring.cover < 0.9 ? 1 + (0.9 - ring.cover) : 1;
    for (const ref of refs) if (ref.team === ring.team) pairs.push({ ring: i, ref, score: gridDiff(g, ref.grid) / slack });
  });
  pairs.sort((a, b) => a.score - b.score);
  const usedRing = new Set<number>();
  const usedRef = new Set<number>();
  const out: (ChampDot & { team: 100 | 200 })[] = [];
  for (const p of pairs) {
    if (p.score > maxScore || usedRing.has(p.ring) || usedRef.has(p.ref.id)) continue;
    usedRing.add(p.ring);
    usedRef.add(p.ref.id);
    const ring = rings[p.ring];
    const g = pixelToGame(ring.cx + 0.5, ring.cy + 0.5, w);
    out.push({ id: p.ref.id, team: ring.team, x: Math.round(g.x), y: Math.round(g.y), score: Math.round(p.score) });
  }
  rings.forEach((ring, i) => {
    if (usedRing.has(i)) return;
    const g = pixelToGame(ring.cx + 0.5, ring.cy + 0.5, w);
    out.push({ id: 0, team: ring.team, x: Math.round(g.x), y: Math.round(g.y), score: 999 });
  });
  return out;
}
