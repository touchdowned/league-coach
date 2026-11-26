import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../src/core/types";
import { checkWaveStates, frontSpeed, laneGeometry, laneRead, laneSeries, waveEvents } from "../src/core/wavestate";
import { laneLength, type WaveSample, type WaveTrack } from "../src/core/waves";

const L = laneLength("MIDDLE");
const geo = laneGeometry([]);
/** A mid-lane sample from positions in units from the blue inhibitor. */
const at = (t: number, blue: number[], red: number[]): WaveSample => ({
  t,
  lanes: { TOP: { b: [], r: [] }, MIDDLE: { b: blue.map((u) => u / L), r: red.map((u) => u / L) }, BOTTOM: { b: [], r: [] } },
});
const wave = (lead: number, n: number, dir: 1 | -1) => Array.from({ length: n }, (_, k) => lead - dir * k * 110);
const track = (samples: WaveSample[]): WaveTrack => ({ version: 2, source: "replay-minimap", samples });
const blueTower = geo.towerAt("MIDDLE", 100, 0)! * L;
const redTower = geo.towerAt("MIDDLE", 200, 0)! * L;
const mid = (blueTower + redTower) / 2;

describe("lane reads", () => {
  it("finds the front, the groups and the zone from each side", () => {
    const s = at(1000, wave(mid - 100, 6, 1), wave(mid + 300, 4, -1));
    const b = laneRead(s, "MIDDLE", 100, geo);
    expect(b.contact).toBe(true);
    expect(b.mine).toBe(6);
    expect(b.theirs).toBe(4);
    expect(Math.abs(b.front! - (mid + 100))).toBeLessThan(1);
    expect(b.zone).toBe("middle");
    const r = laneRead(s, "MIDDLE", 200, geo);
    expect(r.mine).toBe(4);
    expect(r.theirs).toBe(6);
    expect(Math.abs(r.front! - (L - mid - 100))).toBeLessThan(1);
    // Reinforcements a full wave behind aren't in the lead group.
    const stacked = at(1000, [...wave(mid, 6, 1), ...wave(mid - 2500, 6, 1)], wave(mid + 300, 3, -1));
    expect(laneRead(stacked, "MIDDLE", 100, geo).mine).toBe(6);
    expect(laneRead(stacked, "MIDDLE", 100, geo).mineAll).toBe(12);
  });

  it("moves the tower line back when the outer tower falls", () => {
    const fall: TimelineEvent = { type: "BUILDING_KILL", timestamp: 600_000, buildingType: "TOWER_BUILDING", towerType: "OUTER_TURRET", laneType: "MID_LANE", teamId: 200 };
    const g = laneGeometry([fall]);
    expect(g.towerAt("MIDDLE", 200, 599_000)).toBeCloseTo(redTower / L, 5);
    expect(g.towerAt("MIDDLE", 200, 601_000)!).toBeGreaterThan(redTower / L);
    // Minions at the old outer tower are no longer "under their tower".
    const s = at(601_000, wave(redTower - 300, 6, 1), []);
    expect(laneRead(s, "MIDDLE", 100, g).zone).not.toBe("their tower");
    expect(laneRead({ ...s, t: 599_000 }, "MIDDLE", 100, g).zone).toBe("their tower");
  });
});

describe("wave events", () => {
  it("reads a fast push, the crash and the bounce", () => {
    const samples: WaveSample[] = [];
    let t = 0;
    // Waves walk in and meet in the middle; blue wipes red's wave in 6 s.
    for (let k = 0; k < 6; k++, t += 500) samples.push(at(t, wave(mid - 1500 + k * 160, 6, 1), wave(mid + 1500 - k * 160, 6, -1)));
    for (let k = 0; k < 12; k++, t += 500) samples.push(at(t, wave(mid - 200, 6, 1), wave(mid + 200, Math.max(1, 6 - k), -1)));
    // Blue's five survivors walk to the red tower at minion speed and sit under it for 12 s.
    let lead = mid - 200;
    while (lead < redTower - 300) {
      samples.push(at(t, wave(lead, 5, 1), []));
      lead += 162;
      t += 500;
    }
    for (let k = 0; k < 24; k++, t += 500) samples.push(at(t, wave(redTower - 300, Math.max(1, 5 - Math.floor(k / 6)), 1), wave(redTower + 600, 6, -1)));
    // The red wave that arrived pushes back across the middle.
    lead = redTower - 300;
    while (lead > mid - 1200) {
      samples.push(at(t, wave(lead - 400, 2, 1), wave(lead, 6, -1)));
      lead -= 120;
      t += 500;
    }
    const ev = waveEvents(laneSeries(track(samples), "MIDDLE", 100, geo), "MIDDLE");
    const kinds = ev.map((e) => `${e.kind}:${e.side}`);
    expect(kinds).toContain("fast push:mine");
    const crash = ev.find((e) => e.kind === "crash" && e.side === "mine")!;
    expect(crash.size).toBe(5);
    expect(crash.value).toBeGreaterThan(8);
    const bounce = ev.find((e) => e.kind === "bounce")!;
    expect(bounce.side).toBe("mine");
    expect(bounce.size).toBe(6);
    // From red's side the same crash is "theirs".
    const red = waveEvents(laneSeries(track(samples), "MIDDLE", 200, geo), "MIDDLE");
    expect(red.some((e) => e.kind === "crash" && e.side === "theirs" && e.size === 5)).toBe(true);
  });

  it("reads a freeze held outside the tower, and not an even lane in the middle", () => {
    const hold = (where: number) => Array.from({ length: 80 }, (_, k) => at(k * 500, wave(where - 150, 3, 1), wave(where + 150, 5, -1)));
    const near = blueTower + 1300;
    const frozen = waveEvents(laneSeries(track(hold(near)), "MIDDLE", 100, geo), "MIDDLE").filter((e) => e.kind === "freeze");
    expect(frozen).toHaveLength(1);
    expect(frozen[0].side).toBe("mine");
    expect(frozen[0].size).toBe(3);
    expect(frozen[0].against).toBe(5);
    expect(Math.abs(frozen[0].value - 1300)).toBeLessThan(50);
    expect(frozen[0].t1 - frozen[0].t0).toBeGreaterThanOrEqual(25_000);
    expect(waveEvents(laneSeries(track(hold(mid)), "MIDDLE", 100, geo), "MIDDLE").filter((e) => e.kind === "freeze")).toHaveLength(0);
  });

  it("reads a slow push: a bigger wave creeping forward", () => {
    const samples = Array.from({ length: 60 }, (_, k) => at(k * 500, wave(mid - 800 + k * 30, 9, 1), wave(mid - 500 + k * 30, 4, -1)));
    const series = laneSeries(track(samples), "MIDDLE", 100, geo);
    expect(Math.round(frontSpeed(series, 40)!)).toBe(60);
    const push = waveEvents(series, "MIDDLE").filter((e) => e.kind === "slow push");
    expect(push).toHaveLength(1);
    expect(push[0]).toMatchObject({ side: "mine", size: 9, against: 4, value: 60 });
  });
});

describe("wave state check", () => {
  it("wants the attackers' wave under the tower before a plate falls", () => {
    const plate = (t: number): TimelineEvent => ({ type: "TURRET_PLATE_DESTROYED", timestamp: t, laneType: "MID_LANE", teamId: 200 });
    const samples = Array.from({ length: 240 }, (_, k) => at(k * 500, k >= 100 && k < 130 ? wave(redTower - 200, 4, 1) : wave(mid, 4, 1), wave(mid + 300, 4, -1)));
    const r = checkWaveStates(track(samples), [plate(62_000), plate(110_000)], 900_000);
    expect(r.measured).toMatch(/50% \(1\/2\)/);
    expect(r.detail).toHaveLength(1);
    expect(r.detail[0]).toMatchObject({ t: 110_000, lane: "MIDDLE", teamId: 200, type: "plate" });
  });
});
