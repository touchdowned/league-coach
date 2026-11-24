/**
 * Wave state read from the replay's minimap: where each team's minions are in each lane.
 *
 * Positions along a lane are stored as progress from the blue base (0) to the red
 * base (1). Reads flip that so 0 is always *your* base.
 */
import type { Dot } from "./minimap";
import type { Position } from "./types";

export type Lane = "TOP" | "MIDDLE" | "BOTTOM";
export const LANES: Lane[] = ["TOP", "MIDDLE", "BOTTOM"];
type Pt = { x: number; y: number };

// Blue inhibitor to red inhibitor, along the lane.
const PATH: Record<Lane, Pt[]> = {
  TOP: [{ x: 1150, y: 3000 }, { x: 1300, y: 13400 }, { x: 11800, y: 13800 }],
  MIDDLE: [{ x: 3200, y: 3200 }, { x: 11600, y: 11600 }],
  BOTTOM: [{ x: 3000, y: 1100 }, { x: 13500, y: 1400 }, { x: 13700, y: 11800 }],
};
const OUTER_TOWER: Record<Lane, Record<number, Pt>> = {
  TOP: { 100: { x: 981, y: 10441 }, 200: { x: 4318, y: 13875 } },
  MIDDLE: { 100: { x: 5846, y: 6396 }, 200: { x: 8955, y: 8510 } },
  BOTTOM: { 100: { x: 10504, y: 1029 }, 200: { x: 13866, y: 4505 } },
};
const MAX_OFF = 1400;

const len = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
const LENGTH: Record<Lane, number> = Object.fromEntries(LANES.map((l) => [l, PATH[l].slice(1).reduce((s, p, i) => s + len(PATH[l][i], p), 0)])) as Record<Lane, number>;

function along(lane: Lane, p: Pt): { s: number; off: number } {
  const path = PATH[lane];
  let best = { s: 0, off: Infinity };
  let acc = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const L = len(a, b);
    const k = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L)));
    const off = Math.hypot(p.x - (a.x + (b.x - a.x) * k), p.y - (a.y + (b.y - a.y) * k));
    if (off < best.off) best = { s: (acc + k * L) / LENGTH[lane], off };
    acc += L;
  }
  return best;
}

/** Which lane a map point is on, and how far along it (0 blue base .. 1 red base). */
export function projectLane(p: Pt): { lane: Lane; s: number } | null {
  let best: { lane: Lane; s: number; off: number } | null = null;
  for (const lane of LANES) {
    const a = along(lane, p);
    if (a.off <= MAX_OFF && (!best || a.off < best.off)) best = { lane, ...a };
  }
  if (best) return { lane: best.lane, s: best.s };
  // In a base, between the nexus and the lane's inhibitor: a wave that just spawned, or one
  // walking home. Counted in the lane it belongs to, at that lane's end.
  for (const [team, nexus] of [[100, NEXUS[100]], [200, NEXUS[200]]] as const) {
    if (Math.hypot(p.x - nexus.x, p.y - nexus.y) > 3600) continue;
    let pick: { lane: Lane; off: number } | null = null;
    for (const lane of LANES) {
      const end = team === 100 ? PATH[lane][0] : PATH[lane][PATH[lane].length - 1];
      const off = segDist(p, nexus, end);
      if (off <= MAX_OFF && (!pick || off < pick.off)) pick = { lane, off };
    }
    if (pick) return { lane: pick.lane, s: team === 100 ? 0 : 1 };
  }
  return null;
}

/** Nexus positions (game units). */
const NEXUS = { 100: { x: 1550, y: 1660 }, 200: { x: 13230, y: 13250 } };

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export interface WaveSample {
  /** Game time, ms. */
  t: number;
  /** Progress of each minion along the lane, per team (b = blue, r = red), 2 decimals. */
  lanes: Record<Lane, { b: number[]; r: number[] }>;
  /** Ward icons on the fog-off minimap (game units). */
  wards?: { team: 100 | 200; x: number; y: number }[];
}

/** Champions read off the minimap at one moment, in one view. */
export interface ChampSample {
  t: number;
  /** "team": your team's fog of war, what you could see. "off": everything. */
  fog: "team" | "off";
  /** `inferred`: not read off the minimap, filled in while hidden under another icon (see fillOcclusions). */
  at: { id: number; x: number; y: number; inferred?: true }[];
  /** Rings seen but not matched to a champion (named later by tracking, if they can be). */
  unk?: { team: 100 | 200; x: number; y: number }[];
}

export interface WaveTrack {
  version: 1 | 2;
  source: "replay-minimap";
  samples: WaveSample[];
  /** Champion positions from the replay (version 2). */
  champs?: ChampSample[];
  /** Whose fog the "team" view showed. Vision reads are only used when it's yours. */
  viewTeam?: number;
  /** Live Client Data polls taken during the pass (only the ones around a change). */
  live?: import("./telemetry").LivePoll[];
  /** How the pass ran: capture cost, sample counts, calibration. */
  scanInfo?: {
    /** "recorder": Riot's own frame recorder. "screenshot": desktop screenshots (the slow fallback). */
    method?: "recorder" | "screenshot";
    captureMsMedian: number;
    captureMsP90: number;
    samples: number;
    polls: number;
    minimap: { x: number; y: number; w: number; h: number };
    screen: { w: number; h: number };
    until: number;
    /** Game ms of the last frame read: checks only cover up to here. */
    lastFrame?: number;
    /** Each pass: frames read, frames per game second, wall time. */
    passes?: { fog: "off" | "team"; method: "recorder" | "screenshot"; frames: number; fps: number; wallMs: number; maxBacklog?: number; /** Frames the pass should give at its fps: a mismatch means frame times are off. */ expectedFrames?: number; segments?: number }[];
    /** Champion reads dropped as impossible jumps, and unmatched rings named by tracking. */
    tracking?: { dropped: number; named: number; filled?: number; rematched?: number };
  };
}

export function sampleFromDots(t: number, dots: Dot[]): WaveSample {
  const lanes = { TOP: { b: [], r: [] }, MIDDLE: { b: [], r: [] }, BOTTOM: { b: [], r: [] } } as WaveSample["lanes"];
  for (const d of dots) {
    const p = projectLane(d);
    if (!p) continue;
    for (let k = 0; k < (d.n ?? 1); k++) lanes[p.lane][d.team === 100 ? "b" : "r"].push(Math.round(p.s * 100) / 100);
  }
  return { t, lanes };
}

export function laneOf(pos: Position | string | undefined): Lane | null {
  if (pos === "TOP") return "TOP";
  if (pos === "MIDDLE") return "MIDDLE";
  if (pos === "BOTTOM" || pos === "UTILITY") return "BOTTOM";
  return null;
}

export type WaveWhere = "under your tower" | "on your side" | "in the middle" | "on their side" | "under their tower";

export interface WaveRead {
  t: number;
  /** Your minions and theirs around where the waves meet. */
  mine: number;
  theirs: number;
  /** Where the fight between the waves is, 0 = your base, 1 = theirs. */
  front: number;
  where: WaveWhere;
}

const towerAt = (lane: Lane, team: number) => along(lane, OUTER_TOWER[lane][team]).s;

/** The wave in `lane` at time t, seen from `teamId`'s side. Null if no sample is close enough. */
export function waveAt(track: WaveTrack | undefined, t: number, lane: Lane, teamId: number): WaveRead | null {
  if (!track?.samples.length) return null;
  let best: WaveSample | null = null;
  for (const s of track.samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  if (!best || Math.abs(best.t - t) > 5000) return null;
  const flip = teamId === 200;
  const own = (flip ? best.lanes[lane].r : best.lanes[lane].b).map((s) => (flip ? 1 - s : s));
  const opp = (flip ? best.lanes[lane].b : best.lanes[lane].r).map((s) => (flip ? 1 - s : s));
  if (!own.length && !opp.length) return null;
  const leadMine = own.length ? Math.max(...own) : null;
  const leadTheirs = opp.length ? Math.min(...opp) : null;
  const front = leadMine != null && leadTheirs != null ? (leadMine + leadTheirs) / 2 : (leadMine ?? leadTheirs)!;
  const W = 0.12;
  const mine = own.filter((s) => Math.abs(s - front) <= W).length;
  const theirs = opp.filter((s) => Math.abs(s - front) <= W).length;
  const myTower = flip ? 1 - towerAt(lane, 200) : towerAt(lane, 100);
  const theirTower = flip ? 1 - towerAt(lane, 100) : towerAt(lane, 200);
  const where: WaveWhere =
    front <= myTower + 0.05 ? "under your tower" : front >= theirTower - 0.05 ? "under their tower" : front < 0.46 ? "on your side" : front > 0.54 ? "on their side" : "in the middle";
  return { t: best.t, mine, theirs, front, where };
}

/** Every read in [from, to], one per sample. */
export function waveSeries(track: WaveTrack | undefined, from: number, to: number, lane: Lane, teamId: number): WaveRead[] {
  if (!track) return [];
  return track.samples.filter((s) => s.t >= from && s.t <= to).map((s) => waveAt(track, s.t, lane, teamId)).filter((r): r is WaveRead => !!r);
}

export function waveLine(w: WaveRead): string {
  return `${w.mine} of your minions vs ${w.theirs} of theirs, ${w.where}`;
}

/** The map point `s` of the way along a lane (0 blue base .. 1 red base). */
export function pointOnLane(lane: Lane, s: number): Pt {
  const path = PATH[lane];
  let d = Math.max(0, Math.min(1, s)) * LENGTH[lane];
  for (let i = 0; i < path.length - 1; i++) {
    const L = len(path[i], path[i + 1]);
    if (d <= L || i === path.length - 2) {
      const k = Math.min(1, d / L);
      return { x: path[i].x + (path[i + 1].x - path[i].x) * k, y: path[i].y + (path[i + 1].y - path[i].y) * k };
    }
    d -= L;
  }
  return path[path.length - 1];
}

/** Every minion the replay showed near time t, as map points. */
export function minionsAt(track: WaveTrack | undefined, t: number): { x: number; y: number; team: 100 | 200 }[] {
  if (!track?.samples.length) return [];
  let best: WaveSample | null = null;
  for (const s of track.samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  if (!best || Math.abs(best.t - t) > 3000) return [];
  const out: { x: number; y: number; team: 100 | 200 }[] = [];
  for (const lane of LANES) {
    for (const s of best.lanes[lane].b) out.push({ ...pointOnLane(lane, s), team: 100 });
    for (const s of best.lanes[lane].r) out.push({ ...pointOnLane(lane, s), team: 200 });
  }
  return out;
}
