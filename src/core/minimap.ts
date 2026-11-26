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
  /** Minions in this blob: touching minions merge into one blob, counted by area. */
  n?: number;
  /** Ward icons only: which icon it matched (see findWardIcons). */
  kind?: WardKind;
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
    markDisc(m, bg.w, bg.h, c.px, c.py, (f.r / (E.maxX - E.minX)) * bg.w);
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

/**
 * The game area the minimap crop shows. Fitted on a real replay from two independent
 * measurements that agree: kill positions vs champion reads (best fit 0.955 scale about
 * the centre, +20 units) and turret icons vs their game positions (4.5% out). Using the
 * whole RIFT bounds instead put every read ~4.5% too far from the centre (kill check
 * median 372 units before, ~100 after).
 */
export const MINIMAP_EXTENT = { minX: 237, maxX: 14553, minY: 240, maxY: 14660 };
const E = MINIMAP_EXTENT;

export function pixelToGame(px: number, py: number, size: number): { x: number; y: number } {
  return {
    x: E.minX + (px / size) * (E.maxX - E.minX),
    y: E.maxY - (py / size) * (E.maxY - E.minY),
  };
}

export function gameToPixel(x: number, y: number, size: number): { px: number; py: number } {
  return { px: ((x - E.minX) / (E.maxX - E.minX)) * size, py: ((E.maxY - y) / (E.maxY - E.minY)) * size };
}

export interface DotOpts {
  /** How different from the empty map a pixel must be (sum of RGB differences). */
  diff?: number;
  /** Blob size limits as a fraction of the minimap's width (diameter). */
  minD?: number;
  maxD?: number;
  /** Filled share of a blob's box below which it's an arc, not a dot. */
  minFill?: number;
  /** Override for where structure icons are drawn (see STRUCTURE_SCALE). */
  structureScale?: number;
  /** When given, ward icons found are added here (they're never counted as minions). */
  wards?: Dot[];
  /** The game's own ward icons as templates (see wardTemplate): tells ward kinds apart and finds control wards. */
  wardTemplates?: WardTemplate[];
  /** Champion rings: anything inside one is part of the icon, not a minion. */
  exclude?: { cx: number; cy: number; r: number }[];
}

/**
 * Turrets and inhibitors (game units). Their icons change through the game (plates fall,
 * towers die), so they don't match the empty map from the first minute: minion dots are
 * not read on them. A minion under a turret icon is hidden by it anyway.
 */
export const STRUCTURES: { x: number; y: number }[] = [
  // Blue: top, mid, bot (outer, inner, inhibitor turret), inhibitors, nexus turrets.
  { x: 981, y: 10441 }, { x: 1512, y: 6699 }, { x: 1169, y: 4287 },
  { x: 5846, y: 6396 }, { x: 5048, y: 4812 }, { x: 3651, y: 3696 },
  { x: 10504, y: 1029 }, { x: 6919, y: 1483 }, { x: 4281, y: 1253 },
  { x: 1171, y: 3571 }, { x: 3203, y: 3208 }, { x: 3452, y: 1236 },
  { x: 1748, y: 2270 }, { x: 2177, y: 1807 },
  // Red.
  { x: 4318, y: 13875 }, { x: 7943, y: 13411 }, { x: 10481, y: 13650 },
  { x: 8955, y: 8510 }, { x: 9767, y: 10113 }, { x: 11134, y: 11207 },
  { x: 13866, y: 4505 }, { x: 13327, y: 8226 }, { x: 13624, y: 10572 },
  { x: 11261, y: 13676 }, { x: 11598, y: 11667 }, { x: 13604, y: 11316 },
  { x: 12611, y: 13084 }, { x: 13052, y: 12612 },
];
/**
 * Measured on a real replay's minimap: structure icons sit about 4.5% further from the
 * map centre than gameToPixel puts their game positions, up to 6 px out at the corners.
 * The mask is placed where the icons are drawn, with a radius that covers the icon.
 */
const STRUCTURE_SCALE = 1; // the 4.5% was the mapping: see MINIMAP_EXTENT
const STRUCTURE_R_PX = 7.5;

/** Fountains, where champion icons sit and no minion ever is (game units). */
export const FOUNTAINS = [
  { x: 400, y: 420, r: 1500 },
  { x: 14340, y: 14390, r: 1500 },
];

/**
 * A ward on the minimap is a four-point star in the team's colour, about 13x11 px with its
 * outline on a 247 px minimap: a 3 px nub on top, a wing to each side, a body and tail below,
 * all ringed by a dark navy outline (about (10,35,57)) that also runs through the middle, so
 * the colour breaks into several small pieces. Regions are offsets from the star's centre
 * (the nub's column, the row of the wing tops), [x0, x1, y0, y1] inclusive, in 247 px units.
 * Measured on 18 hand-placed wards in six frames of a real replay (NA1_5685324255).
 */
const STAR = {
  nub: [-1, 1, -3, -1],
  wingL: [-6, -3, -1, 2],
  wingR: [3, 6, -1, 2],
  tail: [-1, 1, 2, 5],
  // Beside the nub above the wings, and beside the tail below them, a star is empty.
  // A clump of minions fills these.
  emptyUL: [-6, -3, -5, -3],
  emptyUR: [3, 6, -5, -3],
  emptyLL: [-7, -4, 4, 6],
  emptyLR: [4, 7, 4, 6],
} as const;
/** The area a star covers: team-coloured pixels in here are the ward's, not a minion's. */
const STAR_FOOTPRINT = [-7, 7, -4, 6] as const;

/**
 * Ward icons (four-point stars) in a minimap crop; their centres in pixels.
 * Pixels under `masked` (structures, fountains, champion rings) never count as star colour.
 *
 * The rule and its numbers, measured on the 18 labelled wards against every minion blob
 * in the same fixture (247 px minimap; counts scale with the area):
 *  - star colour is the team colour and at least 40 off the empty map (the river is blue, so
 *    a looser test reads the river; 70, the minion threshold, loses half of a star's pixels
 *    where it sits on the river);
 *  - nub >= 2 coloured px (wards: 2-7), each wing 2-9 (wards: 2-8; a horizontal row of
 *    minions puts 9-13 in a wing), tail >= 3 (wards: 3-8, one cut by a minimap edge: 1);
 *  - the tail area holds >= 3 dark px (max channel < 80) — the outline (wards: 3-8;
 *    minion rows 0-2);
 *  - the four empty corners hold <= 3 coloured px together (wards: 0-3; minion clumps more);
 *  - colour is balanced across the diagonals: (upper-right + lower-left) and (upper-left +
 *    lower-right) are within 3x of each other (wards: at most 1.6x; a diagonal chain of
 *    top-lane minions that passed everything else: 32 vs 3).
 * Of 18 labelled wards, all 18 pass; the best-scoring centre within 6 px wins.
 */
export function findWardStars(frame: Frame, bg: Frame, masked?: Uint8Array): { team: 100 | 200; px: number; py: number; colour: number }[] {
  const { w, h, data } = frame;
  const k = w / 247;
  const k2 = k * k;
  const col = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (Math.max(data[i], data[i + 1], data[i + 2]) < 80) dark[p] = 1;
    if (masked?.[p] || diffAt(data, bg.data, i) < 40) continue;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) col[p] = t === 100 ? 1 : 2;
  }
  const count = (m: Uint8Array, v: number, cx: number, cy: number, r: readonly number[]) => {
    let n = 0;
    for (let y = Math.max(0, Math.round(cy + r[2] * k)); y <= Math.min(h - 1, Math.round(cy + r[3] * k)); y++)
      for (let x = Math.max(0, Math.round(cx + r[0] * k)); x <= Math.min(w - 1, Math.round(cx + r[1] * k)); x++) if (m[y * w + x] === v) n++;
    return n;
  };
  const found: { team: 100 | 200; px: number; py: number; colour: number; score: number }[] = [];
  const nubDy = Math.round(2 * k);
  for (const team of [100, 200] as const) {
    const v = team === 100 ? 1 : 2;
    for (let cy = nubDy; cy < h; cy++)
      for (let cx = 1; cx < w - 1; cx++) {
        // Quick reject: the nub, two rows up, must have colour at or beside the centre column.
        const q = (cy - nubDy) * w + cx;
        if (col[q] !== v && col[q - 1] !== v && col[q + 1] !== v) continue;
        const nub = count(col, v, cx, cy, STAR.nub);
        if (nub < 2 * k2) continue;
        const tail = count(col, v, cx, cy, STAR.tail);
        if (tail < 3 * k2) continue;
        const wl = count(col, v, cx, cy, STAR.wingL);
        const wr = count(col, v, cx, cy, STAR.wingR);
        if (wl < 2 * k2 || wr < 2 * k2 || wl > 9 * k2 || wr > 9 * k2) continue;
        if (count(dark, 1, cx, cy, STAR.tail) < 3 * k2) continue;
        const empty = count(col, v, cx, cy, STAR.emptyUL) + count(col, v, cx, cy, STAR.emptyUR) + count(col, v, cx, cy, STAR.emptyLL) + count(col, v, cx, cy, STAR.emptyLR);
        if (empty > 3 * k2) continue;
        // A star is balanced across both diagonals; a diagonal chain of minions is not.
        const d1 = count(col, v, cx, cy, [1, 7, -4, 0]) + count(col, v, cx, cy, [-7, -1, 1, 6]);
        const d2 = count(col, v, cx, cy, [-7, -1, -4, 0]) + count(col, v, cx, cy, [1, 7, 1, 6]);
        if (Math.max(d1, d2) > 3 * Math.min(d1, d2)) continue;
        // How star-like: each part present (capped so a big part can't make up for a missing
        // one), less any colour in the empty corners.
        const cap = 3 * k2;
        const score = Math.min(nub, cap) + Math.min(wl, cap) + Math.min(wr, cap) + Math.min(tail, cap) - 2 * empty;
        found.push({ team, px: cx, py: cy, colour: nub + wl + wr + tail, score });
      }
  }
  found.sort((a, b) => b.score - a.score);
  const keep: typeof found = [];
  const sep = 6 * k;
  for (const s of found) if (!keep.some((t) => Math.abs(t.px - s.px) <= sep && Math.abs(t.py - s.py) <= sep)) keep.push(s);
  return keep.map(({ team, px, py, colour }) => ({ team, px, py, colour }));
}

export type WardKind = "stealth" | "stealth_low" | "control";

/**
 * A ward icon from the game's files (raw.communitydragon.org, ux/minimap/icons), reduced to
 * how the minimap draws it: each cell is 1 icon colour, 2 dark outline, 0 empty, -1 mixed.
 * The game draws these 32 px icons at about 0.62 of their size on a 247 px minimap: the
 * stealth ward star comes out 13x11 px with its outline, the control ward's eye about 12x7
 * (both measured on NA1_5686039660). Matching is on shape only, against separate team-colour
 * and dark masks: plain RGB correlation can't tell the kinds apart.
 */
export interface WardTemplate {
  kind: WardKind;
  w: number;
  h: number;
  /** Cells, row by row, at a 247 px minimap. */
  c: Int8Array;
}

export const WARD_ICON_SCALE = 0.62;

/** Template of one icon (RGBA with alpha), at `scale` of its size (default: as drawn on a 247 px minimap). */
export function wardTemplate(kind: WardKind, icon: Frame, scale = WARD_ICON_SCALE): WardTemplate {
  const W = Math.round(icon.w * scale);
  const H = Math.round(icon.h * scale);
  const cls = new Int8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let a = 0;
      let col = 0;
      let dark = 0;
      let n = 0;
      for (let yy = Math.floor(y / scale); yy < Math.min(icon.h, Math.ceil((y + 1) / scale)); yy++)
        for (let xx = Math.floor(x / scale); xx < Math.min(icon.w, Math.ceil((x + 1) / scale)); xx++) {
          const i = (yy * icon.w + xx) * 4;
          n++;
          const al = icon.data[i + 3] / 255;
          a += al;
          if (al > 0.5) {
            if (Math.max(icon.data[i], icon.data[i + 1], icon.data[i + 2]) < 80) dark++;
            else col++;
          }
        }
      n = Math.max(1, n);
      a /= n;
      cls[y * W + x] = a < 0.15 ? 0 : col / n > 0.55 ? 1 : dark / n > 0.55 ? 2 : -1;
    }
  // Trim to the icon plus a one-cell empty border.
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (cls[y * W + x] !== 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const tw = x1 - x0 + 3;
  const th = y1 - y0 + 3;
  const c = new Int8Array(tw * th);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const sx = x + x0 - 1;
      const sy = y + y0 - 1;
      c[y * tw + x] = sx >= 0 && sy >= 0 && sx < W && sy < H ? cls[sy * W + sx] : 0;
    }
  return { kind, w: tw, h: th, c };
}

/** A template resampled to another minimap width (nearest cell). */
function scaledTemplate(t: WardTemplate, k: number): WardTemplate {
  if (Math.abs(k - 1) < 0.02) return t;
  const w = Math.max(3, Math.round(t.w * k));
  const h = Math.max(3, Math.round(t.h * k));
  const c = new Int8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) c[y * w + x] = t.c[Math.min(t.h - 1, Math.floor(y / k)) * t.w + Math.min(t.w - 1, Math.floor(x / k))];
  return { kind: t.kind, w, h, c };
}

/**
 * How well a template sits with its centre at (cx, cy): the share of its colour cells that
 * are this team's colour (rc), of its outline cells that are dark (rd), and team colour
 * spilling into its empty cells as a share of its colour cells (rs).
 */
function templateFit(col: Uint8Array, dark: Uint8Array, w: number, h: number, t: WardTemplate, v: number, cx: number, cy: number) {
  const ox = Math.round(cx - t.w / 2 + 0.5);
  const oy = Math.round(cy - t.h / 2 + 0.5);
  let nC = 0;
  let nD = 0;
  let cH = 0;
  let dH = 0;
  let sp = 0;
  for (let y = 0; y < t.h; y++) {
    const fy = oy + y;
    for (let x = 0; x < t.w; x++) {
      const c = t.c[y * t.w + x];
      if (c === 1) nC++;
      else if (c === 2) nD++;
      const fx = ox + x;
      if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
      const p = fy * w + fx;
      if (c === 1 && col[p] === v) cH++;
      else if (c === 2 && dark[p]) dH++;
      else if (c === 0 && col[p] === v) sp++;
    }
  }
  const rc = cH / Math.max(1, nC);
  const rd = dH / Math.max(1, nD);
  const rs = sp / Math.max(1, nC);
  return { rc, rd, rs, score: rc + 0.5 * rd - rs };
}

/** Control ward eyes: a fit at least this good, and better than either star's fit there by CONTROL_MARGIN. */
const CONTROL_MIN = 0.6;
const CONTROL_MIN_COLOUR = 0.5;
const CONTROL_MARGIN = 0.05;

/**
 * Ward icons in a minimap crop, with their kind when templates are given.
 *  - Stealth wards (trinket and sight ward draw the same star) come from findWardStars;
 *    with templates, a star the hollow "about to expire" icon fits better is "stealth_low".
 *  - Control wards (an eye with a slash) are found with their template, kept where the eye
 *    fits better than either star. On NA1_5686039660's dumps (one every 6 s) both blue
 *    control wards were found in every frame they were up and not under a portrait (25 and
 *    25 frames) and the red one in 16; everything else that passed did so in a single frame,
 *    so placeWards wants a control icon to stay put before it counts.
 * Without templates the kinds are left out (the star rule alone, as before).
 */
export function findWardIcons(frame: Frame, bg: Frame, masked?: Uint8Array, templates?: WardTemplate[]): { team: 100 | 200; px: number; py: number; colour: number; kind?: WardKind }[] {
  const stars: { team: 100 | 200; px: number; py: number; colour: number; kind?: WardKind }[] = findWardStars(frame, bg, masked);
  if (!templates?.length) return stars;
  const { w, h, data } = frame;
  const k = w / 247;
  const T = templates.map((t) => scaledTemplate(t, k));
  const col = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (Math.max(data[i], data[i + 1], data[i + 2]) < 80) dark[p] = 1;
    if (masked?.[p] || diffAt(data, bg.data, i) < 40) continue;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) col[p] = t === 100 ? 1 : 2;
  }
  const best = (kind: WardKind, v: number, cx: number, cy: number) => {
    let b = -Infinity;
    for (const t of T)
      if (t.kind === kind)
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) b = Math.max(b, templateFit(col, dark, w, h, t, v, cx + dx, cy + dy).score);
    return b;
  };
  for (const s of stars) {
    const v = s.team === 100 ? 1 : 2;
    // The star rule also passes a red control ward's eye on the river (NA1_5686039660, 10:51).
    // Re-labelling a star as an eye when the eye fits better turned 9 real stars on the same
    // dumps into "control" (the hollow low star fits the eye about as well), so a star stays a star.
    s.kind = best("stealth_low", v, s.px, s.py) > best("stealth", v, s.px, s.py) ? "stealth_low" : "stealth";
  }
  const eyes = T.filter((t) => t.kind === "control");
  const found: { team: 100 | 200; px: number; py: number; colour: number; score: number }[] = [];
  for (const team of [100, 200] as const) {
    const v = team === 100 ? 1 : 2;
    for (const t of eyes)
      for (let cy = 0; cy < h; cy++)
        for (let cx = 0; cx < w; cx++) {
          if (col[cy * w + cx] !== v) continue;
          const f = templateFit(col, dark, w, h, t, v, cx, cy);
          if (f.score < CONTROL_MIN || f.rc < CONTROL_MIN_COLOUR) continue;
          if (Math.max(best("stealth", v, cx, cy), best("stealth_low", v, cx, cy)) > f.score - CONTROL_MARGIN) continue;
          found.push({ team, px: cx, py: cy, colour: Math.round(f.rc * 100), score: f.score });
        }
  }
  found.sort((a, b) => b.score - a.score);
  const sep = 6 * k;
  const out = [...stars];
  for (const s of found) if (!out.some((t) => Math.abs(t.px - s.px) <= sep && Math.abs(t.py - s.py) <= sep)) out.push({ team: s.team, px: s.px, py: s.py, colour: s.colour, kind: "control" });
  return out;
}

/**
 * Whether a structure icon is still drawn at (cx, cy): at least STANDING_SHARE of the team-
 * coloured pixels the empty map has in its disc are still team-coloured in the frame. Minions
 * walking over a dead tower's spot cover far less than the icon did.
 */
const STANDING_SHARE = 0.35;
function structureStanding(f: Frame, bg: Frame, cx: number, cy: number, r: number): boolean {
  let was = 0;
  let is = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(f.h - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(f.w - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * f.w + x) * 4;
      if (teamColor(bg.data[i], bg.data[i + 1], bg.data[i + 2])) was++;
      if (teamColor(f.data[i], f.data[i + 1], f.data[i + 2])) is++;
    }
  return was < 8 || is >= was * STANDING_SHARE;
}

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
    const r = (f.r / (E.maxX - E.minX)) * w;
    markDisc(masked, w, h, c.px, c.py, r);
  }
  for (const st of STRUCTURES) {
    const c = gameToPixel(st.x, st.y, w);
    const k = o.structureScale ?? STRUCTURE_SCALE;
    const cx = w / 2 + (c.px - w / 2) * k;
    const cy = h / 2 + (c.py - h / 2) * k;
    const r = STRUCTURE_R_PX * (w / 247);
    // A fallen structure's icon is gone (the empty map shows it standing): its team colour
    // is missing from the frame, so minions there can be read again.
    if (!structureStanding(frame, bg, cx, cy, r)) continue;
    markDisc(masked, w, h, cx, cy, r);
  }
  for (const e of o.exclude ?? []) markDisc(masked, w, h, e.cx, e.cy, e.r + 2);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (masked[p]) continue;
    if (diffAt(data, bg.data, i) < diff) continue;
    const t = teamColor(data[i], data[i + 1], data[i + 2]);
    if (t) label[p] = t === 100 ? 1 : 2;
  }
  // Ward icons come out before minions are counted: each piece of a star is minion-sized
  // and would otherwise be read as a minion. A control ward's eye is left in: a minion clump
  // fits the eye in single frames (2 of 18 labelled frames lost 1-3 bot minions to it), and a
  // real eye is still for minutes, which the static-blob rule takes out.
  const k = w / 247;
  for (const s of findWardIcons(frame, bg, masked, o.wardTemplates)) {
    const l = s.team === 100 ? 1 : 2;
    const [x0, x1, y0, y1] = STAR_FOOTPRINT;
    if (s.kind !== "control")
      for (let y = Math.max(0, Math.round(s.py + y0 * k)); y <= Math.min(h - 1, Math.round(s.py + y1 * k)); y++)
        for (let x = Math.max(0, Math.round(s.px + x0 * k)); x <= Math.min(w - 1, Math.round(s.px + x1 * k)); x++) if (label[y * w + x] === l) label[y * w + x] = 0;
    if (o.wards) {
      const g = pixelToGame(s.px + 0.5, s.py + 0.5, w);
      o.wards.push({ team: s.team, x: Math.round(g.x), y: Math.round(g.y), area: s.colour, ...(s.kind ? { kind: s.kind } : {}) });
    }
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
    // A ring or bar, not a dot. Two or three minions touching in a line make a blob longer
    // than one dot is wide (seen in the fixture: 8x4 and 9x4 px pairs on a 247 px map,
    // dropped by a plain size cap), so only the short side is held to one dot.
    if (Math.min(bw, bh) > maxD || Math.max(bw, bh) > 2.5 * maxD) continue;
    // Minion dots are filled; a thin arc (a ring edge, an ability circle) is not.
    if (bw * bh >= 9 && area / (bw * bh) < (o.minFill ?? 0.45)) continue;
    const g = pixelToGame(sx / area + 0.5, sy / area + 0.5, w);
    dots.push({ team: l === 1 ? 100 : 200, x: Math.round(g.x), y: Math.round(g.y), area });
  }
  // One minion's dot area on this minimap: the median blob when there are enough to tell
  // (most blobs are single minions), else the expected size for this minimap width.
  // Measured on a 247 px minimap: a clear single minion dot is 10-13 px. Take the median
  // of the blobs near that size in this frame when there are enough, else that size scaled.
  const expected = 11.5 * (w / 247) ** 2;
  const near = dots.map((d) => d.area).filter((a) => a >= expected * 0.7 && a <= expected * 1.4).sort((a, b) => a - b);
  const single = near.length >= 4 ? near[near.length >> 1] : expected;
  const out: Dot[] = [];
  for (const d of dots) {
    // Slivers (ring edges, vision-circle fringe, ping marks) are far smaller than a minion.
    // A minion half under an icon is still about a third of a dot.
    if (d.area < single * 0.3) continue;
    d.n = Math.min(4, Math.max(1, Math.round(d.area / single)));
    out.push(d);
  }
  return out;
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

export function gridDiff(a: number[], b: number[]): number {
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
/**
 * A ring cut off by the minimap's corner at a fountain spot (blue: bottom-left, red:
 * top-right): a champion standing in their fountain. Only about a quarter of it is inside
 * the crop (Kayle at 5:17 on NA1_5686039660), too little for the circle search.
 * This works on the frame's own colours, not the difference from the empty map: the empty
 * map's fountain is itself a median of frames that often have a champion standing there
 * (it did on NA1_5686039660), and the fountain floor is drawn in the team's colour. So a ring
 * here is a thin circle of team colour at the ring size with a portrait inside it, where the
 * empty floor is team colour all through.
 */
const CORNER_SLACK = 5;
function cornerRing(frame: Frame, team: 100 | 200, r0: number): Ring | null {
  const { w, h, data } = frame;
  const isTeam = (x: number, y: number) => {
    const i = (Math.round(y) * w + Math.round(x)) * 4;
    return teamColor(data[i], data[i + 1], data[i + 2]) === team;
  };
  // A ring is drawn bright (its brightest channel ~240); the fountain floor and the river are
  // the same hue but dull (~140).
  const isRim = (x: number, y: number) => {
    const i = (Math.round(y) * w + Math.round(x)) * 4;
    return isTeam(x, y) && Math.max(data[i], data[i + 1], data[i + 2]) >= RIM_BRIGHT;
  };
  const inCrop = (x: number, y: number) => x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1;
  const r = r0 - 1;
  const f = FOUNTAINS[team === 100 ? 0 : 1];
  const spot = gameToPixel(f.x, f.y, w);
  const slack = CORNER_SLACK * (w / 247);
  let best: Ring | null = null;
  let bestScore = 0;
  for (let dy = -slack; dy <= slack; dy += 0.5)
    for (let dx = -slack; dx <= slack; dx += 0.5) {
      const cx = spot.px + dx;
      const cy = spot.py + dy;
      // The rim: of the 24 sectors whose middle is inside the crop, how many have team colour on the circle.
      let inside = 0;
      let covered = 0;
      for (let k = 0; k < 24; k++) {
        const a = ((k + 0.5) / 24) * 2 * Math.PI;
        if (!inCrop(cx + r * Math.cos(a), cy + r * Math.sin(a))) continue;
        inside++;
        for (let dr = -1; dr <= 1; dr++) {
          const x = cx + (r + dr) * Math.cos(a);
          const y = cy + (r + dr) * Math.sin(a);
          if (inCrop(x, y) && isRim(x, y)) {
            covered++;
            break;
          }
        }
      }
      if (inside < 4 || covered / inside < 0.75) continue;
      // The inside: a portrait, not the floor.
      let n = 0;
      let tc = 0;
      for (let y = Math.ceil(cy - r + 3); y <= cy + r - 3; y++)
        for (let x = Math.ceil(cx - r + 3); x <= cx + r - 3; x++) {
          if (!inCrop(x, y) || Math.hypot(x - cx, y - cy) > r - 3) continue;
          n++;
          if (isTeam(x, y)) tc++;
        }
      if (n < 10 || tc / n > CORNER_FILL) continue;
      const score = covered / inside - tc / n;
      if (score > bestScore) {
        bestScore = score;
        best = { team, cx, cy, r: r0, cover: covered / 24 };
      }
    }
  return best;
}
/** Share of a fountain ring's inside that may be team colour (portraits carry some; the empty floor is all of it). */
const CORNER_FILL = 0.4;
const RIM_BRIGHT = 190;

export function findRings(frame: Frame, bg?: Frame, opts: { minCover?: number } = {}): Ring[] {
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
    for (const c of houghRings(b, w, r0 - 1, opts.minCover ?? 0.3)) rings.push({ team: b.l === 1 ? 100 : 200, cx: c.cx, cy: c.cy, r: r0, cover: c.cover });
  }
  // Champions standing in their fountain, drawn three quarters off the minimap's corner.
  for (const team of [100, 200] as const) {
    const ring = cornerRing(frame, team, r0);
    if (ring && !rings.some((x) => Math.hypot(x.cx - ring.cx, x.cy - ring.cy) < r0)) rings.push(ring);
  }
  // One icon, two rings: a second circle found on the same icon (same team, close), or
  // portrait art of the other team's colour inside a ring (pink or red art in a blue ring).
  // Keep the ring that more of the circle backs.
  const keep = rings.map(() => true);
  const order = rings.map((_, i) => i).sort((a, b) => rings[b].cover - rings[a].cover);
  for (let a = 0; a < order.length; a++) {
    const A = rings[order[a]];
    if (!keep[order[a]]) continue;
    for (let b = a + 1; b < order.length; b++) {
      const B = rings[order[b]];
      if (!keep[order[b]]) continue;
      const d = Math.hypot(A.cx - B.cx, A.cy - B.cy);
      if (d < (A.team === B.team ? 0.75 : 0.5) * r0) keep[order[b]] = false;
    }
  }
  return rings.filter((_, i) => keep[i]);
}

/**
 * Champion icons on a cropped minimap: team-coloured rings, identified by matching the
 * portrait inside against the ten champions in the game. Rings that match no one well
 * enough come back with id 0, so tracking can still name them.
 */
export type FoundChamp = ChampDot & { team: 100 | 200; /** The ring's portrait grid and how much of the ring showed, for matching later. */ grid: number[]; cover: number };

export function detectChampions(frame: Frame, refs: PortraitRef[], maxScore = 38, rings = findRings(frame)): FoundChamp[] {
  const w = frame.w;
  const pairs: { ring: number; ref: PortraitRef; score: number }[] = [];
  const grids: number[][] = [];
  rings.forEach((ring, i) => {
    // A covered ring's portrait is partly someone else's: judge it more loosely.
    const g = portraitGrid(frame, ring.cx, ring.cy, ring.r);
    grids[i] = g;
    const slack = ring.cover < 0.9 ? 1 + (0.9 - ring.cover) : 1;
    for (const ref of refs) if (ref.team === ring.team) pairs.push({ ring: i, ref, score: gridDiff(g, ref.grid) / slack });
  });
  pairs.sort((a, b) => a.score - b.score);
  const usedRing = new Set<number>();
  const usedRef = new Set<number>();
  const out: FoundChamp[] = [];
  for (const p of pairs) {
    if (p.score > maxScore || usedRing.has(p.ring) || usedRef.has(p.ref.id)) continue;
    usedRing.add(p.ring);
    usedRef.add(p.ref.id);
    const ring = rings[p.ring];
    const g = pixelToGame(ring.cx + 0.5, ring.cy + 0.5, w);
    out.push({ id: p.ref.id, team: ring.team, x: Math.round(g.x), y: Math.round(g.y), score: Math.round(p.score), grid: grids[p.ring], cover: ring.cover });
  }
  rings.forEach((ring, i) => {
    if (usedRing.has(i)) return;
    const g = pixelToGame(ring.cx + 0.5, ring.cy + 0.5, w);
    out.push({ id: 0, team: ring.team, x: Math.round(g.x), y: Math.round(g.y), score: 999, grid: grids[i], cover: ring.cover });
  });
  return out;
}

/**
 * Second look at rings nobody matched, against portraits learned from this replay's own
 * minimap: the grids of confident matches (Data Dragon's square art differs from the
 * in-game minimap icon for some champions). A ring is named only when one champion
 * clearly fits best, by a margin over the next, and isn't already in that frame.
 */
export function rematch(
  unknowns: { grid: number[]; team: 100 | 200; taken: Set<number> }[],
  learned: Map<number, { team: 100 | 200; grids: number[][] }>,
  maxScore = 30,
  margin = 6,
): (number | 0)[] {
  return unknowns.map((u) => {
    const scores: { id: number; s: number }[] = [];
    for (const [id, l] of learned) {
      if (l.team !== u.team || u.taken.has(id) || !l.grids.length) continue;
      scores.push({ id, s: Math.min(...l.grids.map((g) => gridDiff(u.grid, g))) });
    }
    scores.sort((a, b) => a.s - b.s);
    if (!scores.length || scores[0].s > maxScore) return 0;
    if (scores.length > 1 && scores[1].s - scores[0].s < margin) return 0;
    return scores[0].id;
  });
}
