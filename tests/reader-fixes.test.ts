import { describe, expect, it } from "vitest";
import { detectDots, findRings, Frame, gameToPixel, STRUCTURES, type Dot } from "../src/core/minimap";
import { dropStaticDots } from "../src/core/waves";

// A flat dull map, 247 px like the replay's minimap.
function blank(w = 247, h = 247): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 60;
    data[i * 4 + 1] = 80;
    data[i * 4 + 2] = 50;
    data[i * 4 + 3] = 255;
  }
  return { w, h, data };
}
function paint(f: Frame, cx: number, cy: number, r: number, rgb: [number, number, number], ring = false) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r || (ring && d < r - 2) || x < 0 || y < 0 || x >= f.w || y >= f.h) continue;
      const i = (y * f.w + x) * 4;
      [f.data[i], f.data[i + 1], f.data[i + 2]] = rgb;
    }
}
const clone = (f: Frame): Frame => ({ ...f, data: new Uint8ClampedArray(f.data) });
const BLUE: [number, number, number] = [70, 150, 255];
const RED: [number, number, number] = [240, 60, 60];
const GREY: [number, number, number] = [120, 110, 120];

describe("reader fixes", () => {
  it("reads a champion ring cut off by the minimap corner at the fountain spot", () => {
    const bg = blank();
    const f = clone(bg);
    // A normal ring elsewhere sets the ring size (12.5 px).
    paint(f, 120, 120, 12.5, BLUE, true);
    paint(f, 120, 120, 10.5, GREY);
    // Blue fountain spot: centre just inside the bottom-left corner, three quarters cut off.
    paint(f, 4, 243, 12.5, BLUE, true);
    paint(f, 4, 243, 10.5, GREY);
    const rings = findRings(f, bg);
    const corner = rings.find((r) => r.cx < 20 && r.cy > 225);
    expect(corner).toBeTruthy();
    expect(corner!.team).toBe(100);
    expect(Math.hypot(corner!.cx - 4, corner!.cy - 243)).toBeLessThan(3);
    // Red's fountain is the top-right corner: the same cut-off ring there is read too.
    const g = clone(bg);
    paint(g, 120, 120, 12.5, BLUE, true);
    paint(g, 243, 4, 12.5, RED, true);
    paint(g, 243, 4, 10.5, GREY);
    const red = findRings(g, bg).find((r) => r.cx > 225 && r.cy < 20);
    expect(red?.team).toBe(200);
  });

  it("reads minions on a fallen tower's spot, and masks them while it stands", () => {
    const tower = gameToPixel(STRUCTURES[3].x, STRUCTURES[3].y, 247); // blue mid outer
    const bg = blank();
    paint(bg, tower.px, tower.py, 6, BLUE); // the icon on the empty map
    // Standing: a minion beside it is under the mask.
    const standing = clone(bg);
    paint(standing, tower.px + 3, tower.py, 1.8, RED);
    expect(detectDots(standing, bg).filter((d) => d.team === 200)).toHaveLength(0);
    // Fallen: the icon is gone from the frame, and the minion there is read.
    const fallen = blank();
    paint(fallen, tower.px + 3, tower.py, 1.8, RED);
    expect(detectDots(fallen, bg).filter((d) => d.team === 200)).toHaveLength(1);
  });

  it("drops a blob that doesn't move for 10 s away from fights and structures", () => {
    const disc: Dot = { team: 100, x: 6800, y: 11200, area: 33, n: 3 }; // a plant's vision disc
    const walking = (t: number): Dot => ({ team: 100, x: 5000 + (t / 1000) * 325 * 0.7, y: 5000 + (t / 1000) * 325 * 0.7, area: 11 });
    const frames = Array.from({ length: 30 }, (_, k) => ({ t: k * 500, dots: [{ ...disc }, walking(k * 500)] }));
    expect(dropStaticDots(frames)).toBe(30);
    expect(frames.every((f) => f.dots.length === 1 && f.dots[0].area === 11)).toBe(true);
    // A wave held in a fight (an enemy dot within 1000 units) stays.
    const held = Array.from({ length: 30 }, (_, k) => ({ t: k * 500, dots: [{ ...disc }, { team: 200 as const, x: 7200, y: 11200, area: 11 }] }));
    expect(dropStaticDots(held)).toBe(0);
    // Minions hitting a tower stand still too: within 1400 units of a structure, kept.
    const siege = Array.from({ length: 30 }, (_, k) => ({ t: k * 500, dots: [{ team: 100 as const, x: STRUCTURES[17].x - 600, y: STRUCTURES[17].y - 600, area: 11 }] }));
    expect(dropStaticDots(siege)).toBe(0);
    // Under 10 s: kept.
    const brief = Array.from({ length: 15 }, (_, k) => ({ t: k * 500, dots: [{ ...disc }] }));
    expect(dropStaticDots(brief)).toBe(0);
  });
});
