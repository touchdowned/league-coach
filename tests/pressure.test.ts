import { describe, expect, it } from "vitest";
import { shortRead } from "../src/core/autoread";
import { pressureAt } from "../src/core/pressure";
import { makeGame } from "./fixtures";

const players = (g: ReturnType<typeof makeGame>) => g.match.info.participants.map((p) => ({ id: p.participantId, champion: p.championName, teamId: p.teamId }));
const at = (spots: Record<number, { x: number; y: number }>) => (id: number) => spots[id] ?? null;

describe("pressure on the player", () => {
  it("is blocked when more of them than of you are within 2500 units", () => {
    const g = makeGame({ events: [] });
    const p = pressureAt({ players: players(g), meId: 3, timeline: g.timeline, pos: at({ 3: { x: 7400, y: 7400 }, 6: { x: 8000, y: 8000 }, 7: { x: 8200, y: 7600 }, 8: { x: 7000, y: 8200 }, 1: { x: 1000, y: 1000 } }) }, 20 * 60000)!;
    expect(p.enemies).toHaveLength(3);
    expect(p.allies).toBe(0);
    expect(p.blocked).toBe(true);
    expect(p.line).toMatch(/within 2500 units of you against 1 of your side/);
  });

  it("is not blocked one against one with no lead", () => {
    const g = makeGame({ events: [] });
    const p = pressureAt({ players: players(g), meId: 3, timeline: g.timeline, pos: at({ 3: { x: 7400, y: 7400 }, 8: { x: 8000, y: 8000 } }) }, 8 * 60000)!;
    expect(p.blocked).toBe(false);
  });

  it("is blocked one against one when they are 875 gold ahead", () => {
    const g = makeGame({ events: [] });
    for (const f of g.timeline.info.frames) f.participantFrames["8"].totalGold = f.participantFrames["3"].totalGold + 1500;
    const p = pressureAt({ players: players(g), meId: 3, timeline: g.timeline, pos: at({ 3: { x: 7400, y: 7400 }, 8: { x: 8000, y: 8000 } }) }, 8 * 60000)!;
    expect(p.blocked).toBe(true);
    expect(p.line).toMatch(/1,500 gold ahead/);
  });

  it("is unknown, not empty, when no enemy is placed", () => {
    const g = makeGame({ events: [] });
    expect(pressureAt({ players: players(g), meId: 3, timeline: g.timeline, pos: at({ 3: { x: 7400, y: 7400 } }) }, 8 * 60000)).toBeNull();
  });
});

describe("a replay read that stopped early", () => {
  it("does not count as a read", () => {
    expect(shortRead({ until: 1860_000, lastFrame: 96_000, passes: [{ fog: "off", frames: 127, expectedFrames: 1861 }] })).toMatch(/96 s of 1860 s/);
    expect(shortRead({ until: 1860_000, lastFrame: 1859_000, passes: [{ fog: "off", frames: 127, expectedFrames: 1861 }] })).toMatch(/127 of 1861/);
  });
  it("counts when it covers the game", () => {
    expect(shortRead({ until: 1860_000, lastFrame: 1859_000, passes: [{ fog: "off", frames: 1861, expectedFrames: 1861 }] })).toBeNull();
    expect(shortRead(undefined)).toBeNull();
  });
});
