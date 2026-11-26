/**
 * The replay's "Fog of War" team dropdown (bottom-left of the replay controls: All / Blue /
 * Red). It decides which units the minimap draws: on a team, the other team's minions,
 * wards and hidden champions are left off even with fogOfWar:false. The Replay API can't
 * set it and no hotkey was found, so the scan clicks it. Measured on a 1920x1080 replay
 * (HUD scale 1): the closed dropdown's arrow at (220, 1022); opened, the options list
 * Blue at (185, 951), Red at (184, 974), All at (180, 998). The controls are anchored to
 * the bottom-left corner and scale with the screen height.
 */
import type { Frame } from "./minimap";

export type FogView = "All" | "Blue" | "Red";

const REF_H = 1080;
const OPEN = { x: 220, y: 1022 };
const OPTION: Record<FogView, { x: number; y: number }> = { Blue: { x: 185, y: 951 }, Red: { x: 184, y: 974 }, All: { x: 180, y: 998 } };
/** Where the selected value's text sits in the closed dropdown (1920x1080). */
const TEXT = { x0: 130, x1: 205, y0: 1012, y1: 1030 };

const at = (p: { x: number; y: number }, h: number) => {
  const k = h / REF_H;
  return { x: Math.round(p.x * k), y: Math.round(h - (REF_H - p.y) * k) };
};

/** Screen pixels to click: open the dropdown, then the option. */
export function fogDropdownClicks(view: FogView, screen: { w: number; h: number }): { x: number; y: number }[] {
  return [at(OPEN, screen.h), at(OPTION[view], screen.h)];
}

/**
 * Which value the closed dropdown shows, from its text colour: Blue is drawn cyan-blue,
 * Red red, All near-white (sampled on a 1920x1080 replay: Blue ~(70,170,220), Red
 * ~(200,40,40), All ~(220,220,210)). Null when none of them is clearly there (dropdown
 * hidden, covered, or open).
 */
export function readFogDropdown(f: Frame): FogView | null {
  const k = f.h / REF_H;
  const y0 = Math.round(f.h - (REF_H - TEXT.y0) * k);
  const y1 = Math.round(f.h - (REF_H - TEXT.y1) * k);
  const n = { All: 0, Blue: 0, Red: 0 };
  for (let y = Math.max(0, y0); y <= Math.min(f.h - 1, y1); y++)
    for (let x = Math.round(TEXT.x0 * k); x <= Math.min(f.w - 1, Math.round(TEXT.x1 * k)); x++) {
      const i = (y * f.w + x) * 4;
      const r = f.data[i];
      const g = f.data[i + 1];
      const b = f.data[i + 2];
      if (r > 160 && g > 160 && b > 150 && Math.max(r, g, b) - Math.min(r, g, b) < 50) n.All++;
      else if (b > 150 && g > 110 && r < 120 && b > r + 60) n.Blue++;
      else if (r > 150 && g < 90 && b < 90) n.Red++;
    }
  const best = (Object.keys(n) as FogView[]).sort((a, b) => n[b] - n[a])[0];
  return n[best] >= 8 * k * k ? best : null;
}

/** The dropdown value that shows only `teamId`'s vision. */
export const viewOf = (teamId: number): FogView => (teamId === 100 ? "Blue" : "Red");
