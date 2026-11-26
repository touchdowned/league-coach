import { describe, expect, it } from "vitest";
import { FOUNTAINS } from "../src/core/minimap";
import { waveSpawns } from "../src/core/rules";
import { lint, synthesize, type Finding } from "../src/core/synth";
import type { MatchDto, TimelineDto, TimelineEvent } from "../src/core/types";
import { laneLength, pointOnLane, type ChampSample, type WaveSample } from "../src/core/waves";

const L = laneLength("MIDDLE");

/** Red waves in mid: each walks out, stops at the middle and dies `life` ms after spawning. */
function redWaves(from: number, to: number, life: number): WaveSample[] {
  const out: WaveSample[] = [];
  for (let t = from; t <= to; t += 500) {
    const r: number[] = [];
    for (const w of waveSpawns(to)) {
      if (t < w.t || t >= w.t + life) continue;
      const u = Math.min(L / 2, ((t - w.t) / 1000) * 325);
      for (let k = 0; k < 6 + w.cannon; k++) r.push(1 - (u + k * 40) / L);
    }
    out.push({ t, lanes: { TOP: { b: [], r: [] }, MIDDLE: { b: [], r }, BOTTOM: { b: [], r: [] } } });
  }
  return out;
}

describe("coaching synthesizer", () => {
  const mid = pointOnLane("MIDDLE", 0.5);
  const stay = (from: number, to: number, p: { x: number; y: number }) => Array.from({ length: Math.floor((to - from) / 500) + 1 }, (_, k) => ({ t: from + k * 500, ...p }));
  // In mid until 1:40, recalls (fountain 1:48.5 to 1:58), back in mid at 2:45.
  const path = [...stay(60_000, 100_000, mid), ...stay(108_500, 118_000, FOUNTAINS[0]), ...stay(165_000, 300_000, mid)];
  const champs: ChampSample[] = path.map((p) => ({ t: p.t, fog: "off", at: [{ id: 1, x: p.x, y: p.y }] }));
  const match = { metadata: { matchId: "T", participants: [] }, info: { gameCreation: 0, gameDuration: 300, queueId: 420, gameVersion: "16.23", participants: [{ participantId: 1, teamId: 100, teamPosition: "MIDDLE", championName: "AurelionSol" }, { participantId: 6, teamId: 200, teamPosition: "JUNGLE", championName: "LeeSin" }] } } as unknown as MatchDto;
  const frames = [0, 60_000, 120_000, 180_000, 240_000, 300_000].map((timestamp) => ({ timestamp, participantFrames: { "1": { participantId: 1, totalGold: 500 + timestamp / 200, currentGold: 100, xp: 0, level: 1, minionsKilled: 0, jungleMinionsKilled: 0, position: mid } }, events: [] as TimelineEvent[] }));
  const timeline = { metadata: { matchId: "T" }, info: { frameInterval: 60_000, frames } } as unknown as TimelineDto;
  const input = { track: { version: 2 as const, source: "replay-minimap" as const, samples: redWaves(60_000, 300_000, 50_000), champs }, match, timeline, id: 1, items: {} };

  it("writes a recall up with its timestamp, proof, counted cost, a computed fix and a replay jump", () => {
    const { findings, rejected } = synthesize(input);
    expect(rejected).toEqual([]);
    const f = findings.find((x) => x.kind === "recall")!;
    expect(f.time).toBe("1:40");
    expect(f.title).toContain("cannon wave 3");
    expect(f.minions).toBe(13);
    expect(f.xp).toBe(633);
    expect(f.gold).toBe(255);
    expect(f.proof.join(" ")).toContain("13 enemy minions died in mid");
    expect(f.proof.join(" ")).toContain("wave 2 (spawned 1:00)");
    // A wave dies every 30 s here, so no start time saves a 65 s trip: the fix is about the trip's length.
    expect(f.fix).toContain("No start time within 45 s loses fewer than 12 minions");
    expect(f.fix).toContain("the walk back took 47 s from leaving the fountain at 1:58");
    expect(f.jump).toEqual({ t: 94_000, follow: "AurelionSol" });
    expect(lint(f)).toEqual([]);
  });

  it("rejects generic advice and items without numbers", () => {
    const base: Finding = { id: "x", kind: "recall", t: 0, time: "1:40", title: "t", proof: ["13 minions died"], cost: "279 XP", fix: "Recall at 1:21", gold: 0, xp: 0, minions: 0, jump: { t: 0, follow: "Azir" }, score: 0 };
    expect(lint(base)).toEqual([]);
    expect(lint({ ...base, fix: "Ward more and play safer around 3:00" }).length).toBe(2);
    expect(lint({ ...base, fix: "Watch the map" }).some((w) => w.includes("fix without a number"))).toBe(true);
    expect(lint({ ...base, proof: ["You were too far forward"] })).toContain("a proof line without a number");
    expect(lint({ ...base, time: "early" })).toContain("no MM:SS timestamp");
  });
});
