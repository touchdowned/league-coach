import { describe, expect, it } from "vitest";
import { FOUNTAINS } from "../src/core/minimap";
import { objectiveWindows, waveSpawns, waveGold, waveXp } from "../src/core/rules";
import { baseVisits, deathsOf, checkBaseVisits, checkWaveSchedule, countRatio, freshWaves, laneLedger, lostBetween, trips, type Fix } from "../src/core/tempo";
import type { MatchDto, TimelineDto, TimelineEvent } from "../src/core/types";
import { laneLength, pointOnLane, type ChampSample, type WaveSample, type WaveTrack } from "../src/core/waves";

const L = laneLength("MIDDLE");
const blueBase = FOUNTAINS[0];

describe("wave schedule (2026)", () => {
  it("spawns at 0:30, every 30 s, with a cannon on every third wave", () => {
    const w = waveSpawns(5 * 60_000);
    expect(w.slice(0, 4).map((x) => x.t)).toEqual([30_000, 60_000, 90_000, 120_000]);
    expect(w.filter((x) => x.cannon).map((x) => x.index)).toEqual([3, 6, 9]);
    expect(waveXp(w[0])).toBe(279);
    expect(waveGold(w[2])).toBe(102 + 51);
    const late = waveSpawns(15 * 60_000);
    expect(late[late.length - 1].t - late[late.length - 2].t).toBe(25_000);
  });

  it("chains dragon spawns off the kills", () => {
    const ev = [
      { type: "ELITE_MONSTER_KILL", timestamp: 6 * 60_000, monsterType: "DRAGON", killerTeamId: 200 },
      { type: "ELITE_MONSTER_KILL", timestamp: 8 * 60_000 + 20_000, monsterType: "HORDE", killerTeamId: 100 },
    ];
    const o = objectiveWindows(ev, 12 * 60_000);
    expect(o.filter((x) => x.type === "DRAGON").map((x) => [x.spawn, x.taken, x.by])).toEqual([[300_000, 360_000, 200], [660_000, null, null]]);
    expect(o.find((x) => x.type === "HORDE")).toMatchObject({ spawn: 480_000, taken: 500_000, by: 100 });
    expect(o.some((x) => x.type === "BARON_NASHOR")).toBe(false);
  });
});

/** Red minions in mid: every wave lives `life` ms after its spawn, then dies at once. */
function redWaves(from: number, to: number, life: number, hidden: (t: number, spawn: number) => boolean = () => false, read = 7): WaveSample[] {
  const waves = waveSpawns(to);
  const out: WaveSample[] = [];
  for (let t = from; t <= to; t += 500) {
    const r: number[] = [];
    for (const w of waves) {
      if (t < w.t || t >= w.t + life || hidden(t, w.t)) continue;
      // Walks out of the red base at 325 units a second, stops mid-lane.
      const u = Math.min(L / 2, ((t - w.t) / 1000) * 325);
      for (let k = 0; k < Math.min(read, 6 + w.cannon); k++) r.push(1 - (u + k * 40) / L);
    }
    out.push({ t, lanes: { TOP: { b: [], r: [] }, MIDDLE: { b: [], r }, BOTTOM: { b: [], r: [] } } });
  }
  return out;
}
const track = (samples: WaveSample[], champs: ChampSample[] = []): WaveTrack => ({ version: 2, source: "replay-minimap", samples, champs });

describe("minion ledger", () => {
  it("counts what died between two moments, by wave", () => {
    const l = laneLedger(track(redWaves(60_000, 300_000, 50_000)), "MIDDLE", 200, 1);
    const loss = lostBetween(l, 100_000, 160_000);
    // Waves 2 (spawned 1:00) and 3 (1:30, cannon) died at 1:50 and 2:20.
    expect(loss.minions).toBe(13);
    expect(loss.waves).toBe(2);
    expect(loss.xp).toBe(279 + 354);
    expect(loss.gold).toBe(102 + 153);
    expect(loss.cannonWaves).toEqual([3]);
    expect(loss.byWave.map((w) => w.wave)).toEqual([2, 3]);
    expect(lostBetween(l, 112_000, 138_000).minions).toBe(0);
  });

  it("doesn't count a wave hidden for a few seconds as dead", () => {
    // Every wave is unread for its first 8 s (under the base's structure icons).
    const l = laneLedger(track(redWaves(60_000, 300_000, 50_000, (t, s) => t - s < 8000)), "MIDDLE", 200, 1);
    expect(lostBetween(l, 112_000, 138_000).minions).toBe(0);
    expect(lostBetween(l, 100_000, 160_000).minions).toBe(13);
  });

  it("measures the read ratio on fresh waves and corrects with it", () => {
    // The scan reads only 4 of every wave's minions.
    const thin = redWaves(60_000, 300_000, 50_000, () => false, 4);
    const t = track(thin);
    const ratio = countRatio(t);
    expect(ratio).toBeGreaterThan(0.55);
    expect(ratio).toBeLessThan(0.7);
    const mid = freshWaves(t, 300_000).filter((r) => r.lane === "MIDDLE" && r.team === 200);
    expect(mid.length).toBeGreaterThan(5);
    expect(mid.every((r) => r.got === 4 && r.delay !== null && r.delay <= 1000)).toBe(true);
    // The other lanes are empty here, so the schedule check as a whole fails: nothing arrived.
    expect(checkWaveSchedule(t, 300_000).pass).toBe(false);
    const loss = lostBetween(laneLedger(t, "MIDDLE", 200), 100_000, 160_000);
    expect(Math.abs(loss.minions - 13)).toBeLessThan(1.5);
  });
});

describe("base visits", () => {
  const lane = pointOnLane("MIDDLE", 0.45);
  const fixes = (spec: [number, number, { x: number; y: number }][]): Fix[] => spec.flatMap(([from, to, p]) => Array.from({ length: Math.floor((to - from) / 500) + 1 }, (_, k) => ({ t: from + k * 500, ...p })));

  it("tells a recall from a death and a walk", () => {
    const near = { x: blueBase.x + 1300, y: blueBase.y + 1300 };
    const path = fixes([
      [60_000, 120_000, lane],
      [120_500, 130_000, blueBase], // recall: in lane at 2:00, in the fountain half a second later
      [150_000, 200_000, lane],
      [230_000, 240_000, blueBase], // died at 3:25, respawned
      [260_000, 280_000, lane],
      [301_000, 305_000, near], // 21 s later: time enough to have walked
      [305_500, 312_000, blueBase], // walked in from just outside
      [313_000, 330_000, near],
    ]);
    const v = baseVisits(1, path, 100, [{ t: 205_000, at: lane }]);
    expect(v.map((x) => x.kind)).toEqual(["recall", "death", "walk"]);
    expect(v[0]).toMatchObject({ start: 112_500, arrive: 120_500, leave: 130_000, channelSeen: true });
    expect(v[1]).toMatchObject({ start: 205_000, arrive: 230_000 });
    expect(v[2]).toMatchObject({ arrive: 305_500, leave: 312_000, teleportedOut: false });
  });

  it("costs a recall in waves, and flags more than a wave and a half", () => {
    // Red waves each die 50 s after spawning; the player leaves mid at 1:40 and is back at 2:45.
    const samples = redWaves(60_000, 300_000, 50_000);
    const path = fixes([
      [60_000, 100_000, pointOnLane("MIDDLE", 0.5)],
      [108_500, 118_000, blueBase],
      [165_000, 300_000, pointOnLane("MIDDLE", 0.5)],
    ]);
    const champs: ChampSample[] = path.map((p) => ({ t: p.t, fog: "off", at: [{ id: 1, x: p.x, y: p.y }] }));
    const match = { metadata: { matchId: "T", participants: [] }, info: { gameCreation: 0, gameDuration: 300, queueId: 420, gameVersion: "16.23", participants: [{ participantId: 1, teamId: 100, teamPosition: "MIDDLE", championName: "Azir" }] } } as unknown as MatchDto;
    const buy: TimelineEvent = { type: "ITEM_PURCHASED", timestamp: 110_000, participantId: 1, itemId: 1001 };
    const timeline = { metadata: { matchId: "T" }, info: { frameInterval: 60_000, frames: [{ timestamp: 0, participantFrames: {}, events: [buy] }] } } as unknown as TimelineDto;
    const t = track(samples, champs);
    const [trip] = trips({ track: t, match, timeline, id: 1 });
    expect(trip.kind).toBe("recall");
    expect(trip.away).toBe(100_000);
    expect(trip.back).toBe(165_000);
    // Waves 2 and 3 died at 1:50 and 2:20 while away.
    expect(trip.loss!.waves).toBe(2);
    expect(trip.loss!.cannonWaves).toEqual([3]);
    expect(trip.flags).toEqual(["lost_waves", "missed_cannon"]);
    expect(checkBaseVisits(t, match, timeline, 300_000)).toMatchObject({ pass: true, n: 1 });
  });
});

describe("base visits the scan can't see", () => {
  const lane = pointOnLane("MIDDLE", 0.45);
  const out = { x: blueBase.x + 1500, y: blueBase.y + 1500 };
  const fixes = (spec: [number, number, { x: number; y: number }][]): Fix[] => spec.flatMap(([from, to, p]) => Array.from({ length: Math.floor((to - from) / 500) + 1 }, (_, k) => ({ t: from + k * 500, ...p })));

  it("finds a recall with no read in the fountain, from the jump to just outside it", () => {
    // In lane to 2:00, unread for 6 s (portrait cut off in the minimap corner), then walking out of base.
    const v = baseVisits(1, fixes([[60_000, 120_000, lane], [126_000, 128_000, out], [140_000, 200_000, lane]]), 100, []);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ kind: "recall", since: 120_000, arrive: 120_500 });
    expect(v[0].leave!).toBeGreaterThan(121_000);
    expect(v[0].leave!).toBeLessThanOrEqual(126_000);
  });

  it("calls the first time in base after a death the respawn, whatever was read in between", () => {
    // Dies at 3:20; a stray filled-in read in lane at 3:30; first real read walking out of base at 3:46.
    const path = [...fixes([[60_000, 199_500, lane]]), { t: 210_000, ...lane, inferred: true }, ...fixes([[226_000, 228_000, out], [240_000, 260_000, lane]])];
    const v = baseVisits(1, path, 100, [{ t: 200_000, at: lane }]);
    expect(v.map((x) => x.kind)).toEqual(["death"]);
    expect(v[0].start).toBe(200_000);
  });

  it("reads the respawn from the health bar coming back, and drops what was read while dead", () => {
    const ev = [{ type: "CHAMPION_KILL", timestamp: 200_000, victimId: 1, killerId: 6, position: lane }] as unknown as TimelineEvent[];
    const hp = (t: number, v: number | null) => ({ t, hp: [v, null, null, null, null, null, null, null, null, null], res: [] });
    // Bar empty from the death, unread for a while, full again at 3:42. A junk read above 2% two seconds after the death doesn't count.
    const hud = [hp(199_000, 30), hp(201_000, 0), hp(202_000, 40), hp(210_000, null), hp(221_000, 0), hp(222_000, 100), hp(223_000, 100)];
    const d = deathsOf(ev, 1, { samples: [], champs: [], hud } as unknown as WaveTrack);
    expect(d).toHaveLength(1);
    expect(d[0].respawn).toBe(222_000);
    // Reads in lane at 3:26 to 3:30 (the corpse, or a portrait fragment) must not make this a recall from lane.
    const path = [...fixes([[60_000, 199_500, lane], [206_000, 210_000, lane], [226_000, 228_000, out], [240_000, 260_000, lane]])];
    const v = baseVisits(1, path, 100, d);
    expect(v.map((x) => x.kind)).toEqual(["death"]);
    expect(v[0].arrive).toBe(222_000);
  });
});
