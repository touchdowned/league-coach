/**
 * Module 2, part 1: wave states. Deterministic rules over the minion positions the scan
 * reads off the fog-off minimap twice a game second (see waves.ts): no model, no guessing.
 *
 * Everything is seen from one team's side: progress 0 is that team's base, 1 the enemy's.
 * Distances are game units along the lane.
 *
 * Per sample (`laneRead`):
 *  - each side's lead minion and its "contact group": the minions within GROUP of the lead
 *    (one wave is about 600 units long; two stacked about 1200);
 *  - the waves are in contact when the leads are within CONTACT of each other;
 *  - the front is the midpoint of the leads in contact, else the lead that has reached a
 *    tower, else the only wave in the lane; two waves still walking at each other have none;
 *  - the zone: under a tower when the attackers' lead minion is within TOWER_RANGE of the
 *    outermost standing tower of that lane (towers fall: BUILDING_KILL moves the line back).
 *
 * Over time (`waveEvents`): crash, bounce, freeze, slow push, fast push, each with the
 * numbers behind it. The thresholds are named constants with what they stand for; the ones
 * that depend on how the minimap draws things are checked against real scans by
 * `checkWaveStates`.
 */
import { STRUCTURES } from "./minimap";
import type { TimelineEvent } from "./types";
import { laneLength, LANES, progressOn, projectLane, type Lane, type WaveSample, type WaveTrack } from "./waves";

/** Minions walk at 325 units a second. */
export const MINION_SPEED = 325;
/** Caster minions attack from 550 units, melee from about 110: leads this close are fighting. */
const CONTACT = 900;
/** How far behind its lead a wave's minions count as the same group (two stacked waves). */
const GROUP = 1300;
/** Outer and inner turrets reach 750 units plus the target's size; minions inside this are "under tower". */
const TOWER_RANGE = 900;
/** A front moving slower than this (units a second, over SLOPE_MS) is being held, not pushed. */
const HOLD_SPEED = 45;
const SLOPE_MS = 8000;
/** A freeze has to outlast one wave interval's worth of fighting: the next wave (30 s later) must meet it at the same place. */
const FREEZE_MS = 25_000;
/** A held front further than this from the holder's tower isn't a freeze (side lanes are long: the holder's half is up to 5000 units). It must also sit on the holder's side of the middle. */
const FREEZE_REACH = 3200;
/** A slow push is a growing stack: this many more minions than the other side, for this long. */
const STACK_LEAD = 3;
const STACK_MS = 12_000;
/** After a crash, the wave "bounces" if the front is back on the crasher's side of the middle within this long. */
const BOUNCE_MS = 50_000;
/** Reads are steadied over this long either side (see laneSeries). */
const SMOOTH_MS = 1500;
/** A wiped wave has to stay gone this long to count (a wave doesn't come back). */
const WIPE_HOLD_MS = 3000;
/** A wave last read walking free within this of a tower is followed to it when it goes unread. */
const RECKON_REACH = 3000;
/** A champion portrait hides minions within this of its centre along the lane (12.5 px radius on a 247 px minimap is 725 units, plus a dot's own size). */
const PORTRAIT = 850;
/** A wave fighting under a portrait is held in place this long without a read. */
const HIDE_MS = 15_000;
/** No enemy minion near for this long: the wave is walking, not fighting. */
const FREE_MS = 4000;
/** How long a wave that reached a tower unread is taken to last there: a tower alone kills a six-minion wave in about 20 s. */
const RECKON_HOLD_MS = 20_000;

export interface LaneRead {
  t: number;
  /** Minions of each side anywhere in the lane. */
  mineAll: number;
  theirsAll: number;
  /** Minions in each side's lead group (the ones at the fight). */
  mine: number;
  theirs: number;
  /** Lead minion of each side, units from my inhibitor; null with none in lane. */
  leadMine: number | null;
  leadTheirs: number | null;
  contact: boolean;
  /** Where the fight is (units from my inhibitor); null with no minions in lane. */
  front: number | null;
  zone: "my tower" | "my side" | "middle" | "their side" | "their tower" | null;
  /** Distance from the front to my outermost tower and to theirs (negative: past it). */
  toMyTower: number | null;
  toTheirTower: number | null;
  /** My minions within turret range of their outermost tower (or past it), and theirs at mine. */
  underTheirTower: number;
  underMyTower: number;
  /** A lead here is where an unread wave must be (hidden under a portrait, or walked on to a tower), not a read (see follow). */
  inferred?: true;
}

// Lane turrets per team, outermost first (game units), taken from the structure list.
const T = (i: number) => STRUCTURES[i];
const LANE_TOWERS: Record<Lane, Record<100 | 200, { x: number; y: number }[]>> = {
  TOP: { 100: [T(0), T(1), T(2)], 200: [T(14), T(15), T(16)] },
  MIDDLE: { 100: [T(3), T(4), T(5)], 200: [T(17), T(18), T(19)] },
  BOTTOM: { 100: [T(6), T(7), T(8)], 200: [T(20), T(21), T(22)] },
};
const LANE_TYPE: Record<string, Lane> = { TOP_LANE: "TOP", MID_LANE: "MIDDLE", BOT_LANE: "BOTTOM" };
const TOWER_INDEX: Record<string, number> = { OUTER_TURRET: 0, INNER_TURRET: 1, BASE_TURRET: 2 };

export interface LaneGeometry {
  /** Outermost standing lane tower of `team` in `lane` at time t, as progress 0..1 from the blue base; null when all three are down. */
  towerAt(lane: Lane, team: 100 | 200, t: number): number | null;
}

/** Tower lines over the game, from the timeline's BUILDING_KILL events. */
export function laneGeometry(events: TimelineEvent[]): LaneGeometry {
  const fell: { lane: Lane; team: 100 | 200; idx: number; t: number }[] = [];
  for (const e of events) {
    if (e.type !== "BUILDING_KILL" || e.buildingType !== "TOWER_BUILDING") continue;
    const lane = LANE_TYPE[e.laneType ?? ""];
    const idx = TOWER_INDEX[e.towerType ?? ""];
    if (!lane || idx === undefined || (e.teamId !== 100 && e.teamId !== 200)) continue;
    fell.push({ lane, team: e.teamId, idx, t: e.timestamp });
  }
  return {
    towerAt(lane, team, t) {
      const down = new Set(fell.filter((f) => f.lane === lane && f.team === team && f.t <= t).map((f) => f.idx));
      for (let i = 0; i < 3; i++) if (!down.has(i)) return progressOn(lane, LANE_TOWERS[lane][team][i]);
      return null;
    },
  };
}

interface Raw {
  t: number;
  /** Minions past their own base, units from my inhibitor. */
  own: number[];
  opp: number[];
  mineAll: number;
  theirsAll: number;
  myTower: number;
  theirTower: number;
}

function rawRead(s: WaveSample, lane: Lane, teamId: number, geo: LaneGeometry): Raw {
  const L = laneLength(lane);
  const flip = teamId === 200;
  const u = (p: number) => (flip ? 1 - p : p) * L;
  const ownAll = (flip ? s.lanes[lane].r : s.lanes[lane].b).map(u);
  const oppAll = (flip ? s.lanes[lane].b : s.lanes[lane].r).map(u);
  const me = (teamId === 200 ? 200 : 100) as 100 | 200;
  const them = (me === 100 ? 200 : 100) as 100 | 200;
  const myT = geo.towerAt(lane, me, s.t);
  const theirT = geo.towerAt(lane, them, s.t);
  // A wave still inside its own base (projectLane snaps those to the lane's end) hasn't
  // entered the lane: it counts as alive but can't be a lead or a front.
  return { t: s.t, own: ownAll.filter((x) => x > 1), opp: oppAll.filter((x) => x < L - 1), mineAll: ownAll.length, theirsAll: oppAll.length, myTower: myT === null ? 0 : u(myT), theirTower: theirT === null ? L : u(theirT) };
}

function derive(r: Raw, leadMine: number | null, leadTheirs: number | null, mine: number, theirs: number, underTheirTower: number, underMyTower: number): LaneRead {
  const contact = leadMine !== null && leadTheirs !== null && leadTheirs - leadMine <= CONTACT;
  const atMine = leadTheirs !== null && leadTheirs <= r.myTower + TOWER_RANGE;
  const atTheirs = leadMine !== null && leadMine >= r.theirTower - TOWER_RANGE;
  // The front is where minions are fighting: between the leads in contact, at the lead that
  // has reached a tower, or at the only wave in the lane. Two waves still walking toward
  // each other have no front yet.
  let front: number | null = null;
  if (contact) front = (leadMine! + leadTheirs!) / 2;
  else if (atMine) front = leadTheirs;
  else if (atTheirs) front = leadMine;
  else if (leadMine === null || leadTheirs === null) front = leadMine ?? leadTheirs;
  let zone: LaneRead["zone"] = null;
  if (atMine) zone = "my tower";
  else if (atTheirs) zone = "their tower";
  else if (front !== null) {
    const mid = (r.myTower + r.theirTower) / 2;
    const band = (r.theirTower - r.myTower) * 0.08;
    zone = front < mid - band ? "my side" : front > mid + band ? "their side" : "middle";
  }
  return {
    t: r.t,
    mineAll: r.mineAll,
    theirsAll: r.theirsAll,
    mine,
    theirs,
    leadMine,
    leadTheirs,
    contact,
    front,
    zone,
    toMyTower: front === null ? null : front - r.myTower,
    toTheirTower: front === null ? null : r.theirTower - front,
    underTheirTower,
    underMyTower,
  };
}

const groupMine = (r: Raw, lead: number | null) => (lead === null ? 0 : r.own.filter((x) => x >= lead - GROUP && x <= lead + CONTACT).length);
const groupTheirs = (r: Raw, lead: number | null) => (lead === null ? 0 : r.opp.filter((x) => x <= lead + GROUP && x >= lead - CONTACT).length);
const underTheirs = (r: Raw) => r.own.filter((x) => x >= r.theirTower - TOWER_RANGE).length;
const underMine = (r: Raw) => r.opp.filter((x) => x <= r.myTower + TOWER_RANGE).length;

/** One lane at one sample, from `teamId`'s side (no smoothing: see laneSeries). */
export function laneRead(s: WaveSample, lane: Lane, teamId: number, geo: LaneGeometry): LaneRead {
  const r = rawRead(s, lane, teamId, geo);
  const leadMine = r.own.length ? Math.max(...r.own) : null;
  const leadTheirs = r.opp.length ? Math.min(...r.opp) : null;
  return derive(r, leadMine, leadTheirs, groupMine(r, leadMine), groupTheirs(r, leadTheirs), underTheirs(r), underMine(r));
}

/**
 * Every read of a lane in [from, to], steadied over SMOOTH_MS either side. A minion dot
 * touching another, or under a champion portrait or an ability circle, goes unread for a
 * frame or two (checked against frame dumps of two scans: a 5 v 5 at mid read as 5 v 0 for
 * one second). So each lead is the median of the leads read around that moment, and each
 * count the most read around it: dots get hidden, they don't get invented.
 */
export function laneSeries(track: WaveTrack, lane: Lane, teamId: number, geo: LaneGeometry, from = 0, to = Infinity): LaneRead[] {
  const raws = track.samples.filter((s) => s.t >= from && s.t <= to).map((s) => rawRead(s, lane, teamId, geo));
  const n = raws.length;
  const lm = raws.map((r) => (r.own.length ? Math.max(...r.own) : null));
  const lt = raws.map((r) => (r.opp.length ? Math.min(...r.opp) : null));
  const median = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
    // Gone only when most of the reads around say so.
    return v.length * 2 < xs.length || !v.length ? null : v[v.length >> 1];
  };
  const sm: (number | null)[] = [];
  const st: (number | null)[] = [];
  const win: [number, number][] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (raws[i].t - raws[lo].t > SMOOTH_MS) lo++;
    while (hi + 1 < n && raws[hi + 1].t - raws[i].t <= SMOOTH_MS) hi++;
    win.push([lo, hi]);
    sm.push(median(lm.slice(lo, hi + 1)));
    st.push(median(lt.slice(lo, hi + 1)));
  }
  // Champion portraits over this lane at each sample (units from my inhibitor).
  const L = laneLength(lane);
  const portraits = new Map<number, number[]>();
  for (const c of track.champs ?? []) {
    if (c.fog !== "off" || c.t < from || c.t > to) continue;
    const xs: number[] = [];
    for (const a of c.at) {
      const pr = projectLane(a);
      if (pr?.lane === lane) xs.push((teamId === 200 ? 1 - pr.s : pr.s) * L);
    }
    portraits.set(c.t, xs);
  }
  const { rm, rt } = follow(raws, sm, st, (t) => portraits.get(t) ?? []);
  const out: LaneRead[] = [];
  for (let i = 0; i < n; i++) {
    const leadMine = rm.lead[i];
    const leadTheirs = rt.lead[i];
    let mine = 0;
    let theirs = 0;
    let ut = 0;
    let um = 0;
    for (let k = win[i][0]; k <= win[i][1]; k++) {
      mine = Math.max(mine, groupMine(raws[k], leadMine));
      theirs = Math.max(theirs, groupTheirs(raws[k], leadTheirs));
      ut = Math.max(ut, underTheirs(raws[k]));
      um = Math.max(um, underMine(raws[k]));
    }
    if (rm.size[i] !== null) {
      mine = Math.max(mine, rm.size[i]!);
      if (leadMine! >= raws[i].theirTower - TOWER_RANGE) ut = Math.max(ut, rm.size[i]!);
    }
    if (rt.size[i] !== null) {
      theirs = Math.max(theirs, rt.size[i]!);
      if (leadTheirs! <= raws[i].myTower + TOWER_RANGE) um = Math.max(um, rt.size[i]!);
    }
    const r = derive(raws[i], leadMine, leadTheirs, mine, theirs, ut, um);
    if (rm.size[i] !== null || rt.size[i] !== null) r.inferred = true;
    out.push(r);
  }
  return out;
}

/**
 * Follows both sides' lead waves through the frames where the scan can't read them.
 *
 * Minion dots go unread in two places: within about 450 units of a tower (under its icon)
 * and under a champion portrait (about 725 units across the radius: a whole wave). Checked
 * against frame dumps of two scans, both happen all the time: 18 of 26 plates fell with no
 * attacking minion read within 900 units of the tower, and waves fighting under two laners'
 * portraits read as 0 for seconds. A wave that stops being read is one of three things, and
 * which one follows from what minions can do (walk at 325 units a second, or stand and fight):
 *
 *  - It was fighting the other wave (the other side's lead within CONTACT) and a portrait
 *    covers the spot: it is still there, hidden. Held in place for up to HIDE_MS.
 *  - It was walking free (no enemy minion near for FREE_MS) and either a portrait covers it
 *    or it is within RECKON_REACH of the tower: it kept walking. It is at the tower after
 *    distance / 325 seconds and lasts RECKON_HOLD_MS there.
 *  - Otherwise (unread in the open, or fighting with nothing covering it): it is dead.
 *
 * A followed lead is dropped the moment a read shows up at or past where it should be, or
 * the other side's wave is read beyond it. Returns each side's leads with the gaps filled
 * and the wave's size where filled (null where the lead is a read).
 */
function follow(raws: Raw[], sm: (number | null)[], st: (number | null)[], portraitsAt: (t: number) => number[]) {
  const n = raws.length;
  const rm = { lead: [...sm], size: new Array<number | null>(n).fill(null) };
  const rt = { lead: [...st], size: new Array<number | null>(n).fill(null) };
  interface Wave {
    at: number;
    /** Last read. */
    t: number;
    size: number;
    /** Last time an enemy minion was read (or followed) within CONTACT of it. */
    fought: number;
    /** Where it was at the last read, to walk from. */
    from: number;
  }
  const state: { 1: Wave | null; [-1]: Wave | null } = { 1: null, [-1]: null };
  for (let i = 0; i < n; i++) {
    const r = raws[i];
    const ports = portraitsAt(r.t);
    const covered = (x: number) => ports.some((p) => Math.abs(p - x) <= PORTRAIT);
    const before = { 1: state[1], [-1]: state[-1] };
    for (const dir of [1, -1] as const) {
      const w = before[dir];
      const other = before[dir === 1 ? -1 : 1];
      const read = dir === 1 ? sm[i] : st[i];
      const tower = dir === 1 ? r.theirTower : r.myTower;
      const stop = tower - dir * 300;
      const ahead = (a: number, b: number) => (a - b) * dir; // how far a is past b, toward the tower
      const near = other !== null && Math.abs(other.at - (w?.at ?? read ?? Infinity)) <= CONTACT + 300;
      // Where it should be by now.
      let expect = w ? w.at : null;
      const free = w !== null && r.t - w.fought >= FREE_MS;
      if (w && free && ahead(stop, w.from) > 0) expect = w.from + dir * Math.min(Math.abs(stop - w.from), ((r.t - w.t) / 1000) * MINION_SPEED);
      if (read !== null && (expect === null || ahead(read, expect) >= -GROUP)) {
        // Read (at or beyond where it should be): follow the read.
        const size = dir === 1 ? groupMine(r, read) : groupTheirs(r, read);
        const keep = w && r.t - w.t <= SMOOTH_MS * 2 && Math.abs(w.at - read) <= GROUP ? w : null;
        state[dir] = { at: read, t: r.t, from: read, size: Math.max(size, keep ? keep.size : 0), fought: near ? r.t : (keep?.fought ?? (other === null ? -Infinity : r.t - FREE_MS / 2)) };
        continue;
      }
      if (!w || expect === null) {
        state[dir] = null;
        continue;
      }
      const gone = r.t - w.t;
      let alive: boolean;
      if (!free) alive = near && (covered(w.at) || (other !== null && covered(other.at))) && gone <= HIDE_MS;
      else {
        const walk = (Math.abs(stop - w.from) / MINION_SPEED) * 1000;
        alive = (covered(expect) || Math.abs(tower - expect) <= RECKON_REACH) && ahead(stop, w.from) > -TOWER_RANGE && gone <= walk + RECKON_HOLD_MS;
      }
      // The other side's wave read beyond it: it is gone.
      const passed = dir === 1 ? st[i] !== null && st[i]! < expect - CONTACT : sm[i] !== null && sm[i]! > expect + CONTACT;
      if (!alive || passed) {
        state[dir] = null;
        // The read that wasn't accepted (a wave further back) is what is there now.
        if (read !== null) state[dir] = { at: read, t: r.t, from: read, size: dir === 1 ? groupMine(r, read) : groupTheirs(r, read), fought: -Infinity };
        continue;
      }
      state[dir] = { ...w, at: expect, fought: near ? r.t : w.fought };
      const o = dir === 1 ? rm : rt;
      o.lead[i] = expect;
      o.size[i] = w.size;
    }
  }
  return { rm, rt };
}

/** The read nearest t (within 3 s), or null. */
export function laneAt(series: LaneRead[], t: number): LaneRead | null {
  let best: LaneRead | null = null;
  for (const r of series) if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  return best && Math.abs(best.t - t) <= 3000 ? best : null;
}

/** Front speed at index i, units a second toward the enemy (least squares over the last SLOPE_MS). Null with too few fronts. */
export function frontSpeed(series: LaneRead[], i: number): number | null {
  let n = 0;
  let st = 0;
  let sf = 0;
  let stt = 0;
  let stf = 0;
  for (let k = i; k >= 0 && series[i].t - series[k].t <= SLOPE_MS; k--) {
    const f = series[k].front;
    if (f === null) continue;
    const t = (series[k].t - series[i].t) / 1000;
    n++;
    st += t;
    sf += f;
    stt += t * t;
    stf += t * f;
  }
  const den = n * stt - st * st;
  if (n < 4 || den === 0) return null;
  return (n * stf - st * sf) / den;
}

export type WaveEventKind = "crash" | "bounce" | "freeze" | "slow push" | "fast push";

export interface WaveEvent {
  kind: WaveEventKind;
  lane: Lane;
  /** Whose doing it is: "mine" = my wave crashes into their tower, I hold the freeze, my wave is the stack. */
  side: "mine" | "theirs";
  t0: number;
  t1: number;
  /** Minions of the acting side at the event (crash: under the tower at its peak; push: the stack; freeze: the frozen wave's average). */
  size: number;
  /** The other side's minions there (freeze: the surplus the holder is keeping alive). */
  against: number;
  /** Where (units from my inhibitor). */
  at: number;
  /** Freeze: distance from the holder's tower. Push: average front speed. Bounce: seconds from crash to crossing back. */
  value: number;
  /** Part of it rests on a wave followed while unread (see follow), not on reads. */
  inferred?: true;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Crashes, bounces, freezes and pushes in one lane.
 *
 * crash      the attacking side's minions are under the defending tower (zone) for at least
 *            2 s; ends when none are left there. size = most minions under it at once.
 * bounce     after a crash ends, the front crosses back to the crasher's side of the middle
 *            within BOUNCE_MS with the defender's wave now the larger group.
 * freeze     the waves are in contact and the front moves under HOLD_SPEED for FREEZE_MS or
 *            more, within FREEZE_REACH of a tower but outside its range; the holder is the
 *            team whose tower it is.
 * slow push  one side's lead group is STACK_LEAD or more larger for STACK_MS or more while
 *            the front moves toward the other tower slower than a free-walking wave.
 * fast push  the other side's lead group is wiped (count to 0) within 12 s of contact and
 *            the surviving wave walks on: front speed near MINION_SPEED.
 */
export function waveEvents(series: LaneRead[], lane: Lane): WaveEvent[] {
  const out: WaveEvent[] = [];
  const n = series.length;
  const speed = series.map((_, i) => frontSpeed(series, i));

  // Crashes: runs of a tower zone.
  for (const [zone, side] of [["their tower", "mine"], ["my tower", "theirs"]] as const) {
    let i = 0;
    while (i < n) {
      if (series[i].zone !== zone) {
        i++;
        continue;
      }
      let j = i;
      // A run survives gaps under 3 s (a frame where the dots merged or were covered).
      let last = i;
      while (j < n && series[j].t - series[last].t <= 3000) {
        if (series[j].zone === zone) last = j;
        j++;
      }
      const run = series.slice(i, last + 1);
      if (series[last].t - series[i].t >= 2000) {
        const under = (r: LaneRead) => (side === "mine" ? r.underTheirTower : r.underMyTower);
        const size = Math.max(...run.map(under));
        const peak = run.find((r) => under(r) === size)!;
        out.push({ kind: "crash", lane, side, t0: series[i].t, t1: series[last].t, size, against: side === "mine" ? peak.theirs : peak.mine, at: (side === "mine" ? peak.leadMine : peak.leadTheirs) ?? 0, value: (series[last].t - series[i].t) / 1000, ...(run.some((r) => r.inferred) ? { inferred: true as const } : {}) });
        // Bounce: back across the middle, toward the crasher, with the defender's group larger.
        for (let k = last + 1; k < n && series[k].t - series[last].t <= BOUNCE_MS; k++) {
          const r = series[k];
          const back = side === "mine" ? r.zone === "my side" || r.zone === "my tower" : r.zone === "their side" || r.zone === "their tower";
          const bigger = side === "mine" ? r.theirs > r.mine : r.mine > r.theirs;
          if (back && bigger && r.front !== null) {
            out.push({ kind: "bounce", lane, side, t0: series[last].t, t1: r.t, size: side === "mine" ? r.theirs : r.mine, against: side === "mine" ? r.mine : r.theirs, at: r.front, value: (r.t - series[last].t) / 1000 });
            break;
          }
          if (r.zone === zone) break; // crashed again first
        }
      }
      i = last + 1;
    }
  }

  // Freezes: held contact near a tower.
  {
    let i = 0;
    while (i < n) {
      const held = (k: number) => series[k].contact && series[k].front !== null && speed[k] !== null && Math.abs(speed[k]!) < HOLD_SPEED;
      if (!held(i)) {
        i++;
        continue;
      }
      let j = i;
      let last = i;
      while (j < n && series[j].t - series[last].t <= 3000) {
        if (held(j)) last = j;
        j++;
      }
      const run = series.slice(i, last + 1).filter((r) => r.front !== null);
      const span = series[last].t - series[i].t;
      // The front must also stay put over the whole run, not just drift slowly.
      const fronts = run.map((r) => r.front!);
      const drift = Math.max(...fronts) - Math.min(...fronts);
      if (span >= FREEZE_MS && drift <= 700) {
        const at = avg(fronts);
        const mine = avg(run.map((r) => r.toMyTower!));
        const theirs = avg(run.map((r) => r.toTheirTower!));
        const side = mine <= theirs ? "mine" : "theirs";
        const reach = side === "mine" ? mine : theirs;
        // On the holder's side of the lane for nearly all of it, not just nearer one tower.
        const sideZone = side === "mine" ? "my side" : "their side";
        const onSide = run.filter((r) => r.zone === sideZone).length >= run.length * 0.8;
        if (onSide && reach > TOWER_RANGE && reach <= FREEZE_REACH) {
          const holder = avg(run.map((r) => (side === "mine" ? r.mine : r.theirs)));
          const other = avg(run.map((r) => (side === "mine" ? r.theirs : r.mine)));
          out.push({ kind: "freeze", lane, side, t0: series[i].t, t1: series[last].t, size: Math.round(holder * 10) / 10, against: Math.round(other * 10) / 10, at, value: Math.round(reach) });
        }
      }
      i = last + 1;
    }
  }

  // Slow pushes: a lasting lead of STACK_LEAD while the front creeps toward the other tower.
  for (const side of ["mine", "theirs"] as const) {
    const lead = (r: LaneRead) => (side === "mine" ? r.mine - r.theirs : r.theirs - r.mine);
    let i = 0;
    while (i < n) {
      if (!(series[i].contact && lead(series[i]) >= STACK_LEAD)) {
        i++;
        continue;
      }
      let j = i;
      let last = i;
      while (j < n && series[j].t - series[last].t <= 3000) {
        if (series[j].contact && lead(series[j]) >= STACK_LEAD) last = j;
        j++;
      }
      const run = series.slice(i, last + 1).filter((r) => r.front !== null);
      const span = series[last].t - series[i].t;
      if (span >= STACK_MS && run.length >= 2) {
        const dir = side === "mine" ? 1 : -1;
        const v = ((run[run.length - 1].front! - run[0].front!) / (span / 1000)) * dir;
        if (v > 0 && v < MINION_SPEED * 0.6) {
          const size = Math.max(...run.map((r) => (side === "mine" ? r.mine : r.theirs)));
          out.push({ kind: "slow push", lane, side, t0: series[i].t, t1: series[last].t, size, against: Math.round(avg(run.map((r) => (side === "mine" ? r.theirs : r.mine))) * 10) / 10, at: run[run.length - 1].front!, value: Math.round(v) });
        }
      }
      i = last + 1;
    }
  }

  // Fast pushes: the other group wiped within 12 s of contact, then a free walk.
  for (const side of ["mine", "theirs"] as const) {
    const other = (r: LaneRead) => (side === "mine" ? r.theirs : r.mine);
    const own = (r: LaneRead) => (side === "mine" ? r.mine : r.theirs);
    for (let i = 1; i < n; i++) {
      if (!(series[i].contact && !series[i - 1].contact && other(series[i]) >= 3 && own(series[i]) >= 1)) continue;
      // First sample after contact began where the other group is gone or no longer in contact.
      let k = i;
      while (k < n && series[k].t - series[i].t <= 12_000 && series[k].contact) k++;
      if (k >= n || series[k].t - series[i].t > 12_000 || own(series[k]) < 1) continue;
      // The other side's lead must have fallen back by a group's length or vanished: wiped, not walked past.
      const gone = (q: number) => (side === "mine" ? series[q].leadTheirs === null || series[q].leadTheirs! - (series[i].leadTheirs ?? 0) > GROUP : series[q].leadMine === null || (series[i].leadMine ?? 0) - series[q].leadMine! > GROUP);
      // And stayed gone: a count that reads 0 for a second and comes back was dots merging.
      let held = 0;
      let lostLead = true;
      for (let q = k; q < n && series[q].t - series[k].t <= WIPE_HOLD_MS; q++) {
        if (!gone(q)) lostLead = false;
        held = series[q].t - series[k].t;
      }
      if (!lostLead || held < WIPE_HOLD_MS - 1000) continue;
      out.push({ kind: "fast push", lane, side, t0: series[i].t, t1: series[k].t, size: own(series[k]), against: other(series[i]), at: (side === "mine" ? series[k].leadMine : series[k].leadTheirs) ?? series[k].front ?? 0, value: (series[k].t - series[i].t) / 1000 });
    }
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

/** All three lanes. */
export function allWaveEvents(track: WaveTrack, teamId: number, geo: LaneGeometry): WaveEvent[] {
  return LANES.flatMap((lane) => waveEvents(laneSeries(track, lane, teamId, geo), lane)).sort((a, b) => a.t0 - b.t0);
}

/**
 * Checks crash detection against the timeline: a turret plate or tower can only be taken
 * with the attackers' minions under it (a tower without enemy minions in range takes heavily
 * reduced damage and fires back). So for every plate and tower lost in a lane during the
 * scan, the engine must show the attackers' wave under that tower within the 25 s before.
 */
export function checkWaveStates(track: WaveTrack, events: TimelineEvent[], until: number) {
  const geo = laneGeometry(events);
  const first = track.samples[0]?.t ?? Infinity;
  const series = new Map<string, LaneRead[]>();
  const get = (lane: Lane, team: number) => {
    const k = `${lane}:${team}`;
    if (!series.has(k)) series.set(k, laneSeries(track, lane, team, geo));
    return series.get(k)!;
  };
  let ok = 0;
  let n = 0;
  const missed: { t: number; lane: Lane; teamId: number; type: string; nearest: number | null }[] = [];
  for (const e of events) {
    const isPlate = e.type === "TURRET_PLATE_DESTROYED";
    const isTower = e.type === "BUILDING_KILL" && e.buildingType === "TOWER_BUILDING" && TOWER_INDEX[e.towerType ?? ""] !== undefined;
    if (!isPlate && !isTower) continue;
    const lane = LANE_TYPE[e.laneType ?? ""];
    if (!lane || (e.teamId !== 100 && e.teamId !== 200) || e.timestamp > until || e.timestamp < first + 25_000) continue;
    n++;
    // From the defender's side: "my tower" is the one that lost the plate. Just before the
    // event, so a tower that falls is still the outermost one.
    const s = get(lane, e.teamId).filter((r) => r.t >= e.timestamp - 25_000 && r.t < e.timestamp);
    const hit = s.some((r) => r.zone === "my tower");
    if (hit) ok++;
    else {
      const d = s.map((r) => r.toMyTower).filter((x): x is number => x !== null);
      missed.push({ t: e.timestamp, lane, teamId: e.teamId, type: isPlate ? "plate" : (e.towerType ?? "tower"), nearest: d.length ? Math.round(Math.min(...d)) : null });
    }
  }
  return {
    name: "waves: attackers' wave under the tower before each plate or tower falls",
    measured: `${n ? Math.round((ok / n) * 1000) / 10 : 0}% (${ok}/${n})`,
    bar: ">= 90%",
    pass: n > 0 && ok / n >= 0.9,
    n,
    detail: missed,
  };
}
