import { describe, expect, it } from "vitest";
import { matchVod } from "../src/main/vod";
import { gameIdOf } from "../src/main/league";

describe("matchVod", () => {
  const start = Date.parse("2026-11-20T20:00:00");
  const f = (name: string, endOffsetMin: number) => ({ path: `C:/v/${name}`, name, modifiedMs: start + endOffsetMin * 60_000, sizeMb: 500 });

  it("prefers a file named with the game id", () => {
    expect(matchVod([f("a.mp4", 30), f("NA1-5123.mp4", 200)], "NA1_5123", start, 1800)?.name).toBe("NA1-5123.mp4");
  });
  it("otherwise picks the file written closest to when the game ended", () => {
    expect(matchVod([f("a.mp4", 10), f("b.mp4", 31), f("c.mp4", 90)], "NA1_1", start, 1800)?.name).toBe("b.mp4");
  });
  it("returns nothing when no file is close", () => {
    expect(matchVod([f("a.mp4", 200)], "NA1_1", start, 1800)).toBeNull();
  });
  it("extracts the numeric game id", () => {
    expect(gameIdOf("NA1_5123456")).toBe("5123456");
  });
});
