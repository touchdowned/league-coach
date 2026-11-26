import { describe, expect, it } from "vitest";
import { champPosAt, type ChampSample } from "../src/core/waves";

describe("champion position at a replay time", () => {
  const champs: ChampSample[] = [
    { t: 10_000, fog: "off", at: [{ id: 3, x: 1000, y: 2000 }] },
    { t: 10_500, fog: "team", at: [{ id: 3, x: 9000, y: 9000 }] }, // your fog: not used
    { t: 11_000, fog: "off", at: [{ id: 3, x: 1400, y: 1800 }, { id: 5, x: 7000, y: 7000 }] },
    { t: 30_000, fog: "off", at: [{ id: 3, x: 5000, y: 5000 }] },
  ];
  it("interpolates between the reads around the time", () => {
    expect(champPosAt(champs, 3, 10_250)).toEqual({ x: 1100, y: 1950 });
    expect(champPosAt(champs, 3, 11_000)).toEqual({ x: 1400, y: 1800 });
  });
  it("walks across a short gap in the reads", () => {
    const gap: ChampSample[] = [
      { t: 0, fog: "off", at: [{ id: 3, x: 0, y: 0 }] },
      { t: 10_000, fog: "off", at: [{ id: 3, x: 1000, y: 500 }] },
    ];
    expect(champPosAt(gap, 3, 5_000)).toEqual({ x: 500, y: 250 });
  });
  it("takes the one read in range when the other side is too far, and nothing past the gap", () => {
    expect(champPosAt(champs, 3, 13_500)).toEqual({ x: 1400, y: 1800 }); // next read is 16.5 s away
    expect(champPosAt(champs, 3, 15_500)).toBeUndefined();
    expect(champPosAt(champs, 5, 10_000)).toEqual({ x: 7000, y: 7000 });
    expect(champPosAt(champs, 9, 10_000)).toBeUndefined();
  });
});
