import { describe, expect, it } from "vitest";
import { buildTrack, describeSpot, gradeGuess, junglePuzzles, positionAt, Track } from "../src/core/track";
import { death, makeGame } from "./fixtures";

const base = (keys: Track["keys"]): Track => ({
  players: [
    { id: 1, champion: "Ahri", teamId: 100, role: "MIDDLE" },
    { id: 7, champion: "Graves", teamId: 200, role: "JUNGLE" },
  ],
  keys,
  kills: [],
  objectives: [],
  durationMs: 30 * 60000,
});

describe("track", () => {
  it("records every champion each minute plus kill spots", () => {
    const g = makeGame({ events: [death(5.5 * 60000, 3, 8, { position: { x: 9000, y: 9000 } })] });
    const t = buildTrack(g.match, g.timeline);
    expect(t.players).toHaveLength(10);
    expect(t.keys[3].some((k) => k.dead && k.x === 9000)).toBe(true);
    expect(t.kills).toHaveLength(1);
  });

  it("interpolates between known points and is less sure far from them", () => {
    const t = base({ 1: [{ t: 0, x: 0, y: 0 }, { t: 60000, x: 6000, y: 0 }], 7: [] });
    const mid = positionAt(t, 1, 30000)!;
    expect(mid.x).toBe(3000);
    expect(mid.certainty).toBeLessThan(0.5);
    expect(positionAt(t, 1, 2000)!.certainty).toBe(1);
  });

  it("holds a dead champion on the death spot until it shows up again", () => {
    const t = base({ 1: [{ t: 0, x: 7000, y: 7000 }, { t: 20000, x: 9000, y: 9000, dead: true }, { t: 60000, x: 500, y: 500 }], 7: [] });
    const p = positionAt(t, 1, 40000)!;
    expect(p).toMatchObject({ x: 9000, y: 9000, dead: true });
  });

  it("makes jungle tracking questions only in laning phase and only when the jungler moved", () => {
    const keys = { 1: [], 7: [] as Track["keys"][number] };
    for (let m = 0; m <= 20; m++) keys[7].push({ t: m * 60000, x: m % 2 ? 4000 : 10000, y: m === 5 ? keys[7][4]?.y ?? 4000 : 4000 });
    keys[7][5] = { ...keys[7][4], t: 5 * 60000 }; // stood still at minute 5
    const qs = junglePuzzles([{ metrics: { matchId: "NA1_1" }, teamId: 100, track: base(keys) }]);
    const mins = qs.map((q) => Math.round(q.t / 60000));
    expect(Math.min(...mins)).toBeGreaterThanOrEqual(3);
    expect(Math.max(...mins)).toBeLessThanOrEqual(14);
    expect(mins).not.toContain(5);
    expect(qs[0].jungler.champion).toBe("Graves");
  });

  it("describes spots in plain words", () => {
    expect(describeSpot({ x: 9866, y: 4414 }, 100)).toBe("in the bottom river by dragon");
    expect(describeSpot({ x: 7400, y: 7400 }, 100)).toBe("in mid lane");
    expect(describeSpot({ x: 3800, y: 7900 }, 100)).toBe("in your top-side jungle");
    expect(describeSpot({ x: 3800, y: 7900 }, 200)).toBe("in their top-side jungle");
    expect(gradeGuess(800).right).toBe(true);
    expect(gradeGuess(6000).right).toBe(false);
  });
});
