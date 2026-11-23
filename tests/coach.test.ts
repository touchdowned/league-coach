import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/analysis";
import { coachPlan } from "../src/core/coach";
import { championStats } from "../src/core/champions";
import { buildProfile } from "../src/core/profile";
import { drill, puzzleAt, puzzlesFromGames } from "../src/core/puzzles";
import { death, makeGame, ME } from "./fixtures";

const gankDeaths = [3, 6, 9].map((m) => death(m * 60_000, 3, 8, { assistingParticipantIds: [7] }));

function report(i: number, opts: Parameters<typeof makeGame>[0] = {}) {
  const { match, timeline } = makeGame({ id: `G${i}`, ...opts });
  match.info.gameCreation = 1_700_000_000_000 - i * 3_600_000; // i=0 newest
  return buildReport(match, timeline, ME);
}

describe("coachPlan", () => {
  it("makes the most costly leak the current step", () => {
    const rs = Array.from({ length: 10 }, (_, i) => report(i, { events: gankDeaths, myCsPerMin: 7 }));
    const plan = coachPlan(rs);
    expect(["early_deaths", "ganks"]).toContain(plan.current?.id);
    expect(plan.current?.rules.length).toBeGreaterThan(0);
    expect(plan.current?.evidence).toMatch(/\d/);
    expect(plan.current?.results).toHaveLength(10);
    expect(plan.current?.results.every((r) => r === false)).toBe(true);
  });

  it("moves on once the last 5 games pass", () => {
    // Older 10 games full of ganks, newest 5 clean.
    const rs = [
      ...Array.from({ length: 5 }, (_, i) => report(i, { myCsPerMin: 8, myGpm: 450 })),
      ...Array.from({ length: 10 }, (_, i) => report(i + 5, { events: gankDeaths, myCsPerMin: 8, myGpm: 450 })),
    ];
    const plan = coachPlan(rs);
    const ganks = [...plan.fixed, ...plan.upNext, ...(plan.current ? [plan.current] : [])].find((x) => x.id === "ganks");
    expect(ganks?.fixed).toBe(true);
    expect(plan.current?.id).not.toBe("ganks");
  });

  it("does not praise: verdict with no leaks still gives direction", () => {
    const rs = Array.from({ length: 6 }, (_, i) => report(i, { myCsPerMin: 9, myGpm: 520 }));
    const plan = coachPlan(rs);
    expect(plan.verdict).not.toMatch(/great|nice|amazing/i);
  });
});

describe("mistake reasoning", () => {
  it("explains what the player was likely thinking", () => {
    const r = report(0, { myGpm: 480, events: [death(8 * 60_000, 3, 8, { assistingParticipantIds: [7] })] });
    const g = r.mistakes.find((m) => m.kind === "ganked")!;
    expect(g.read).toMatch(/ahead/);
    expect(g.context.enemyJunglerInvolved).toBe(true);
    expect(g.context.numberOfEnemies).toBe(2);
  });
});

describe("puzzles", () => {
  it("builds one puzzle per death from the player's games", () => {
    const r = report(0, { currentGold: 1600, events: [death(6 * 60_000, 3, 8, { assistingParticipantIds: [7] })] });
    const ps = puzzlesFromGames([r]);
    expect(ps).toHaveLength(1);
    expect(ps[0].options).toContain(ps[0].answer);
    expect(new Set(ps[0].options).size).toBe(ps[0].options.length);
    expect(ps[0].source).toBe("your-game");
  });

  it("is endless and deterministic", () => {
    expect(drill(42)).toEqual(drill(42));
    for (let i = 0; i < 200; i++) {
      const p = puzzleAt(i, [], "Ahri", "MIDDLE");
      expect(p.options).toContain(p.answer);
      expect(p.facts.length).toBeGreaterThan(1);
    }
  });
});

describe("profile and champions", () => {
  it("scores skills around 50 for an average game and flags the weakest", () => {
    const rs = Array.from({ length: 8 }, (_, i) => report(i, { myCsPerMin: 4 }));
    const p = buildProfile(rs)!;
    expect(p.weakest).toBe("farming");
    expect(p.skills.farming).toBeLessThan(40);
  });

  it("groups by champion with matchups", () => {
    const rs = [report(0, { myChamp: "Ahri" }), report(1, { myChamp: "Ahri", win: false }), report(2, { myChamp: "Zed" })];
    const s = championStats(rs);
    expect(s[0].champion).toBe("Ahri");
    expect(s[0].games).toBe(2);
    expect(s[0].winRate).toBe(0.5);
    expect(s[0].matchups[0].opponent).toBe("Champ7");
  });
});
