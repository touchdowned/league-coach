import { describe, expect, it } from "vitest";
import { findOpponent, findPlayer } from "../src/core/analysis";
import { readGame } from "../src/core/engine";
import { crop, detectDots, findMinimap, Frame, gameToPixel, medianFrame } from "../src/core/minimap";
import { buildTrack } from "../src/core/track";
import type { TimelineEvent } from "../src/core/types";
import { minionsAt, pointOnLane, projectLane, sampleFromDots, waveAt, WaveSample, WaveTrack } from "../src/core/waves";
import { makeGame, ME } from "./fixtures";

// ---- synthetic frames ----
function blank(w: number, h: number, seed = 1): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = s % 24;
    // Dull green map with a desaturated blue river band, like the minimap.
    const x = i % w;
    const y = Math.floor(i / w);
    const river = Math.abs(x - (w - y)) < w * 0.04;
    data[i * 4] = river ? 50 + n : 40 + n;
    data[i * 4 + 1] = river ? 80 + n : 70 + n;
    data[i * 4 + 2] = river ? 110 + n : 40 + n;
    data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}
function paint(f: Frame, cx: number, cy: number, r: number, rgb: [number, number, number], ring = false) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r || (ring && d < r - 2) || x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const i = (y * f.w + x) * 4;
      [f.data[i], f.data[i + 1], f.data[i + 2]] = rgb;
    }
}
const clone = (f: Frame): Frame => ({ ...f, data: new Uint8ClampedArray(f.data) });
const BLUE: [number, number, number] = [70, 150, 255];
const RED: [number, number, number] = [240, 60, 60];

describe("minimap reading", () => {
  it("finds the minimap by toggling it on and off", () => {
    const off = blank(1920, 1080, 7);
    const on = clone(off);
    const map = blank(300, 300, 3);
    for (let y = 0; y < 300; y++) on.data.set(map.data.subarray(y * 1200, y * 1200 + 1200), ((1080 - 310 + y) * 1920 + (1920 - 310)) * 4);
    const r = findMinimap(on, off)!;
    expect(r).toBeTruthy();
    expect(Math.abs(r.x - 1610)).toBeLessThan(10);
    expect(Math.abs(r.y - 770)).toBeLessThan(10);
    expect(Math.abs(r.w - 300)).toBeLessThan(15);
  });

  it("reads minion dots and skips champion icons", () => {
    const size = 300;
    const bgs = [1, 2, 3].map((s) => blank(size, size, 5 + s * 0)); // same map each time
    const empty = medianFrame(bgs);
    const f = clone(empty);
    const mids = [0.4, 0.42, 0.44].map((s) => pointOnLane("MIDDLE", s));
    for (const p of mids) {
      const { px, py } = gameToPixel(p.x, p.y, size);
      paint(f, px, py, 2, BLUE);
    }
    const red = pointOnLane("MIDDLE", 0.5);
    const rp = gameToPixel(red.x, red.y, size);
    paint(f, rp.px, rp.py, 2, RED);
    paint(f, 60, 60, 11, RED, true); // a champion icon ring
    const dots = detectDots(f, empty);
    expect(dots.filter((d) => d.team === 100)).toHaveLength(3);
    expect(dots.filter((d) => d.team === 200)).toHaveLength(1);
    for (const d of dots) expect(projectLane(d)?.lane).toBe("MIDDLE");
    const s = sampleFromDots(90_000, dots);
    expect(s.lanes.MIDDLE.b.length).toBe(3);
    expect(Math.abs(s.lanes.MIDDLE.r[0] - 0.5)).toBeLessThan(0.03);
  });

  it("crops a frame", () => {
    const f = blank(50, 40);
    const c = crop(f, { x: 10, y: 5, w: 20, h: 10 });
    expect(c.w).toBe(20);
    expect(c.data[0]).toBe(f.data[(5 * 50 + 10) * 4]);
  });
});

// ---- wave reads ----
function track(at: (t: number) => WaveSample["lanes"]["MIDDLE"]): WaveTrack {
  const samples: WaveSample[] = [];
  for (let t = 65_000; t <= 15 * 60_000; t += 2000) samples.push({ t, lanes: { TOP: { b: [], r: [] }, MIDDLE: at(t), BOTTOM: { b: [], r: [] } } });
  return { version: 1, source: "replay-minimap", samples };
}

describe("wave state from the replay", () => {
  it("reads who has more minions and where the wave is, from either side", () => {
    const tr = track(() => ({ b: [0.36, 0.37], r: [0.37, 0.38, 0.38, 0.39, 0.4, 0.4] }));
    const blue = waveAt(tr, 300_000, "MIDDLE", 100)!;
    expect(blue).toMatchObject({ mine: 2, theirs: 6, where: "under your tower" });
    const red = waveAt(tr, 300_000, "MIDDLE", 200)!;
    expect(red).toMatchObject({ mine: 6, theirs: 2, where: "under their tower" });
    expect(minionsAt(tr, 300_500)).toHaveLength(8);
  });

  it("tells a recall into a big enemy wave apart, and names the window you missed", () => {
    const recall = 8 * 60_000 + 20_000; // purchase; leaving is 10s before
    const tr = track((t) =>
      t > recall - 45_000 && t < recall - 30_000
        ? { b: [0.62, 0.63, 0.64, 0.64, 0.65], r: [0.65] } // your wave crashing their tower
        : { b: [0.37], r: [0.37, 0.38, 0.39, 0.4, 0.4, 0.41] }, // theirs on yours
    );
    const g = makeGame({ events: [{ type: "ITEM_PURCHASED", timestamp: recall, participantId: 3, itemId: 1036 } as TimelineEvent] });
    for (const f of g.timeline.info.frames) f.participantFrames["3"].position = { x: 6000, y: 6000 };
    const me = findPlayer(g.match, ME);
    const leaks = readGame(g.match, g.timeline, buildTrack(g.match, g.timeline), me, findOpponent(g.match, me), tr);
    const r = leaks.find((l) => l.kind === "recall")!;
    expect(r).toBeTruthy();
    expect(r.evidence.join(" ")).toMatch(/Wave read from the replay: when you started recalling, 6 of .* minions were pushing under your tower against 1 of yours/);
    expect(r.nextTime).toMatch(/^At 7:[34]\d your wave was crashing into .*tower/);
  });

  it("quotes the minion count on a lane death", () => {
    const tr = track(() => ({ b: [0.5], r: [0.5, 0.51, 0.52, 0.52, 0.53] }));
    const g = makeGame({ events: [{ type: "CHAMPION_KILL", timestamp: 6 * 60_000, victimId: 3, killerId: 8, assistingParticipantIds: [], position: { x: 7400, y: 7400 } }] });
    const me = findPlayer(g.match, ME);
    const leaks = readGame(g.match, g.timeline, buildTrack(g.match, g.timeline), me, findOpponent(g.match, me), tr);
    const d = leaks.find((l) => l.kind === "death")!;
    expect(d.nextTime).toMatch(/with 1 of your minions against 5 of theirs/);
  });
});

// ---- champions and vision ----
import { detectChampions, findRings, iconGrid } from "../src/core/minimap";
import { hasVision, lastSeen, mergeReplayPositions, nameRings, truthAt, visibleAt } from "../src/core/vision";
import type { ChampSample } from "../src/core/waves";

function icon(seed: number): Frame {
  // A blocky, distinct "portrait".
  const f = blank(48, 48, seed);
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < 48; x++) {
      const i = (y * 48 + x) * 4;
      const q = ((x >> 4) + (y >> 4) * 3 + seed) % 5;
      f.data[i] = [200, 30, 120, 240, 60][q];
      f.data[i + 1] = [180, 200, 40, 90, 60][q];
      f.data[i + 2] = [30, 60, 200, 20, 140][q];
    }
  return f;
}
function stamp(f: Frame, ic: Frame, cx: number, cy: number, r: number, ring: [number, number, number]) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const i = (y * f.w + x) * 4;
      if (d > r - 2) [f.data[i], f.data[i + 1], f.data[i + 2]] = ring;
      else {
        const sx = Math.min(47, Math.max(0, Math.round(((x - cx) / r) * 24 + 24)));
        const sy = Math.min(47, Math.max(0, Math.round(((y - cy) / r) * 24 + 24)));
        const j = (sy * 48 + sx) * 4;
        [f.data[i], f.data[i + 1], f.data[i + 2]] = [ic.data[j], ic.data[j + 1], ic.data[j + 2]];
      }
    }
}

describe("champions on the minimap", () => {
  it("finds champion rings and tells which champion each one is", () => {
    const icons = [1, 2, 3, 4].map(icon);
    const refs = [
      { id: 3, team: 100 as const, grid: iconGrid(icons[0]) },
      { id: 1, team: 100 as const, grid: iconGrid(icons[1]) },
      { id: 7, team: 200 as const, grid: iconGrid(icons[2]) },
      { id: 8, team: 200 as const, grid: iconGrid(icons[3]) },
    ];
    const f = blank(300, 300, 9);
    stamp(f, icons[0], 150, 150, 11, BLUE);
    stamp(f, icons[2], 80, 210, 11, RED);
    stamp(f, icons[3], 220, 60, 11, RED);
    const found = detectChampions(f, refs);
    const byId = Object.fromEntries(found.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["3", "7", "8"]);
    const mid = gameToPixel(byId[3].x, byId[3].y, 300);
    expect(Math.abs(mid.px - 150)).toBeLessThan(2);
    expect(Math.abs(mid.py - 150)).toBeLessThan(2);
  });
});

function visionTrack(): WaveTrack {
  // Enemy jungler (7) shows on your minimap at 5:30 in your top-side jungle, then
  // disappears; fog-off shows him walking to mid. You die to him at 6:00.
  const champs: ChampSample[] = [];
  for (let t = 65_000; t <= 7 * 60_000; t += 1000) {
    const jg = t <= 5.5 * 60_000 ? { x: 3800, y: 8000 } : { x: 3800 + ((t - 330_000) / 30_000) * 3000, y: 8000 - ((t - 330_000) / 30_000) * 900 };
    const allies = [1, 2, 3, 4, 5].map((id) => ({ id, x: 7000, y: 7000 }));
    champs.push({ t, fog: "off", at: [...allies, { id: 7, ...jg }, { id: 8, x: 7600, y: 7600 }] });
    champs.push({ t: t + 500, fog: "team", at: [...allies, ...(t <= 5.5 * 60_000 ? [{ id: 7, ...jg }] : []), { id: 8, x: 7600, y: 7600 }] });
  }
  return { version: 2, source: "replay-minimap", samples: [], champs, viewTeam: 100 };
}

describe("what you could see vs what was true", () => {
  it("answers last-seen, visible-now and truth", () => {
    const w = visionTrack();
    expect(hasVision(w, 100)).toBe(true);
    expect(hasVision(w, 200)).toBe(false);
    expect(lastSeen(w, 7, 6 * 60_000)!.t).toBe(330_500);
    expect(visibleAt(w, 345_000)!.has(7)).toBe(false);
    expect(truthAt(w, 7, 345_000)!.x).toBeGreaterThan(4500);
  });

  it("puts the real replay path into the track", () => {
    const g = makeGame();
    const t = mergeReplayPositions(buildTrack(g.match, g.timeline), visionTrack());
    expect(t.keys[7].length).toBeGreaterThan(300);
  });

  it("tells you when you had the information and what to do with it", () => {
    const g = makeGame({ events: [{ type: "CHAMPION_KILL", timestamp: 6 * 60_000, victimId: 3, killerId: 7, assistingParticipantIds: [8], position: { x: 6600, y: 7600 } }] });
    const me = findPlayer(g.match, ME);
    const leaks = readGame(g.match, g.timeline, buildTrack(g.match, g.timeline), me, findOpponent(g.match, me), visionTrack());
    const d = leaks.find((l) => l.kind === "death")!;
    expect(d.evidence.join(" ")).toMatch(/Champ6 showed on your minimap at 5:30/);
    expect(d.nextTime).toMatch(/^You had the information/);
  });

  it("says when you couldn't have known, and what the mistake was instead", () => {
    const w = visionTrack();
    w.champs = w.champs!.map((s) => (s.fog === "team" ? { ...s, at: s.at.filter((a) => a.id !== 7) } : s));
    const g = makeGame({ events: [{ type: "CHAMPION_KILL", timestamp: 6 * 60_000, victimId: 3, killerId: 7, assistingParticipantIds: [8], position: { x: 6600, y: 7600 } }] });
    const me = findPlayer(g.match, ME);
    const d = readGame(g.match, g.timeline, buildTrack(g.match, g.timeline), me, findOpponent(g.match, me), w).find((l) => l.kind === "death")!;
    expect(d.nextTime).toMatch(/^You couldn't see Champ6 coming/);
    expect(d.evidence.join(" ")).toMatch(/With fog off, 20s before you died Champ6 was/);
  });
});

describe("champion rings that touch or overlap", () => {
  it("splits two touching same-team rings and keeps a half-covered one", () => {
    const icons = [1, 2, 3, 4].map(icon);
    const refs = [
      { id: 1, team: 100 as const, grid: iconGrid(icons[0]) },
      { id: 2, team: 100 as const, grid: iconGrid(icons[1]) },
      { id: 6, team: 200 as const, grid: iconGrid(icons[2]) },
      { id: 7, team: 200 as const, grid: iconGrid(icons[3]) },
    ];
    const f = blank(300, 300, 9);
    // Two allies side by side (rings touch, one blob), and a red ring a third under a blue one.
    stamp(f, icons[0], 100, 100, 11, BLUE);
    stamp(f, icons[1], 121, 100, 11, BLUE);
    stamp(f, icons[2], 200, 200, 11, RED);
    stamp(f, icons[3], 214, 205, 11, RED);
    const rings = findRings(f);
    const near = (x: number, y: number, team: number) => rings.some((r) => r.team === team && Math.hypot(r.cx - x, r.cy - y) < 2.5);
    expect(near(100, 100, 100)).toBe(true);
    expect(near(121, 100, 100)).toBe(true);
    expect(near(200, 200, 200)).toBe(true);
    expect(near(214, 205, 200)).toBe(true);
    expect(rings.length).toBe(4);
    // The fully visible ones are still named; the covered ones come back named or as unknown, never as someone else.
    const found = detectChampions(f, refs, 38, rings);
    const at = (id: number) => found.find((c) => c.id === id);
    expect(at(2)).toBeTruthy();
    expect(at(7)).toBeTruthy();
    for (const c of found) if (c.id === 1) expect(Math.hypot(gameToPixel(c.x, c.y, 300).px - 100, gameToPixel(c.x, c.y, 300).py - 100)).toBeLessThan(3);
  });

  it("doesn't count minion dots inside a champion ring, or fountain icons, as minions", () => {
    const size = 300;
    const empty = medianFrame([blank(size, size, 5)]);
    const f = clone(empty);
    stamp(f, icon(1), 150, 150, 11, BLUE);
    paint(f, 150, 150, 2.5, BLUE); // a blue spot in the portrait art
    const fountain = gameToPixel(500, 500, size);
    paint(f, fountain.px, fountain.py, 2.5, BLUE);
    const lane = gameToPixel(pointOnLane("MIDDLE", 0.3).x, pointOnLane("MIDDLE", 0.3).y, size);
    paint(f, lane.px, lane.py, 2.5, RED);
    const dots = detectDots(f, empty, { exclude: findRings(f) });
    expect(dots.length).toBe(1);
    expect(dots[0].team).toBe(200);
  });
});

describe("naming rings by tracking", () => {
  it("names an unmatched ring after the missing champion who was just there, and leaves ties alone", () => {
    const champs: ChampSample[] = [
      { t: 1000, fog: "off", at: [{ id: 6, x: 5000, y: 5000 }, { id: 7, x: 9000, y: 9000 }] },
      { t: 2000, fog: "off", at: [{ id: 7, x: 9000, y: 9000 }], unk: [{ team: 200, x: 5200, y: 5100 }] },
      { t: 3000, fog: "off", at: [{ id: 6, x: 5400, y: 5200 }, { id: 8, x: 5500, y: 5200 }] },
      { t: 4000, fog: "off", at: [], unk: [{ team: 200, x: 5450, y: 5200 }] },
    ];
    const n = nameRings(champs, (id) => (id >= 6 ? 200 : 100));
    expect(n).toBe(1);
    expect(champs[1].at.find((a) => a.id === 6)).toEqual({ id: 6, x: 5200, y: 5100 });
    expect(champs[1].unk).toBeUndefined();
    expect(champs[3].unk?.length).toBe(1);
  });
});
