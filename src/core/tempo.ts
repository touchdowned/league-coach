/**
 * Module 2, part 2: recalls and tempo. Deterministic accounting, no model.
 *
 * What it works from:
 *  - each champion's position off the fog-off minimap (waves.ts ChampSample);
 *  - every minion's lane position off the same frames (WaveSample);
 *  - the wave schedule and minion values (rules.ts);
 *  - kills, purchases and epic monster kills from Riot's timeline.
 *
 * A base visit is a run of reads inside the player's own fountain. How they got there says
 * what it was: a death just before (respawn), a jump no walk could cover (recall: the
 * channel started RECALL_MS before the first fountain read), or a walk.
 *
 * What a visit cost is counted, not estimated from a rule of thumb. Minions are conserved:
 *     died(t) = spawned(t) - alive(t)
 * with spawned(t) from the wave schedule and alive(t) the enemy minions the scan sees in the
 * lane. Minions die oldest wave first, so the deaths between leaving the wave and being back
 * at it map onto specific waves, and each wave has a known XP and gold value.
 */
import { FOUNTAINS } from "./minimap";
import { BARON_BUFF_MS, EMPOWERED_RECALL_MS, PITS, RECALL_MS, XP_RANGE, objectiveWindows, waveGold, waveSize, waveSpawns, waveXp, type ObjectiveWindow, type WaveSpawn } from "./rules";
import type { MatchDto, TimelineDto, TimelineEvent } from "./types";
import { LANES, laneLength, laneOf, pointOnLane, type Lane, type WaveTrack } from "./waves";
import { CONTACT, laneGeometry, laneSeries, type LaneRead } from "./wavestate";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const fountainOf = (teamId: number) => FOUNTAINS[teamId === 200 ? 1 : 0];

/** Champions walk at 325 to about 450 units a second in lane; 500 plus 600 units of slack is the most a walk can cover (same rule as vision.ts canReach). */
const WALK_SPEED = 500;
const WALK_SLACK = 600;
/** A walk back to base only counts from this close; from further out, a long gap between reads is a recall the scan didn't see the channel of. */
const WALK_FROM = 4500;
/** A first read this close to the fountain after an unexplained jump means they came out of it. */
const NEAR_BASE = 3000;
/** The longest death timer in a normal game is under 80 s. */
const MAX_RESPAWN_MS = 80_000;
/** Base visits closer together than this are one visit (stepping off the platform and back). */
const MERGE_MS = 5000;
/** A recalling champion stands still: reads during the channel stay within this of each other. */
const CHANNEL_DRIFT = 300;
/** Walking speed used for "the earliest you could have been back" when the player never returned to the wave. */
const RETURN_SPEED = 400;

export interface Fix extends Pt {
  t: number;
  inferred?: boolean;
}

export interface Death {
  t: number;
  at: Pt | null;
  /** When they respawned, if the scan saw it (HP bar back above 0, or Live Client's isDead clearing). */
  respawn?: number | null;
}

/** One champion's fog-off positions over the scan, in time order. */
export function pathOf(track: WaveTrack, id: number): Fix[] {
  const out: Fix[] = [];
  for (const s of track.champs ?? []) {
    if (s.fog !== "off") continue;
    const a = s.at.find((x) => x.id === id);
    if (a) out.push({ t: s.t, x: a.x, y: a.y, inferred: a.inferred });
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface BaseVisit {
  id: number;
  kind: "recall" | "death" | "walk";
  /** recall: when the channel began. death: the kill. walk: the last read before reaching base. */
  start: number;
  /** First read in the fountain (or, with no read there, just after the last read elsewhere). */
  arrive: number;
  /** The last read anywhere else before it: the visit can't have begun earlier. */
  since: number;
  /** Last read in the fountain; null when the scan ended there. */
  leave: number | null;
  /** Where the recall was channelled, or where the death happened. */
  from: Pt | null;
  /** recall: the scan saw the champion standing still through the channel. */
  channelSeen: boolean;
  /** Left base by a jump no walk covers (Teleport). */
  teleportedOut: boolean;
}

/**
 * Every base visit of one champion. `deaths` are that champion's death times; `baronKills`
 * the times their team took Baron (the buff halves the recall channel).
 */
export function baseVisits(id: number, rawPath: Fix[], teamId: number, deaths: Death[], baronKills: number[] = []): BaseVisit[] {
  const f = fountainOf(teamId);
  const inBase = (p: Pt) => dist(p, f) <= f.r;
  // Into the fountain, a walk only has to reach its edge.
  const walkable = (a: Fix, b: Fix) => (inBase(b) ? Math.max(0, dist(a, f) - f.r) : dist(a, b)) <= WALK_SLACK + ((b.t - a.t) / 1000) * WALK_SPEED;
  const out: BaseVisit[] = [];
  // Respawns first. A dead champion has no icon, so any read between the death and the
  // respawn is another ring misnamed (seen on two scans: reads in lane 6 s after a death).
  // The respawn moment comes from the HP bar or Live Client (see deathsOf); without either,
  // it is the first real read back at the fountain.
  const dead: [number, number][] = [];
  for (const d of deaths) {
    let k: number;
    let arrive: number;
    if (d.respawn != null) {
      arrive = d.respawn;
      k = rawPath.findIndex((p) => p.t >= arrive - 500);
    } else {
      k = rawPath.findIndex((p) => p.t >= d.t + 6000 && !p.inferred && dist(p, f) <= NEAR_BASE);
      if (k < 0 || rawPath[k].t - d.t > MAX_RESPAWN_MS) continue;
      arrive = inBase(rawPath[k]) ? rawPath[k].t : Math.max(d.t + 6000, rawPath[k].t - (Math.max(0, dist(rawPath[k], f) - f.r / 2) / RETURN_SPEED) * 1000 - 2000);
    }
    let leave: number | null = null;
    if (k >= 0) {
      let j = k;
      if (inBase(rawPath[k])) {
        while (j + 1 < rawPath.length && inBase(rawPath[j + 1])) j++;
        leave = j + 1 < rawPath.length ? Math.max(arrive, rawPath[j].t) : null;
      } else leave = Math.max(arrive, rawPath[k].t - (Math.max(0, dist(rawPath[k], f) - f.r / 2) / RETURN_SPEED) * 1000);
    }
    dead.push([d.t + 1000, arrive - 500]);
    out.push({ id, kind: "death", start: d.t, arrive, since: d.t, leave, from: d.at ?? null, channelSeen: false, teleportedOut: false });
  }
  const path = rawPath.filter((p) => !dead.some(([a, b]) => p.t > a && p.t < b));
  const respawning = (t: number) => out.some((v) => v.kind === "death" && t >= v.start && t <= (v.leave ?? Infinity) + MERGE_MS);
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    // An entry: the first read in the fountain, or (the fountain spot is in the minimap's
    // corner, where a portrait is cut off and often unread) a read near the fountain that no
    // walk from the read before explains: they went through the fountain unread.
    const seen = inBase(cur) && !inBase(prev);
    const hidden = !inBase(cur) && !inBase(prev) && dist(cur, f) <= NEAR_BASE && dist(prev, f) - f.r > WALK_FROM && !walkable(prev, cur);
    if (!seen && !hidden) continue;
    if (respawning(cur.t)) continue;
    let j = i;
    if (seen) while (j + 1 < path.length && inBase(path[j + 1])) j++;
    const next = seen ? path[j + 1] : cur;
    const jumped = !walkable(prev, cur);
    // One read alone that a walk explains isn't a visit (a single misread ring over the fountain).
    if (seen && j === i && !jumped && dist(prev, f) - f.r > WALK_SLACK) {
      i = j;
      continue;
    }
    // When they left: the last fountain read, or walked back from the first read outside.
    const walkedOut = next ? next.t - (Math.max(0, dist(next, f) - f.r / 2) / RETURN_SPEED) * 1000 : null;
    let leave: number | null = seen ? (j + 1 < path.length ? path[j].t : null) : Math.max(prev.t + 500, walkedOut ?? cur.t);
    // When they got there: the first fountain read, unless a jump put them there unread just after the last read outside.
    let arrive = seen ? cur.t : Math.min(prev.t + 500, leave ?? cur.t);
    if (leave !== null && leave < arrive) leave = arrive;
    const teleportedOut = seen && !!next && dist(next, f) - f.r > WALK_SLACK + ((next.t - path[j].t) / 1000) * WALK_SPEED;
    i = j;
    const last = [...out].reverse().find((v) => v.kind !== "death" || v.arrive <= arrive);
    if (last && last.kind !== "death" && last.leave !== null && arrive - last.leave <= MERGE_MS && arrive >= last.arrive) {
      last.leave = leave;
      last.teleportedOut = teleportedOut;
      continue;
    }
    const far = dist(prev, f) - f.r;
    if (!jumped && far <= WALK_FROM) {
      out.push({ id, kind: "walk", start: prev.t, arrive, since: prev.t, leave, from: { x: prev.x, y: prev.y }, channelSeen: false, teleportedOut });
      continue;
    }
    const channel = baronKills.some((b) => arrive - b >= 0 && arrive - b <= BARON_BUFF_MS + EMPOWERED_RECALL_MS) ? EMPOWERED_RECALL_MS : RECALL_MS;
    // The channel was seen when reads cover it and stay in one place.
    const during: Fix[] = [];
    for (let q = path.indexOf(prev); q >= 0 && path[q].t >= arrive - channel - 1500; q--) during.push(path[q]);
    const channelSeen = during.length >= 3 && during[during.length - 1].t <= arrive - channel + 2000 && during.every((p) => dist(p, prev) <= CHANNEL_DRIFT);
    out.push({ id, kind: "recall", start: arrive - channel, arrive, since: prev.t, leave, from: { x: prev.x, y: prev.y }, channelSeen, teleportedOut });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---- Minion ledger ----

/** Reads within this of a moment vote on how many minions are alive. */
const COUNT_WINDOW_MS = 3000;
/** A wave is hidden for a while as it leaves the base under the structure icons; a death only counts once the count stays down this long. */
const CONFIRM_MS = 20_000;

export interface LaneLedger {
  lane: Lane;
  /** The team whose minions these are. */
  team: 100 | 200;
  t: number[];
  /** Minions of `team` dead in this lane by each t, since the game began. */
  dead: number[];
  waves: WaveSpawn[];
  /** Minions spawned through each wave (cum[k] = total after wave k+1). */
  cum: number[];
}

/**
 * Cumulative deaths of one team's minions in one lane, by conservation. `ratio` is the share
 * of minions the scan reads as separate dots (see countRatio): alive = read / ratio, capped
 * at what has spawned and not yet died.
 */
export function laneLedger(track: WaveTrack, lane: Lane, team: 100 | 200, ratio = countRatio(track)): LaneLedger {
  const S = track.samples;
  const key = team === 100 ? "b" : "r";
  const t = S.map((s) => s.t);
  const raw = S.map((s) => s.lanes[lane][key].length);
  const until = t.length ? t[t.length - 1] : 0;
  const waves = waveSpawns(until);
  const cum: number[] = [];
  let acc = 0;
  for (const w of waves) cum.push((acc += waveSize(w)));
  const n = t.length;
  // Spawned minus alive, per read.
  const each = new Array<number>(n);
  let k = 0;
  let spawned = 0;
  for (let i = 0; i < n; i++) {
    while (k < waves.length && waves[k].t <= t[i]) spawned = cum[k++];
    each[i] = spawned - raw[i] / ratio;
  }
  // Clumped or covered minions read low, which makes this read high: take the lower quartile
  // of the reads within COUNT_WINDOW_MS.
  const obs = new Array<number>(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (t[i] - t[lo] > COUNT_WINDOW_MS) lo++;
    while (hi + 1 < n && t[hi + 1] - t[i] <= COUNT_WINDOW_MS) hi++;
    const w = each.slice(lo, hi + 1).sort((x, y) => x - y);
    obs[i] = w[Math.floor((w.length - 1) * 0.25)];
  }
  // Deaths can't be undone: a dip in the count that comes back within CONFIRM_MS was minions
  // hidden, not dead. So take the lowest value over the next CONFIRM_MS, then never decrease.
  const dead = new Array<number>(n);
  let run = 0;
  let h = 0;
  for (let i = 0; i < n; i++) {
    if (h < i) h = i;
    while (h + 1 < n && t[h + 1] - t[i] <= CONFIRM_MS) h++;
    let m = Infinity;
    for (let q = i; q <= h; q++) if (obs[q] < m) m = obs[q];
    run = Math.max(run, m, 0);
    dead[i] = run;
  }
  return { lane, team, t, dead, waves, cum };
}

function deadAt(l: LaneLedger, time: number): number {
  if (!l.t.length || time <= l.t[0]) return l.dead[0] ?? 0;
  let a = 0;
  let b = l.t.length - 1;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (l.t[m] <= time) a = m;
    else b = m - 1;
  }
  return l.dead[a];
}

export interface WaveLoss {
  /** Minions that died in the window. */
  minions: number;
  /** The same in waves (each wave by its own size). */
  waves: number;
  xp: number;
  /** Gold from last-hitting all of them. */
  gold: number;
  /** Cannon waves (1-based wave numbers) that were more than half alive at the start and fully dead by the end. */
  cannonWaves: number[];
  /** Which waves the deaths came from: wave number and how many of its minions. */
  byWave: { wave: number; minions: number; spawnedAt: number }[];
}

/** What died in a lane between two moments, in minions, waves, XP and gold. */
export function lostBetween(l: LaneLedger, from: number, to: number): WaveLoss {
  const a = deadAt(l, from);
  const b = Math.max(a, deadAt(l, to));
  const out: WaveLoss = { minions: b - a, waves: 0, xp: 0, gold: 0, cannonWaves: [], byWave: [] };
  for (let k = 0; k < l.waves.length; k++) {
    const lo = k ? l.cum[k - 1] : 0;
    const hi = l.cum[k];
    const n = Math.min(b, hi) - Math.max(a, lo);
    if (n <= 0) continue;
    const w = l.waves[k];
    const size = waveSize(w);
    out.waves += n / size;
    out.xp += (n / size) * waveXp(w);
    out.gold += (n / size) * waveGold(w);
    out.byWave.push({ wave: w.index, minions: n, spawnedAt: w.t });
    if (w.cannon && b >= hi && a <= lo + size / 2) out.cannonWaves.push(w.index);
  }
  out.minions = Math.round(out.minions * 10) / 10;
  for (const w of out.byWave) w.minions = Math.round(w.minions * 10) / 10;
  out.waves = Math.round(out.waves * 100) / 100;
  out.xp = Math.round(out.xp);
  out.gold = Math.round(out.gold);
  return out;
}

// ---- Recalls with their cost ----

/** More than this many waves lost to one trip is a bad back. */
export const BAD_BACK_WAVES = 1.5;
/** An enemy stack this much bigger than yours when you leave will reach your tower and die there. */
const PUSHING_IN_LEAD = 3;
/** Gold worth going to base for before an objective: the cheapest legendary component tier (a Pickaxe or Needlessly Large Rod class item costs 875 to 1300). */
export const WORTH_A_BACK = 1000;
/** A base visit this long before an objective spawns is "synced": you arrive at it with the items. */
const SYNC_MS = 90_000;

export type TempoFlag =
  /** More than BAD_BACK_WAVES of minions died in your lane while you were gone. */
  | "lost_waves"
  /** A cannon wave was alive when you left and dead when you got back. */
  | "missed_cannon"
  /** The enemy wave was the bigger one and on your side when you left: it walked into your tower. */
  | "left_wave_pushing_in"
  /** You were in base or on the way back when the enemy took an epic monster. */
  | "away_at_objective";

export interface Trip extends BaseVisit {
  lane: Lane | null;
  /** Last moment within XP range of the wave before leaving. */
  away: number;
  /** First moment back within XP range of the wave; null if the player went elsewhere. */
  back: number | null;
  /** End of the window the cost is counted over: `back`, or the earliest a walk from the fountain could have been back. */
  until: number;
  /** The lane as it stood when the player left. */
  state: LaneRead | null;
  loss: WaveLoss | null;
  /** Epic monsters the enemy took during the trip. */
  objectives: ObjectiveWindow[];
  flags: TempoFlag[];
}

function readAt(series: LaneRead[], t: number): LaneRead | null {
  if (!series.length) return null;
  let a = 0;
  let b = series.length - 1;
  while (a < b) {
    const m = (a + b) >> 1;
    if (series[m].t < t) a = m + 1;
    else b = m;
  }
  const c = a > 0 && Math.abs(series[a - 1].t - t) < Math.abs(series[a].t - t) ? series[a - 1] : series[a];
  return Math.abs(c.t - t) <= 3000 ? c : null;
}

/** Where enemy minions are dying: their lead minion (the front, in contact), else the only wave there is. */
/**
 * The lane as the minimap showed it when the player left: from the frame reads alone (LaneRead.seen)
 * in the STATE_MS before `t`, the latest frame with a minion read. Null when nothing was read, or
 * when a champion portrait covers the front at that moment (minions under it can't be counted:
 * checked on 14 trip starts in two games, followed and windowed leads put waves at the wrong
 * tower in 6). Never a followed lead.
 */
const STATE_MS = 3000;
/** A champion portrait's radius on the minimap in game units (12.5 px of 247 on a 14300-unit map), plus a dot. */
const STATE_COVER = 800;
function observedState(series: LaneRead[], t: number, lane: Lane, teamId: number, track: WaveTrack): LaneRead | null {
  let pick: LaneRead | null = null;
  for (const r of series) {
    if (r.t > t) break;
    if (r.t < t - STATE_MS || !r.seen) continue;
    if (r.seen.leadMine !== null || r.seen.leadTheirs !== null) pick = r;
  }
  if (!pick?.seen) return null;
  const s = pick.seen;
  const contact = s.leadMine !== null && s.leadTheirs !== null && s.leadTheirs - s.leadMine <= CONTACT;
  const front = contact ? (s.leadMine! + s.leadTheirs!) / 2 : s.leadMine === null ? s.leadTheirs : s.leadTheirs === null ? s.leadMine : null;
  if (front === null) return { ...pick, contact, front: null, zone: null, mine: s.mine, theirs: s.theirs, leadMine: s.leadMine, leadTheirs: s.leadTheirs, toMyTower: null, toTheirTower: null, inferred: undefined };
  // A portrait on the front hides the minions there.
  const L = laneLength(lane);
  const p = pointOnLane(lane, (teamId === 200 ? L - front : front) / L);
  let read: { t: number; at: { x: number; y: number }[] } | null = null;
  for (const c of track.champs ?? []) if (c.fog === "off" && Math.abs(c.t - pick.t) <= 1000 && (!read || Math.abs(c.t - pick.t) < Math.abs(read.t - pick.t))) read = c;
  if (read?.at.some((a) => Math.hypot(a.x - p.x, a.y - p.y) <= STATE_COVER)) return null;
  const toMyTower = front - s.myTower;
  const toTheirTower = s.theirTower - front;
  const atMine = s.leadTheirs !== null && s.leadTheirs <= s.myTower + TOWER_RANGE_UNITS;
  const atTheirs = s.leadMine !== null && s.leadMine >= s.theirTower - TOWER_RANGE_UNITS;
  const mid = (s.myTower + s.theirTower) / 2;
  const band = (s.theirTower - s.myTower) * 0.08;
  const zone: LaneRead["zone"] = atMine ? "my tower" : atTheirs ? "their tower" : front < mid - band ? "my side" : front > mid + band ? "their side" : "middle";
  return { ...pick, contact, front, zone, mine: s.mine, theirs: s.theirs, leadMine: s.leadMine, leadTheirs: s.leadTheirs, toMyTower, toTheirTower, inferred: undefined };
}
/** Turret range plus the target's size, as in wavestate. */
const TOWER_RANGE_UNITS = 900;

function frontPoint(r: LaneRead | null, lane: Lane, teamId: number): Pt | null {
  const at = r ? (r.leadTheirs ?? r.front ?? r.leadMine) : null;
  if (at === null) return null;
  const p = at / laneLength(lane);
  return pointOnLane(lane, teamId === 200 ? 1 - p : p);
}

export interface TempoInput {
  track: WaveTrack;
  match: MatchDto;
  timeline: TimelineDto;
  /** Participant id of the player. */
  id: number;
}

const eventsOf = (tl: TimelineDto) => tl.info.frames.flatMap((f) => f.events ?? []);

/**
 * A champion's deaths with the moment each respawned. The HP bar reads 0 while dead and
 * full at the respawn (checked 36 of 36 on a real scan); Live Client's isDead is the second
 * source. Null when the scan has neither around that death.
 */
export function deathsOf(events: TimelineEvent[], id: number, track?: WaveTrack, champion?: string): Death[] {
  const hud = track?.hud ?? [];
  const key = champion ? champion.toLowerCase().replace(/[^a-z0-9]/g, "") : null;
  const live = key ? [...(track?.live ?? [])].sort((a, b) => a.t - b.t) : [];
  const kills = events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === id).sort((a, b) => a.timestamp - b.timestamp);
  return kills.map((e, k) => {
    const next = kills[k + 1]?.timestamp ?? Infinity;
    let respawn: number | null = null;
    let sawDead = false;
    for (const h of hud) {
      if (h.t < e.timestamp + 1000) continue;
      if (h.t > Math.min(next, e.timestamp + MAX_RESPAWN_MS)) break;
      const v = h.hp[id - 1];
      if (v === null || v === undefined) continue;
      if (v <= 2) sawDead = true;
      else if (sawDead && h.t >= e.timestamp + 5000) {
        respawn = h.t;
        break;
      }
    }
    if (respawn === null) {
      let wasDead = false;
      for (const poll of live) {
        if (poll.t < e.timestamp || poll.t > Math.min(next, e.timestamp + MAX_RESPAWN_MS)) continue;
        const pl = poll.players.find((x) => x.championName.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
        if (!pl) continue;
        if (pl.isDead) wasDead = true;
        else if (wasDead) {
          respawn = poll.t;
          break;
        }
      }
    }
    return { t: e.timestamp, at: e.position ?? null, respawn };
  });
}

/** Every base visit of the player with what it cost in their lane. */
export function trips({ track, match, timeline, id }: TempoInput): Trip[] {
  const me = match.info.participants.find((p) => p.participantId === id);
  if (!me) return [];
  const teamId = me.teamId === 200 ? 200 : 100;
  const enemy = teamId === 100 ? 200 : 100;
  const events = eventsOf(timeline);
  const path = pathOf(track, id);
  const barons = events.filter((e) => e.type === "ELITE_MONSTER_KILL" && e.monsterType === "BARON_NASHOR" && e.killerTeamId === teamId).map((e) => e.timestamp);
  const visits = baseVisits(id, path, teamId, deathsOf(events, id, track, me.championName), barons);
  const lane = laneOf(me.teamPosition);
  const geo = laneGeometry(events);
  const series = lane ? laneSeries(track, lane, teamId, geo) : [];
  const ledger = lane ? laneLedger(track, lane, enemy) : null;
  const lastT = track.samples.length ? track.samples[track.samples.length - 1].t : 0;
  const objectives = objectiveWindows(events, lastT);
  const f = fountainOf(teamId);
  const atWave = (p: Fix) => {
    const fp = lane ? frontPoint(readAt(series, p.t), lane, teamId) : null;
    return !!fp && dist(p, fp) <= XP_RANGE;
  };
  return visits.map((v, vi) => {
    const nextStart = visits[vi + 1]?.start ?? Infinity;
    // Leaving the wave: the last read in XP range in the 20 s before the trip began.
    let away = v.start;
    if (v.kind !== "death") {
      for (const p of path) {
        if (p.t > v.start) break;
        if (p.t >= v.start - 20_000 && atWave(p)) away = p.t;
      }
      if (away > v.start) away = v.start;
    }
    let back: number | null = null;
    if (v.leave !== null) {
      for (const p of path) {
        if (p.t <= v.leave) continue;
        if (p.t > v.leave + 150_000 || p.t >= nextStart) break;
        if (atWave(p)) {
          back = p.t;
          break;
        }
      }
    }
    const leave = v.leave ?? lastT;
    let until = back ?? leave;
    if (back === null && lane) {
      const fp = frontPoint(readAt(series, leave), lane, teamId);
      if (fp) until = Math.min(lastT, leave + (dist(f, fp) / RETURN_SPEED) * 1000);
    }
    // The next trip counts its own time.
    until = Math.min(until, nextStart);
    const state = lane ? observedState(series, away, lane, teamId, track) : null;
    const loss = ledger ? lostBetween(ledger, away, until) : null;
    // Being in base when one spawns costs nothing by itself; being away when it is taken does.
    const objs = objectives.filter((o) => o.taken !== null && o.by !== teamId && o.taken >= v.start && o.taken <= until);
    const flags: TempoFlag[] = [];
    if (loss && loss.waves > BAD_BACK_WAVES) flags.push("lost_waves");
    if (loss?.cannonWaves.length) flags.push("missed_cannon");
    if (v.kind !== "death" && state && state.theirs - state.mine >= PUSHING_IN_LEAD && (state.zone === "my side" || state.zone === "my tower")) flags.push("left_wave_pushing_in");
    if (v.kind !== "death" && objs.length) flags.push("away_at_objective");
    return { ...v, lane, away, back, until, state, loss, objectives: objs, flags };
  });
}

// ---- Objective sync ----

export interface ObjectiveSync extends ObjectiveWindow {
  /** When the player last left base before it spawned; null if never in the scan. */
  lastBase: number | null;
  /** Unspent gold in the last timeline frame before it spawned. */
  gold: number | null;
  /** How far the player was from the pit when it was taken (units); null without a read. */
  distanceAtTake: number | null;
  /** In base, recalling or walking back (not dead) when it was taken. */
  away: boolean;
  /** Went into it with WORTH_A_BACK or more unspent and no base visit in the SYNC_MS before the spawn. */
  unspent: boolean;
}

/** For each epic monster in the scan: whether the player's last base visit set them up for it. */
export function objectiveSync(input: TempoInput, ts: Trip[] = trips(input)): ObjectiveSync[] {
  const { track, timeline, id } = input;
  const lastT = track.samples.length ? track.samples[track.samples.length - 1].t : 0;
  const path = pathOf(track, id);
  return objectiveWindows(eventsOf(timeline), lastT).map((o) => {
    const before = ts.filter((v) => v.leave !== null && v.leave <= o.spawn);
    const lastBase = before.length ? before[before.length - 1].leave : null;
    const frame = [...timeline.info.frames].reverse().find((fr) => fr.timestamp <= o.spawn);
    const gold = frame?.participantFrames[String(id)]?.currentGold ?? null;
    let distanceAtTake: number | null = null;
    if (o.taken !== null) {
      let best: Fix | null = null;
      for (const p of path) if (!best || Math.abs(p.t - o.taken) < Math.abs(best.t - o.taken)) best = p;
      if (best && Math.abs(best.t - o.taken) <= 3000) distanceAtTake = Math.round(dist(best, PITS[o.type]));
    }
    const away = ts.some((v) => v.kind !== "death" && o.taken !== null && o.taken >= v.start && o.taken <= v.until);
    const unspent = gold !== null && gold >= WORTH_A_BACK && (lastBase === null || o.spawn - lastBase > SYNC_MS);
    return { ...o, lastBase, gold, distanceAtTake, away, unspent };
  });
}

// ---- Checks against ground truth ----

/**
 * Items can only be bought on the fountain platform (or while dead). So every purchase in
 * the timeline has to fall inside a base visit this engine found, for all ten players.
 * Purchases within 30 s of each other are one shop stop.
 */
export function checkBaseVisits(track: WaveTrack, match: MatchDto, timeline: TimelineDto, until: number) {
  const events = eventsOf(timeline);
  const first = track.champs?.find((s) => s.fog === "off")?.t ?? Infinity;
  let n = 0;
  let ok = 0;
  const byKind: Record<string, number> = { recall: 0, death: 0, walk: 0 };
  const missed: { id: number; champion: string; t: number }[] = [];
  for (const p of match.info.participants) {
    const path = pathOf(track, p.participantId);
    const deaths = deathsOf(events, p.participantId, track, p.championName);
    const barons = events.filter((e) => e.type === "ELITE_MONSTER_KILL" && e.monsterType === "BARON_NASHOR" && e.killerTeamId === p.teamId).map((e) => e.timestamp);
    const visits = baseVisits(p.participantId, path, p.teamId, deaths, barons);
    const buys = events.filter((e) => e.type === "ITEM_PURCHASED" && e.participantId === p.participantId).map((e) => e.timestamp).sort((a, b) => a - b);
    const stops: number[] = [];
    for (const t of buys) if (!stops.length || t - stops[stops.length - 1] > 30_000) stops.push(t);
    for (const t of stops) {
      // The first visit can't be classified without a read before it, and the scan's last seconds have no "leave".
      if (t < first + 15_000 || t > until - 5000) continue;
      n++;
      const v = visits.find((x) => t >= Math.min(x.since, x.arrive - 2000) && t <= (x.leave ?? until) + 2000);
      if (v) {
        ok++;
        byKind[v.kind]++;
      } else missed.push({ id: p.participantId, champion: p.championName, t });
    }
  }
  return {
    name: "tempo: every shop stop falls inside a detected base visit (all ten players)",
    measured: `${n ? Math.round((ok / n) * 1000) / 10 : 0}% (${ok}/${n}); by recall ${byKind.recall}, after a death ${byKind.death}, on foot ${byKind.walk}`,
    bar: ">= 90%",
    pass: n > 0 && ok / n >= 0.9,
    n,
    detail: missed,
  };
}

/** Fresh minions are counted within this of their own inhibitor (the wave before is 9750 units ahead by the next spawn). */
const FRESH_UNITS = 5000;

export interface FreshWave {
  wave: number;
  lane: Lane;
  team: number;
  /** Minions the wave has. */
  want: number;
  /** Minions the scan gained near that base after the spawn. */
  got: number;
  /** How long after the scheduled spawn the gain showed (ms); null if it never did. */
  delay: number | null;
}

/** Each scheduled wave as the scan saw it leave its base. */
export function freshWaves(track: WaveTrack, until: number): FreshWave[] {
  const S = track.samples;
  const first = S[0]?.t ?? Infinity;
  const rows: FreshWave[] = [];
  for (const w of waveSpawns(until)) {
    if (w.t < first + 3000 || w.t + 20_000 > until) continue;
    for (const lane of LANES) {
      const L = laneLength(lane);
      for (const team of [100, 200] as const) {
        const fresh = (i: number) => S[i].lanes[lane][team === 100 ? "b" : "r"].filter((p) => (team === 100 ? p : 1 - p) * L <= FRESH_UNITS).length;
        const pre: number[] = [];
        const post: number[] = [];
        let delay: number | null = null;
        let base = 0;
        for (let i = 0; i < S.length; i++) {
          const dt = S[i].t - w.t;
          if (dt < -3000) continue;
          if (dt > 20_000) break;
          if (dt <= 0) {
            pre.push(fresh(i));
            base = [...pre].sort((a, b) => a - b)[pre.length >> 1];
            continue;
          }
          const c = fresh(i);
          if (delay === null && c - base >= 3) delay = dt;
          if (dt >= 8000 && dt <= 18_000) post.push(c);
        }
        if (!pre.length || !post.length) continue;
        post.sort((a, b) => a - b);
        rows.push({ wave: w.index, lane, team, want: waveSize(w), got: post[Math.min(post.length - 1, Math.floor(post.length * 0.75))] - base, delay });
      }
    }
  }
  return rows;
}

/**
 * The share of a wave's minions the scan reads as separate dots, measured on this scan's own
 * fresh waves (their true size is known). Minions walking two abreast merge into one dot and
 * some sit under tower icons, so this is below 1 (about 0.7 on the two scans it was first
 * measured on). 1 when the scan has no fresh wave to measure.
 */
export function countRatio(track: WaveTrack): number {
  const until = track.samples.length ? track.samples[track.samples.length - 1].t : 0;
  const rows = freshWaves(track, until).filter((r) => r.delay !== null && r.delay <= 12_000 && r.got > 0);
  if (rows.length < 6) return 1;
  const ratio = rows.reduce((a, r) => a + r.got, 0) / rows.reduce((a, r) => a + r.want, 0);
  return Math.max(0.4, Math.min(1, Math.round(ratio * 100) / 100));
}

/**
 * Checks the wave schedule against the scan: after each scheduled spawn, each lane must gain
 * minions near that base, on time. A wrong schedule (the pre-2026 1:05 start, a wrong
 * interval) fails this. It also reports how many of each wave's minions were read.
 */
export function checkWaveSchedule(track: WaveTrack, until: number) {
  const rows = freshWaves(track, until);
  const n = rows.length;
  const exact = rows.filter((r) => r.got === r.want).length;
  const near = rows.filter((r) => Math.abs(r.got - r.want) <= 1).length;
  const onTime = rows.filter((r) => r.delay !== null && r.delay <= 12_000).length;
  const delays = rows.map((r) => r.delay).filter((d): d is number => d !== null).sort((a, b) => a - b);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const pct = (k: number) => (n ? Math.round((k / n) * 1000) / 10 : 0);
  const hist: Record<string, number> = {};
  for (const r of rows) hist[r.got] = (hist[r.got] ?? 0) + 1;
  return {
    name: "waves: each scheduled wave shows up near its base on time",
    measured: `on time ${pct(onTime)}% (${onTime}/${n}), median ${delays.length ? delays[delays.length >> 1] : "-"} ms after the scheduled spawn; minions read per wave: exact ${pct(exact)}%, within one ${pct(near)}%, mean ${mean(rows.filter((r) => r.want === 7).map((r) => r.got))} on cannon waves and ${mean(rows.filter((r) => r.want === 6).map((r) => r.got))} on others; read ratio ${countRatio(track)}`,
    bar: "on time >= 90%",
    pass: n > 0 && onTime / n >= 0.9,
    n,
    detail: { gained: hist, late: rows.filter((r) => r.delay === null || r.delay > 12_000) },
  };
}

/**
 * Checks the minion ledger against Riot's own count. Every lane minion a champion last-hits
 * is an enemy minion that died, so over any stretch a team's CS gain can't exceed the enemy
 * minion deaths the ledger counts over the three lanes (the rest die to minions and towers).
 */
export function checkLedger(track: WaveTrack, match: MatchDto, timeline: TimelineDto, until: number) {
  const first = track.samples[0]?.t ?? Infinity;
  const frames = timeline.info.frames.filter((f) => f.timestamp >= first && f.timestamp <= until);
  let n = 0;
  let ok = 0;
  const teams: Record<number, { cs: number; dead: number; spawned: number }> = {};
  const detail: { team: number; t: number; cs: number; dead: number }[] = [];
  for (const team of [100, 200] as const) {
    const enemy = team === 100 ? 200 : 100;
    const ledgers = LANES.map((lane) => laneLedger(track, lane, enemy));
    const ids = match.info.participants.filter((p) => p.teamId === team).map((p) => p.participantId);
    const cs = (f: (typeof frames)[number]) => ids.reduce((a, id) => a + (f.participantFrames[String(id)]?.minionsKilled ?? 0), 0);
    const dead = (t: number) => ledgers.reduce((a, l) => a + deadAt(l, t), 0);
    if (frames.length < 2) continue;
    const f0 = frames[0];
    for (const f of frames.slice(1)) {
      n++;
      const c = cs(f) - cs(f0);
      const d = dead(f.timestamp) - dead(f0.timestamp);
      // Three minions of slack: one read's worth of error per lane.
      if (d >= c - 3) ok++;
      else detail.push({ team, t: f.timestamp, cs: c, dead: Math.round(d) });
    }
    const fl = frames[frames.length - 1];
    const spawned = (t: number) => ledgers.reduce((a, l) => a + l.waves.filter((w) => w.t <= t).reduce((x, w) => x + waveSize(w), 0), 0);
    teams[team] = { cs: cs(fl) - cs(f0), dead: Math.round(dead(fl.timestamp) - dead(f0.timestamp)), spawned: spawned(fl.timestamp) - spawned(f0.timestamp) };
  }
  const line = (t: number) => (teams[t] ? `team ${t}: ${teams[t].cs} CS of ${teams[t].dead} enemy minion deaths counted (${teams[t].spawned} spawned)` : "");
  return {
    name: "tempo: a team's CS never exceeds the enemy minion deaths the ledger counts",
    measured: `${n ? Math.round((ok / n) * 1000) / 10 : 0}% of minute marks (${ok}/${n}); ${line(100)}; ${line(200)}`,
    bar: ">= 90% of minute marks",
    pass: n > 0 && ok / n >= 0.9,
    n,
    detail,
  };
}
