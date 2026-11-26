import { describe, expect, it } from "vitest";
import { canReach, nameRings } from "../src/core/vision";
import type { ChampSample } from "../src/core/waves";

// NA1_5686076870, fog off, 10:19.5 to 10:29, blue team (ids 1-5): 1 Heimerdinger (top lane
// all along), 2 Master Yi (bottom lane), 3 Aurelion Sol, 4 Smolder, 5 Leona (dead from 10:27).
// At 10:29 the portrait matcher put Heimerdinger in the bottom lane at score 34, and left his
// real ring in the top lane unnamed. Coordinates are the scan's own.
const teamOf = (id: number) => (id <= 5 ? 100 : 200);
const ids = [1, 2, 3, 4, 5];
const alive = (id: number, t: number) => !(id === 5 && t >= 627_000);
function frames(): ChampSample[] {
  return [
    { t: 619_500, fog: "off", at: [{ id: 3, x: 11075, y: 3714 }, { id: 1, x: 3291, y: 13466 }, { id: 5, x: 13252, y: 3536 }, { id: 2, x: 12918, y: 4063 }, { id: 4, x: 12891, y: 3426 }] },
    { t: 627_000, fog: "off", at: [{ id: 1, x: 1770, y: 13458 }, { id: 3, x: 13772, y: 3661 }] },
    { t: 628_500, fog: "off", at: [{ id: 1, x: 1650, y: 13200 }, { id: 4, x: 10100, y: 4420 }, { id: 3, x: 13650, y: 3600 }] },
    {
      t: 629_000,
      fog: "off",
      at: [{ id: 1, x: 13767, y: 5347, score: 34 }, { id: 3, x: 13592, y: 3543 }],
      unk: [{ team: 100, x: 10148, y: 4443 }, { team: 100, x: 1539, y: 13060 }],
    },
  ];
}

describe("naming rings", () => {
  it("does not give Heimerdinger's top-lane ring to Master Yi at 10:29", () => {
    const c = frames();
    nameRings(c, teamOf, { aliveAt: alive, ids, myTeam: 100 });
    const s = c.find((x) => x.t === 629_000)!;
    const at = (id: number) => s.at.find((a) => a.id === id);
    // The weak bottom-lane match gives way to the ring on Heimerdinger's own track.
    expect(at(1)).toMatchObject({ x: 1539, y: 13060 });
    // Master Yi is nowhere near the top lane.
    expect(at(2)?.x ?? 99999).not.toBe(1539);
    // Smolder is tracked onto the middle ring; Master Yi gets the bottom-lane ring the weak match gave up.
    expect(at(4)).toMatchObject({ x: 10148, y: 4443 });
    expect(at(2)).toMatchObject({ x: 13767, y: 5347 });
  });

  it("elimination only names a champion who could have reached the ring", () => {
    // Walking: 500 units a second plus 600.
    expect(canReach({ x: 12918, y: 4063 }, { x: 1539, y: 13060 }, 9_500, 100)).toBe(false);
    expect(canReach({ x: 12918, y: 4063 }, { x: 13767, y: 5347 }, 9_500, 100)).toBe(true);
    // Their own fountain is always reachable (respawn, recall).
    expect(canReach({ x: 12918, y: 4063 }, { x: 600, y: 700 }, 3_000, 100)).toBe(true);
    // Recall (8 s) then walk 4 s from the blue fountain: 1500 + 2000 units out.
    expect(canReach({ x: 12918, y: 4063 }, { x: 2600, y: 2600 }, 12_000, 100)).toBe(true);
    expect(canReach({ x: 12918, y: 4063 }, { x: 2600, y: 2600 }, 7_000, 100)).toBe(false);
  });

  it("keeps a confident match even far from the track", () => {
    const c = frames();
    delete c[3].at[0].score; // same read, but a confident match: a teleport, say
    nameRings(c, teamOf, { aliveAt: alive, ids, myTeam: 100 });
    expect(c[3].at.find((a) => a.id === 1)).toMatchObject({ x: 13767, y: 5347 });
  });
  it("drops a weak match its champion couldn't have reached (Master Yi, 10:27.5)", () => {
    const c: ChampSample[] = [
      { t: 620_000, fog: "off", at: [{ id: 2, x: 13244, y: 3651, score: 35 }, { id: 1, x: 2100, y: 13500 }] },
      { t: 627_500, fog: "off", at: [{ id: 2, x: 2225, y: 13748, score: 35 }, { id: 1, x: 1729, y: 13359 }] },
    ];
    nameRings(c, teamOf, { aliveAt: alive, ids, myTeam: 100 });
    // 14,600 units in 7.5 s, not via the fountain: not Master Yi; the ring stays unnamed.
    expect(c[1].at.find((a) => a.id === 2)).toBeUndefined();
    expect(c[1].unk).toEqual([{ team: 100, x: 2225, y: 13748 }]);
  });
});
