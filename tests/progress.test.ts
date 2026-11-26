import { describe, expect, it } from "vitest";
import { applyEvent, DAILY, EMPTY_PROGRESS, levelOf, liveStreak, XP } from "../src/core/progress";

const day = (d: string) => new Date(`${d}T12:00:00`);

describe("levels", () => {
  it("needs 100, then 200, then 300 XP per level", () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(99).level).toBe(1);
    expect(levelOf(100).level).toBe(2);
    expect(levelOf(299).level).toBe(2);
    expect(levelOf(300)).toEqual({ level: 3, into: 0, needed: 300 });
  });
});

describe("applyEvent", () => {
  it("awards XP once per moment and per game", () => {
    let r = applyEvent(EMPTY_PROGRESS, { type: "moment", id: "a:1" }, day("2026-11-20"));
    expect(r.gained).toBe(XP.moment);
    r = applyEvent(r.state, { type: "moment", id: "a:1" }, day("2026-11-20"));
    expect(r.gained).toBe(0);
    r = applyEvent(r.state, { type: "game", matchId: "a" }, day("2026-11-20"));
    expect(r.gained).toBe(XP.gameReviewed);
  });

  it("tracks a daily streak and breaks it after a missed day", () => {
    let s = applyEvent(EMPTY_PROGRESS, { type: "puzzle", right: true }, day("2026-11-20")).state;
    s = applyEvent(s, { type: "puzzle", right: true }, day("2026-11-21")).state;
    expect(s.streak).toBe(2);
    expect(liveStreak(s, day("2026-11-22"))).toBe(2);
    expect(liveStreak(s, day("2026-11-24"))).toBe(0);
    s = applyEvent(s, { type: "puzzle", right: false }, day("2026-11-24")).state;
    expect(s.streak).toBe(1);
    expect(s.bestStreak).toBe(2);
  });

  it("gives a bonus when the daily targets are first completed, and resets each day", () => {
    let s = EMPTY_PROGRESS;
    let bonus = 0;
    for (let i = 0; i < DAILY.moments; i++) s = applyEvent(s, { type: "moment", id: `m${i}` }, day("2026-11-20")).state;
    for (let i = 0; i < DAILY.puzzles; i++) {
      const r = applyEvent(s, { type: "puzzle", right: true }, day("2026-11-20"));
      if (r.dailyJustCompleted) bonus++;
      s = r.state;
    }
    expect(bonus).toBe(1);
    const next = applyEvent(s, { type: "puzzle", right: true }, day("2026-11-21"));
    expect(next.state.today.puzzles).toBe(1);
  });

  it("reports level ups", () => {
    const r = applyEvent({ ...EMPTY_PROGRESS, xp: 95 }, { type: "moment", id: "x" }, day("2026-11-20"));
    expect(r.leveledUp).toBe(true);
  });
});
