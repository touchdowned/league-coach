/**
 * HP and resource bars of all ten players, from the replay's team frames: the column of
 * five small player frames down each side of the screen (blue team left, red team right,
 * in lobby order top to bottom). The replay shows no bottom-centre champion HUD, so this
 * is the only place every player's bars are on screen at once.
 *
 * Measured on a 1920x1080 replay (HUD scale default, NA1_5686076870):
 *  - frames are 103 px apart, slot k = 0..4 from the top;
 *  - HP bar: blue side x 31-71, red side x 1847-1887, rows y 207-211 (+103k);
 *  - resource bar: blue side x 31-70, red side x 1847-1887, rows y 215-220 (+103k);
 *  - both sides fill left to right; the empty part is flat dark grey (19,19,19);
 *  - HP is green (~16,170,66), mana blue (~33,101,222), energy yellow (~206,207,33);
 *    a champion with no resource has an all-grey resource bar;
 *  - a dead player's bars are empty.
 * Everything is anchored to the screen's top corners and scales with the screen height.
 */
import type { Frame } from "./minimap";

const REF_H = 1080;
const REF_W = 1920;
const STEP = 103;
const HP = { x0: 31, x1: 71, y0: 207, y1: 211 };
const RES = { x0: 31, x1: 70, y0: 215, y1: 220 };
/** Red side: the same bars, mirrored to x 1847-1887 from the right edge. */
const RED_X0 = 1847;
const EMPTY = 19;

export interface HudRead {
  /** 0-100, or null when the bar isn't there to read (frames hidden, covered, other HUD scale). */
  hp: number | null;
  res: number | null;
}

/**
 * The strip of the screen that holds one side's five frames (for cropping before reading).
 * It runs to y 650: the fifth frame's resource bar ends at y 632. (It used to stop at 600,
 * which cut off the fifth frame's bars on both sides: Leona and Sona read 0% on NA1_5686039660,
 * Leona and Alistar on NA1_5686076870.)
 */
export function hudStrip(side: 100 | 200, screen: { w: number; h: number }) {
  const k = screen.h / REF_H;
  const w = Math.ceil(110 * k);
  return { x: side === 100 ? 0 : screen.w - w, y: Math.floor(140 * k), w, h: Math.min(screen.h, Math.ceil(650 * k)) - Math.floor(140 * k) };
}

/**
 * One bar: the filled share, left to right. A column is "empty" when its pixels are the flat
 * dark grey, "filled" when they're clearly brighter or coloured; a bar where more than a
 * fifth of the columns are neither isn't a bar (null).
 */
/**
 * What counts as a bar's fill. HP is green (~16,170,66 to ~0,240,80). A resource bar is mana
 * blue (~33,101,222), energy yellow (~206,207,33) or another saturated resource colour, but
 * never green. Checking the hue matters: with the team frames hidden, bright scenery behind
 * the bar positions read as full bars on the red side (Zed and Jinx "100/100" on a frame
 * with interfaceFrames off).
 */
const hpFill = (r: number, g: number, b: number) => g >= 100 && g > r + 50 && g > b + 30;
const resFill = (r: number, g: number, b: number) => Math.max(r, g, b) >= 80 && Math.max(r, g, b) - Math.min(r, g, b) >= 40 && !hpFill(r, g, b);

function readBar(f: Frame, x0: number, x1: number, y0: number, y1: number, isFill: (r: number, g: number, b: number) => boolean): number | null {
  if (x0 < 0 || y0 < 0 || x1 >= f.w || y1 >= f.h || x1 <= x0) return null;
  let filled = 0;
  let empty = 0;
  let edge = -1; // last filled column counted from the left with no empty column before it
  let broken = false;
  const n = x1 - x0 + 1;
  for (let x = x0; x <= x1; x++) {
    let fill = 0;
    let grey = 0;
    for (let y = y0; y <= y1; y++) {
      const i = (y * f.w + x) * 4;
      const r = f.data[i];
      const g = f.data[i + 1];
      const b = f.data[i + 2];
      if (isFill(r, g, b)) fill++;
      else if (Math.abs(r - EMPTY) <= 16 && Math.abs(g - EMPTY) <= 16 && Math.abs(b - EMPTY) <= 16) grey++;
    }
    const rows = y1 - y0 + 1;
    if (fill * 2 > rows) {
      filled++;
      if (!broken) edge = x - x0;
    } else if (grey * 2 > rows) {
      empty++;
      broken = true;
    } else broken = true;
  }
  if (filled + empty < n * 0.8) return null;
  return Math.round(((edge + 1) / n) * 100);
}

/**
 * The bars of one side's slot. `f` is the full screen, or a strip cut with `hudStrip`
 * (pass where the strip starts as `origin` and the full screen size as `screen`).
 */
export function readHud(f: Frame, side: 100 | 200, slot: number, screen: { w: number; h: number } = f, origin: { x: number; y: number } = { x: 0, y: 0 }): HudRead {
  const k = screen.h / REF_H;
  // Left frames hang off the left edge, right frames off the right edge.
  const px = (x: number) => (side === 100 ? Math.round(x * k) : Math.round(screen.w - (REF_W - (RED_X0 + (x - HP.x0))) * k)) - origin.x;
  const py = (y: number) => Math.round((y + STEP * slot) * k) - origin.y;
  const hp = readBar(f, px(HP.x0), px(HP.x1), py(HP.y0), py(HP.y1), hpFill);
  // The resource bar only counts under a readable HP bar: with the frames hidden, saturated
  // scenery at the resource rows still read as full on the red side.
  return { hp, res: hp === null ? null : readBar(f, px(RES.x0), px(RES.x1), py(RES.y0), py(RES.y1), resFill) };
}

/** One moment's bars for all ten players: index = participant id - 1 (1-5 blue, 6-10 red). */
export interface HudSample {
  t: number;
  hp: (number | null)[];
  res: (number | null)[];
  /** Flash off the summoner spell icons: true ready, false on cooldown, null not read or the player has no Flash. */
  flash?: (boolean | null)[];
  /** Ultimate off the ult indicator: true ready, false on cooldown or not learned, null not read. */
  ult?: (boolean | null)[];
}

export function readHudStrips(t: number, blue: Frame, red: Frame, screen: { w: number; h: number }): HudSample {
  const out: HudSample = { t, hp: [], res: [] };
  for (const [side, f] of [[100, blue], [200, red]] as const) {
    const o = hudStrip(side, screen);
    for (let slot = 0; slot < 5; slot++) {
      const r = readHud(f, side, slot, screen, { x: o.x, y: o.y });
      out.hp.push(r.hp);
      out.res.push(r.res);
    }
  }
  return out;
}

/**
 * Checks the HP reads against the two moments where HP is known without reading it: a dead
 * champion has 0, and a champion who just respawned stands in the fountain at full health.
 * `deaths` and `respawns` are (participant id, game ms) from Live Client's isDead changes.
 */
export function checkHud(hud: HudSample[], deaths: { id: number; t: number }[], respawns: { id: number; t: number }[]) {
  const s = [...hud].sort((a, b) => a.t - b.t);
  const at = (id: number, from: number, to: number) => {
    for (const x of s) if (x.t >= from && x.t <= to && x.hp[id - 1] !== null) return x.hp[id - 1]!;
    return null;
  };
  let ok = 0;
  let n = 0;
  let unread = 0;
  const wrong: { kind: "death" | "respawn"; id: number; t: number; hp: number }[] = [];
  for (const [kind, list] of [["death", deaths], ["respawn", respawns]] as const)
    for (const e of list) {
      // From 1 s after the change (the poll that saw it can be up to a second late) to 4 s after.
      const hp = at(e.id, e.t + 1000, e.t + 4000);
      n++;
      if (hp === null) unread++;
      else if (kind === "death" ? hp <= 2 : hp >= 95) ok++;
      else wrong.push({ kind, id: e.id, t: e.t, hp });
    }
  const total = s.length * 10;
  const readable = s.reduce((a, x) => a + x.hp.filter((v) => v !== null).length, 0);
  return {
    name: "hud: HP 0 when dead, full on respawn",
    measured: `${n ? Math.round((ok / n) * 1000) / 10 : 0}% (${ok}/${n}): ${deaths.length} deaths, ${respawns.length} respawns, ${unread} with no bar read, ${wrong.length} wrong; bars readable in ${total ? Math.round((readable / total) * 1000) / 10 : 0}% of ${total} player-samples`,
    bar: ">= 95% of deaths and respawns",
    pass: n > 0 && ok / n >= 0.95,
    n,
    detail: wrong,
  };
}
