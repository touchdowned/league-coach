import { describe, expect, it } from "vitest";
import { buildReport, findOpponent, findPlayer } from "../src/core/analysis";
import { atMinute, laneStats, summarize, type LaneStats } from "../src/core/benchmark";
import { recallWindows, type Leak } from "../src/core/engine";
import { findHabits } from "../src/core/habits";
import { buildTrack } from "../src/core/track";
import type { GameReport, TimelineEvent } from "../src/core/types";
import type { WaveSample, WaveTrack } from "../src/core/waves";
import { death, makeGame, ME } from "./fixtures";

const buy = (t: number): TimelineEvent => ({ type: "ITEM_PURCHASED", timestamp: t, participantId: 3, itemId: 1036 });

describe("recall windows", () => {
  it("finds every crash with item gold, and which ones you took", () => {
    // Your mid wave crashes their tower at 4:00-4:20 and 7:00-7:20; you recall at 7:10.
    const samples: WaveSample[] = [];
    for (let t = 65_000; t <= 14 * 60_000; t += 2000) {
      const crash = (t >= 240_000 && t <= 260_000) || (t >= 420_000 && t <= 440_000);
      samples.push({ t, lanes: { TOP: { b: [], r: [] }, MIDDLE: crash ? { b: [0.64, 0.65, 0.65, 0.66], r: [0.66] } : { b: [0.5], r: [0.5] }, BOTTOM: { b: [], r: [] } } });
    }
    const waves: WaveTrack = { version: 1, source: "replay-minimap", samples };
    const g = makeGame({ currentGold: 1250, events: [buy(7 * 60_000 + 25_000)] });
    const me = findPlayer(g.match, ME);
    const w = recallWindows(g.match, g.timeline, buildTrack(g.match, g.timeline), me, waves);
    expect(w.map((x) => [Math.round(x.t / 1000), x.taken])).toEqual([[241, false], [421, true]]);
  });
});

describe("Master+ benchmark", () => {
  it("reads laning numbers from a timeline", () => {
    const g = makeGame({ events: [buy(5 * 60_000 + 40_000), buy(9 * 60_000), death(11 * 60_000, 3, 8)] });
    const s = laneStats(g.match, g.timeline, 3)!;
    expect(s.cs10).toBe(70);
    expect(s.backs14).toBe(2);
    expect(s.firstBack!.t).toBe(5 * 60_000 + 40_000);
    expect(s.deaths14).toBe(1);
    expect(s.curve[6].backs).toBe(1);
  });

  it("uses the champion once there are 5 games of it, the role before that", () => {
    const base = laneStats(makeGame().match, makeGame().timeline, 3)!;
    const mk = (champion: string, cs10: number): LaneStats => ({ ...base, champion, cs10 });
    const four = [mk("Ahri", 90), mk("Ahri", 90), mk("Ahri", 90), mk("Ahri", 90), mk("Syndra", 60), mk("Viktor", 60), mk("Viktor", 60)];
    expect(summarize(four, "MIDDLE", "Ahri")!.champion).toBeNull();
    const five = [...four, mk("Ahri", 90)];
    const s = summarize(five, "MIDDLE", "Ahri")!;
    expect(s.champion).toBe("Ahri");
    expect(s.med.cs10).toBe(90);
    expect(atMinute(s, base, 6 * 60_000)).toMatch(/^At 6:00, Master\+ Ahri \(median of 5 games\)/);
  });
});

describe("habits across games", () => {
  const leak = (cause: string, area: string, cost = 500, t = 8 * 60_000, vision?: "seen" | "unseen"): Leak => ({
    kind: "death",
    t,
    cost,
    costParts: [],
    title: "",
    doing: "",
    evidence: [],
    nextTime: "",
    focus: null,
    tags: { cause, area, phase: t < 14 * 60_000 ? "early" : "mid", vision },
  });
  const game = (i: number, leaks: Leak[]) => {
    const g = makeGame({ id: `NA1_${i}` });
    const r = buildReport(g.match, g.timeline, ME) as GameReport;
    r.metrics.gameCreation = 1_700_000_000_000 - i * 1e6;
    r.leaks = leaks;
    return r;
  };

  it("links the same death across games, at the most specific level that repeats", () => {
    const games = [
      game(1, [leak("ganked", "top lane", 600, 8 * 60_000, "seen")]),
      game(2, [leak("ganked", "top lane", 500, 7 * 60_000, "unseen"), leak("lost-1v1", "top lane")]),
      game(3, [leak("ganked", "top lane", 700, 9 * 60_000, "seen")]),
      game(4, [leak("caught-alone", "their jungle")]),
    ];
    const h = findHabits(games);
    expect(h).toHaveLength(1);
    expect(h[0].title).toBe("Getting ganked by the jungler, in top lane, before 14:00");
    expect(h[0].detail).toMatch(/^3 of your last 5 deaths, in 3 of your last 4 games/);
    expect(h[0].detail).toMatch(/In the 3 with the replay read, the killer had shown on your minimap first 2 times and came from fog once\./);
    expect(h[0].examples[0].cost).toBe(700);
  });

  it("needs at least two games", () => {
    const games = [game(1, [leak("ganked", "top lane"), leak("ganked", "top lane"), leak("ganked", "top lane")])];
    expect(findHabits(games)).toHaveLength(0);
  });
});

// keep the opponent helper referenced for fixture parity with other tests
void findOpponent;
