import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/core/analysis";
import { recommendRole } from "../src/core/roles";
import { death, makeGame, ME } from "./fixtures";

function games(role: "MIDDLE" | "TOP", n: number, good: boolean) {
  return Array.from({ length: n }, (_, i) => {
    const { match, timeline } = makeGame({
      id: `${role}-${i}`,
      myRole: role,
      win: good ? i % 3 !== 0 : i % 3 === 0,
      myGpm: good ? 450 : 370,
      myCsPerMin: good ? 7.5 : 5.5,
      events: good ? [] : [death(5 * 60_000, role === "TOP" ? 1 : 3, role === "TOP" ? 6 : 8)],
    });
    return computeMetrics(match, timeline, ME);
  });
}

describe("recommendRole", () => {
  it("picks the role where the player clearly does better", () => {
    const v = recommendRole([...games("MIDDLE", 16, true), ...games("TOP", 16, false)]);
    expect(v.best).toBe("MIDDLE");
    expect(v.summary).toMatch(/Mid looks like your best role/);
    expect(v.summary).not.toMatch(/early read/);
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("warns when there are too few games", () => {
    const v = recommendRole([...games("MIDDLE", 4, false), ...games("TOP", 4, true)]);
    expect(v.best).toBe("TOP");
    expect(v.summary).toMatch(/early read/);
  });

  it("handles no games and a single role", () => {
    expect(recommendRole([]).best).toBeNull();
    expect(recommendRole(games("TOP", 3, true)).summary).toMatch(/another role/);
  });
});
