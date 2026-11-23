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
