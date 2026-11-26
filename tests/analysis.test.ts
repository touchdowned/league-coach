import { describe, expect, it } from "vitest";
import { buildReport, computeMetrics, findMistakes, isDeepInEnemyHalf } from "../src/core/analysis";
import { death, makeGame, ME } from "./fixtures";

// In the fixture I'm mid (participant 3, blue). Lane opponent is 8, enemy jungler is 7.
describe("computeMetrics", () => {
  it("computes laning numbers against the lane opponent", () => {
    const { match, timeline } = makeGame({ myGpm: 450, oppGpm: 400, myCsPerMin: 7 });
    const m = computeMetrics(match, timeline, ME);
    expect(m.role).toBe("MIDDLE");
    expect(m.opponentChampion).toBe("Champ7");
    expect(m.cs10).toBe(70);
    expect(m.goldDiff10).toBe(500);
    expect(m.goldDiff15).toBe(750);
    expect(m.csPerMin).toBeCloseTo(7);
    expect(m.killParticipation).toBeCloseTo(11 / 17);
  });

  it("counts only deaths before 14 minutes as laning deaths", () => {
    const { match, timeline } = makeGame({ events: [death(5 * 60_000, 3, 8), death(20 * 60_000, 3, 8)] });
    expect(computeMetrics(match, timeline, ME).deathsPre14).toBe(1);
  });
});

describe("findMistakes", () => {
  it("flags a jungle gank during laning", () => {
    const { match, timeline } = makeGame({ events: [death(6 * 60_000, 3, 8, { assistingParticipantIds: [7] })] });
    const kinds = findMistakes(match, timeline, ME).map((m) => m.kind);
    expect(kinds).toContain("ganked");
  });

  it("flags a death deep in enemy territory", () => {
    const { match, timeline } = makeGame({ events: [death(18 * 60_000, 3, 9, { position: { x: 11000, y: 11000 } })] });
    expect(findMistakes(match, timeline, ME).map((m) => m.kind)).toContain("overextended");
  });

  it("flags shutdowns, unspent gold and thrown leads", () => {
    const { match, timeline } = makeGame({
      myGpm: 500,
      oppGpm: 400,
      currentGold: 1800,
      events: [death(9 * 60_000 + 30_000, 3, 8, { shutdownBounty: 450 })],
    });
    const kinds = findMistakes(match, timeline, ME).map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(["gave_shutdown", "died_with_gold", "threw_lead"]));
  });

  it("links a death to an enemy objective that followed", () => {
    const { match, timeline } = makeGame({
      events: [
        death(20 * 60_000, 3, 8),
        { type: "ELITE_MONSTER_KILL", timestamp: 20 * 60_000 + 45_000, killerTeamId: 200, monsterType: "BARON_NASHOR" },
      ],
    });
    const top = findMistakes(match, timeline, ME)[0];
    expect(top.kind).toBe("died_before_objective");
    expect(top.severity).toBe(9);
  });

  it("does not flag objectives taken by my own team", () => {
    const { match, timeline } = makeGame({
      events: [death(20 * 60_000, 3, 8), { type: "ELITE_MONSTER_KILL", timestamp: 20 * 60_000 + 30_000, killerTeamId: 100, monsterType: "DRAGON" }],
    });
    expect(findMistakes(match, timeline, ME)).toHaveLength(0);
  });

  it("ignores other players' deaths", () => {
    const { match, timeline } = makeGame({ events: [death(5 * 60_000, 8, 3)] });
    expect(findMistakes(match, timeline, ME)).toHaveLength(0);
  });
});

describe("isDeepInEnemyHalf", () => {
  it("depends on which side you're on", () => {
    expect(isDeepInEnemyHalf(100, { x: 12000, y: 12000 })).toBe(true);
    expect(isDeepInEnemyHalf(200, { x: 12000, y: 12000 })).toBe(false);
    expect(isDeepInEnemyHalf(200, { x: 2000, y: 2000 })).toBe(true);
    expect(isDeepInEnemyHalf(100, { x: 7400, y: 7400 })).toBe(false);
  });
});

describe("buildReport", () => {
  it("grades a clean, winning game well and keeps at most 5 mistakes", () => {
    const clean = buildReport(...Object.values(makeGame({ myGpm: 480, myCsPerMin: 8 })) as [any, any], ME);
    expect(["S", "A"]).toContain(clean.grade);
    expect(clean.strengths.length).toBeGreaterThan(0);

    const deaths = [2, 4, 6, 8, 10, 12].map((m) => death(m * 60_000, 3, 8, { assistingParticipantIds: [7] }));
    const bad = buildReport(...Object.values(makeGame({ win: false, events: deaths, myCsPerMin: 4 })) as [any, any], ME);
    expect(bad.mistakes.length).toBe(5);
    expect(bad.focus).toMatch(/jungler/);
    expect(["C", "D"]).toContain(bad.grade);
  });
});
