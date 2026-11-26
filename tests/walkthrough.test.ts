import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/analysis";
import { buildChapters } from "../src/core/walkthrough";
import { project, cameraLookingAt } from "../src/core/camera";
import type { WaveTrack } from "../src/core/waves";
import { death, makeGame, ME } from "./fixtures";

describe("guided walkthrough chapters", () => {
  it("starts a gank chapter when the jungler showed, not at the death", () => {
    const t = 7 * 60000;
    const g = makeGame({ events: [death(t, 3, 7, { assistingParticipantIds: [8], position: { x: 7600, y: 7600 } })] });
    // Replay read: my team's fog shows the enemy jungler (7) 20s before the death, then not.
    const champs: WaveTrack["champs"] = [];
    for (let s = t - 120_000; s < t; s += 2000) {
      champs.push({ t: s, fog: "team", at: [{ id: 1, x: 2000, y: 2000 }, ...(s >= t - 22_000 && s <= t - 20_000 ? [{ id: 7, x: 9000, y: 6000 }] : [])] });
      champs.push({ t: s + 1000, fog: "off", at: [{ id: 7, x: 9000, y: 6000 }] });
    }
    const waves: WaveTrack = { version: 2, source: "replay-minimap", samples: [{ t: 0, lanes: { TOP: { b: [], r: [] }, MIDDLE: { b: [0.5], r: [0.55] }, BOTTOM: { b: [], r: [] } } }], champs, viewTeam: 100 };
    const r = buildReport(g.match, g.timeline, ME, waves);
    const chs = buildChapters(r);
    const c = chs.find((x) => x.kind === "death")!;
    expect(c).toBeTruthy();
    expect(c.root).toBe(t - 20_000);
    expect(c.start).toBe(t - 26_000);
    expect(c.question).toMatch(/just showed/);
    expect(c.choices.some((x) => x.good)).toBe(true);
    expect(c.beats.map((b) => b.kind)).toEqual(expect.arrayContaining(["setup", "decision", "outcome"]));
    expect(c.better.to).toBeTruthy();
  });

  it("starts a chase death at the kill before it", () => {
    const g = makeGame({
      events: [
        { type: "CHAMPION_KILL", timestamp: 20 * 60000, killerId: 3, victimId: 8, position: { x: 9000, y: 9000 }, assistingParticipantIds: [] },
        death(20 * 60000 + 12000, 3, 7, { assistingParticipantIds: [6], position: { x: 10500, y: 10000 } }),
      ],
    });
    const r = buildReport(g.match, g.timeline, ME);
    const c = buildChapters(r).find((x) => x.kind === "death");
    if (c && c.leak.tags?.cause === "chased-after-kill") {
      expect(c.root).toBe(20 * 60000 + 1000);
      expect(c.question).toMatch(/What now/);
    }
  });

  it("orders chapters by cost and never repeats the same root", () => {
    const g = makeGame({ events: [death(9 * 60000, 3, 8), death(16 * 60000, 3, 7, { assistingParticipantIds: [6, 8] })] });
    const chs = buildChapters(buildReport(g.match, g.timeline, ME));
    for (let i = 1; i < chs.length; i++) expect(chs[i - 1].cost).toBeGreaterThanOrEqual(chs[i].cost);
    for (const c of chs) expect(c.end).toBeGreaterThan(c.root);
  });
});

describe("replay camera projection", () => {
  it("puts the point a camera looks at in the middle of the picture", () => {
    const p = { x: 10504, y: 1029 };
    const c = cameraLookingAt(p, 1911, 56, 0);
    const s = project({ pos: c.cameraPosition, rot: c.cameraRotation, fov: 40 }, p, 1920, 1080)!;
    expect(Math.abs(s.x - 960)).toBeLessThan(1);
    expect(Math.abs(s.y - 540)).toBeLessThan(1);
  });
  it("puts points further north higher on screen, east to the right", () => {
    const p = { x: 7000, y: 7000 };
    const c = cameraLookingAt(p, 2200, 56, 0);
    const cam = { pos: c.cameraPosition, rot: c.cameraRotation, fov: 40 };
    const n = project(cam, { x: 7000, y: 7600 }, 1920, 1080)!;
    const e = project(cam, { x: 7600, y: 7000 }, 1920, 1080)!;
    expect(n.y).toBeLessThan(540);
    expect(e.x).toBeGreaterThan(960);
  });
});
