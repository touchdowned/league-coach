import { describe, expect, it } from "vitest";
import { checkHud, hudStrip, readHud, readHudStrips } from "../src/core/hud";
import { crop, type Frame } from "../src/core/minimap";

/** A 1920x1080 screen (or scaled) with bars painted where the replay draws them. */
function screen(h: number, bars: { side: 100 | 200; slot: number; hp: number; res: number | null }[]): Frame {
  const k = h / 1080;
  const w = Math.round(1920 * k);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([60, 70, 50, 255], i * 4); // the game behind
  const bar = (x0: number, x1: number, y0: number, y1: number, share: number, rgb: number[]) => {
    for (let y = Math.round(y0 * k); y <= Math.round(y1 * k); y++)
      for (let x = Math.round(x0 * k); x <= Math.round(x1 * k); x++) {
        const on = (x - Math.round(x0 * k)) / (Math.round(x1 * k) - Math.round(x0 * k) + 1) < share;
        data.set(on ? [...rgb, 255] : [19, 19, 19, 255], (y * w + x) * 4);
      }
  };
  for (const b of bars) {
    const dx = b.side === 100 ? 0 : 1847 - 31;
    bar(31 + dx, 71 + dx, 207 + 103 * b.slot, 211 + 103 * b.slot, b.hp, [16, 170, 66]);
    bar(31 + dx, b.side === 100 ? 70 : 1887, 215 + 103 * b.slot, 220 + 103 * b.slot, b.res ?? 0, [33, 101, 222]);
  }
  return { w, h, data };
}

describe("replay HUD bars", () => {
  it("reads HP and resource for both sides, as seen at 7:52 (29% HP, 10% mana)", () => {
    const f = screen(1080, [
      { side: 100, slot: 3, hp: 0.29, res: 0.1 },
      { side: 200, slot: 0, hp: 1, res: null },
      { side: 100, slot: 0, hp: 0, res: 0 },
    ]);
    const me = readHud(f, 100, 3);
    expect(Math.abs(me.hp! - 29)).toBeLessThanOrEqual(3);
    expect(Math.abs(me.res! - 10)).toBeLessThanOrEqual(3);
    expect(readHud(f, 200, 0)).toEqual({ hp: 100, res: 0 }); // no resource: an all-grey bar
    expect(readHud(f, 100, 0)).toEqual({ hp: 0, res: 0 }); // dead
    // A slot with no frame drawn isn't a bar.
    expect(readHud(f, 200, 4)).toEqual({ hp: null, res: null });
  });

  it("reads the same from cropped strips and at 1440p", () => {
    for (const h of [1080, 1440]) {
      const f = screen(h, [
        { side: 100, slot: 3, hp: 0.5, res: 0.75 },
        { side: 200, slot: 2, hp: 0.25, res: 1 },
        { side: 100, slot: 4, hp: 0.6, res: 0.4 },
        { side: 200, slot: 4, hp: 1, res: 1 },
      ]);
      const size = { w: f.w, h: f.h };
      const s = readHudStrips(1000, crop(f, hudStrip(100, size)), crop(f, hudStrip(200, size)), size);
      expect(Math.abs(s.hp[3]! - 50)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.res[3]! - 75)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.hp[7]! - 25)).toBeLessThanOrEqual(3);
      expect(s.res[7]).toBe(100);
      expect(s.hp[0]).toBeNull();
      // The fifth frame on each side is inside the strip too.
      expect(Math.abs(s.hp[4]! - 60)).toBeLessThanOrEqual(3);
      expect(Math.abs(s.res[4]! - 40)).toBeLessThanOrEqual(3);
      expect(s.hp[9]).toBe(100);
    }
  });

  it("checks HP against deaths and respawns", () => {
    const hp = (v: number) => [v, ...Array(9).fill(100)];
    const res = Array(10).fill(50);
    const hud = [
      { t: 10_000, hp: hp(40), res },
      { t: 12_000, hp: hp(0), res },
      { t: 30_000, hp: hp(0), res },
      { t: 32_000, hp: hp(100), res },
      { t: 52_000, hp: hp(30), res }, // "dead" by the event below, but the bar says 30
    ];
    const r = checkHud(hud, [{ id: 1, t: 10_500 }, { id: 1, t: 50_500 }], [{ id: 1, t: 30_500 }]);
    expect(r.measured).toMatch(/66.7% \(2\/3\)/);
    expect(r.pass).toBe(false);
    expect(r.detail).toEqual([{ kind: "death", id: 1, t: 50_500, hp: 30 }]);
  });
});

describe("Flash reads", () => {
  it("wants a Flash that goes down to come back after its cooldown", async () => {
    const { checkFlash } = await import("../src/core/hud");
    const at = (t: number, v: boolean | null) => ({ t, hp: [], res: [], flash: [v, null, null, null, null, null, null, null, null, null] });
    const ok = [at(0, true), at(10_000, false), at(200_000, false), at(305_000, true)];
    expect(checkFlash(ok).measured).toMatch(/100% \(1\/1\)/);
    // Back up after 60 s: not a Flash cooldown.
    const bad = [at(0, true), at(10_000, false), at(70_000, true)];
    expect(checkFlash(bad).pass).toBe(false);
    // A one-read blip doesn't count either way.
    expect(checkFlash([at(0, true), at(1000, false), at(1500, true)]).n).toBe(0);
  });
});
