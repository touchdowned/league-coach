import { describe, expect, it } from "vitest";
import { fogDropdownClicks, readFogDropdown, viewOf } from "../src/core/fogview";
import type { Frame } from "../src/core/minimap";

/** A dark screen with some "text" pixels of one colour where the dropdown's value is drawn. */
function screenWith(w: number, h: number, rgb: [number, number, number] | null): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([20, 30, 35, 255], i * 4);
  if (rgb) {
    const k = h / 1080;
    for (let y = Math.round(h - 62 * k); y < Math.round(h - 55 * k); y++)
      for (let x = Math.round(140 * k); x < Math.round(160 * k); x += 2) data.set([...rgb, 255], (y * w + x) * 4);
  }
  return { w, h, data };
}

describe("replay fog of war view", () => {
  it("clicks the dropdown, then the option, anchored bottom-left and scaled with height", () => {
    expect(fogDropdownClicks("Blue", { w: 1920, h: 1080 })).toEqual([{ x: 220, y: 1022 }, { x: 185, y: 951 }]);
    expect(fogDropdownClicks("All", { w: 1920, h: 1080 })[1]).toEqual({ x: 180, y: 998 });
    // 2560x1440: everything 4/3 the size, same corner.
    expect(fogDropdownClicks("Red", { w: 2560, h: 1440 })).toEqual([{ x: 293, y: 1363 }, { x: 245, y: 1299 }]);
  });

  it("reads the selected value from its text colour", () => {
    expect(readFogDropdown(screenWith(1920, 1080, [220, 220, 210]))).toBe("All");
    expect(readFogDropdown(screenWith(1920, 1080, [70, 170, 220]))).toBe("Blue");
    expect(readFogDropdown(screenWith(1920, 1080, [200, 40, 40]))).toBe("Red");
    expect(readFogDropdown(screenWith(1920, 1080, null))).toBeNull();
  });

  it("picks the dropdown value for a team", () => {
    expect(viewOf(100)).toBe("Blue");
    expect(viewOf(200)).toBe("Red");
  });
});
