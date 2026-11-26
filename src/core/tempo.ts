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
import { laneGeometry, laneSeries, type LaneRead } from "./wavestate";

type Pt = { x: number; y: number };
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const fountainOf = (teamId: number) => FOUNTAINS[teamId === 200 ? 1 : 0];

/** Champions walk at 325 to about 450 units a second in lane; 500 plus 600 units of slack is the most a walk can cover (same rule as vision.ts canReach). */
const WALK_SPEED = 500;
const WALK_SLACK = 600;
/** A walk back to base only counts from this close; from further out, a long gap between reads is a recall the scan didn't see the channel of. */
const WALK_FROM = 4500;
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
  /** First read in the fountain. */
  arrive: number;
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
export function baseVisits(id: number, path: Fix[], teamId: number, deaths: { t: number; at: Pt | null }[], baronKills: number[] = []): BaseVisit[] {
  const f = fountainOf(teamId);
  const inBase = (p: Pt) => dist(p, f) <= f.r;
  const out: BaseVisit[] = [];
  for (let i = 0; i < path.length; i++) {
    if (!inBase(path[i])) continue;
    let j = i;
    while (j + 1 < path.length && inBase(path[j + 1])) j++;
    const first = i;
    i = j;
    // In base when the scan began: nothing before it to tell how they got there.
    if (first === 0) continue;
    // One read alone isn't a visit (a single misread ring over the fountain).
    if (j === first) continue;
    const prev = path[first - 1];
    const arrive = path[first].t;
    const leave = j + 1 < path.length ? path[j].t : null;
    const next = path[j + 1];
    const teleportedOut = !!next && dist(next, f) - f.r > WALK_SLACK + ((next.t - path[j].t) / 1000) * WALK_SPEED;
    const last = out[out.length - 1];
    if (last && last.leave !== null && arrive - last.leave <= MERGE_MS) {
      last.leave = leave;
      last.teleportedOut = teleportedOut;
      continue;
    }
    const death = deaths.find((d) => d.t >= prev.t - 5000 && d.t <= arrive);
    if (death) {
      out.push({ id, kind: "death", start: death.t, arrive, leave, from: death.at ?? { x: prev.x, y: prev.y }, channelSeen: false, teleportedOut });
      continue;
    }
    const gap = arrive - prev.t;
    const far = dist(prev, f) - f.r;
    const walkable = far <= WALK_SLACK + (gap / 1000) * WALK_SPEED;
    if (walkable && far <= WALK_FROM) {
      out.push({ id, kind: "walk", start: prev.t, arrive, leave, from: { x: prev.x, y: prev.y }, channelSeen: false, teleportedOut });
      continue;
    }
    const channel = baronKills.some((b) => arrive - b >= 0 && arrive - b <= BARON_BUFF_MS + EMPOWERED_RECALL_MS) ? EMPOWERED_RECALL_MS : RECALL_MS;
    // The channel was seen when reads cover it and stay in one place.
    const during: Fix[] = [];
    for (let k = first - 1; k >= 0 && path[k].t >= arrive - channel - 1500; k--) during.push(path[k]);
    const channelSeen = during.length >= 3 && during[during.length - 1].t <= arrive - channel + 2000 && during.every((p) => dist(p, prev) <= CHANNEL_DRIFT);
    out.push({ id, kind: "recall", start: arrive - channel, arrive, leave, from: { x: prev.x, y: prev.y }, channelSeen, teleportedOut });
  }
  return out;
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
  /** You were in base or on the way back when an epic monster spawned or was taken. */
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
  /** Epic monsters that spawned or were taken during the trip. */
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

function deathsOf(events: TimelineEvent[], id: number) {
  return events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === id).map((e) => ({ t: e.timestamp, at: e.position ?? null }));
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
  const visits = baseVisits(id, path, teamId, deathsOf(events, id), barons);
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
  return visits.map((v) => {
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
        if (p.t > v.leave + 150_000) break;
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
    const state = lane ? readAt(series, away) : null;
    const loss = ledger ? lostBetween(ledger, away, until) : null;
    const objs = objectives.filter((o) => (o.spawn >= v.start && o.spawn <= until) || (o.taken !== null && o.taken >= v.start && o.taken <= until));
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
  /** In base, recalling or walking back when it spawned or when it was taken. */
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
    const away = ts.some((v) => v.kind !== "death" && ((o.spawn >= v.start && o.spawn <= v.until) || (o.taken !== null && o.taken >= v.start && o.taken <= v.until)));
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
    const deaths = deathsOf(events, p.participantId);
    const barons = events.filter((e) => e.type === "ELITE_MONSTER_KILL" && e.monsterType === "BARON_NASHOR" && e.killerTeamId === p.teamId).map((e) => e.timestamp);
    const visits = baseVisits(p.participantId, path, p.teamId, deaths, barons);
    const buys = events.filter((e) => e.type === "ITEM_PURCHASED" && e.participantId === p.participantId).map((e) => e.timestamp).sort((a, b) => a - b);
    const stops: number[] = [];
    for (const t of buys) if (!stops.length || t - stops[stops.length - 1] > 30_000) stops.push(t);
    for (const t of stops) {
      // The first visit can't be classified without a read before it, and the scan's last seconds have no "leave".
      if (t < first + 15_000 || t > until - 5000) continue;
      n++;
      const v = visits.find((x) => t >= (x.kind === "death" ? x.start : x.arrive - 2000) && t <= (x.leave ?? until) + 2000);
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
