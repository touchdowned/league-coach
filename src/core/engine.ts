/**
 * Replay-reading engine.
 *
 * Reads one game's timeline and finds every place gold leaked out of your game, deaths
 * or not: recalls that cost farm, plates or an objective, minutes where your lane
 * opponent out-farmed you, roams that bought nothing, objectives taken while you were
 * across the map, and deaths. Each leak gets an estimated gold cost so the biggest
 * levers come first, an inferred read of what you were doing (from your path, wards,
 * purchases and fights), and a "next time" built from the actual map state.
 *
 * Wave state: when the replay has been read (see minimap.ts / waves.ts), minion
 * positions come from the replay's minimap and the advice quotes them. Without it,
 * wave state is inferred from CS differences. Costs are estimates and say so.
 */
import { fmtTime } from "./analysis";
import { describeSpot, dist, positionAt, Track } from "./track";
import type { MatchDto, Participant, ParticipantFrame, TimelineDto, TimelineEvent } from "./types";
import { hasVision, lastSeen, truthAt, visibleAt } from "./vision";
import { laneOf, waveAt, waveSeries, type WaveRead, type WaveTrack } from "./waves";
import { champName } from "./names";
import { pressureAt, type Pressure } from "./pressure";

export type LeakKind = "recall" | "farm" | "roam" | "objective" | "death";

export interface Leak {
  kind: LeakKind;
  t: number;
  /** Estimated gold cost; the parts add up to it. */
  cost: number;
  costParts: { label: string; gold: number }[];
  title: string;
  /** What you were most likely doing, and the evidence for it. */
  doing: string;
  /** Facts from the timeline behind this leak. */
  evidence: string[];
  /** A concrete alternative for the same situation. */
  nextTime: string;
  /** Map spot to look at. */
  focus: { x: number; y: number } | null;
  /** For deaths, the matching Mistake's time, so review can link them. */
  deathMs?: number;
  /** For linking the same mistake across games: why, where, when. */
  tags?: LeakTags;
  /** Recalls: who was in reach when you left, and since when you had the gold. */
  recall?: RecallContext;
}

export interface RecallContext {
  /** Pushing the wave first was not on: outnumbered, or an enemy in reach was a breakpoint or 875 gold ahead. */
  blocked: boolean;
  /** The count of champions in reach, in a sentence. */
  line: string;
  /** After the laning phase: lane-crash timing doesn't decide this recall. */
  late: boolean;
  /** When you first held an item's worth of gold before this recall, and how much. */
  richAt?: number;
  richGold?: number;
}

export interface LeakTags {
  cause: string;
  area: string;
  phase: "early" | "mid" | "late";
  /** Deaths with the replay read: did you have the information? */
  vision?: "seen" | "unseen";
}

const phaseOf = (t: number): LeakTags["phase"] => (t < LANE_END ? "early" : t < 25 * MIN ? "mid" : "late");

/** A coarse place name, so the same spot in different games groups together. */
export function areaOf(p: { x: number; y: number }, myTeam: number): string {
  const d = describeSpot(p, myTeam);
  if (/dragon/.test(d)) return "the dragon-side river";
  if (/baron/.test(d)) return "the baron-side river";
  if (/mid lane/.test(d)) return "mid lane";
  if (/top lane/.test(d)) return "top lane";
  if (/bottom lane/.test(d)) return "bottom lane";
  if (/their/.test(d)) return "their jungle";
  if (/your/.test(d)) return "your jungle";
  return "near a base";
}

const MIN = 60_000;
const LANE_END = 14 * MIN;
const GOLD_PER_CS = 21;
const MOVE_SPEED = 360; // units per second, early boots-ish
// Rough gold-equivalent values, used only to rank leaks against each other.
const OBJECTIVE_VALUE: Record<string, number> = { DRAGON: 350, BARON_NASHOR: 1200, RIFTHERALD: 450, HORDE: 250, ATAKHAN: 500 };
const OBJECTIVE_NAME: Record<string, string> = { DRAGON: "dragon", BARON_NASHOR: "baron", RIFTHERALD: "herald", HORDE: "voidgrubs", ATAKHAN: "Atakhan" };
const PIT = { DRAGON: { x: 9866, y: 4414 }, BARON: { x: 5007, y: 10471 } };
const FOUNTAIN: Record<number, { x: number; y: number }> = { 100: { x: 400, y: 400 }, 200: { x: 14340, y: 14390 } };
// Death timers by level (seconds), before late-game scaling.
const DEATH_TIMER = [0, 6, 6, 8, 8, 10, 12, 16, 21, 26, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50, 52.5];

interface Ctx {
  match: MatchDto;
  timeline: TimelineDto;
  track: Track;
  me: Participant;
  opp: Participant | null;
  byId: Map<number, Participant>;
  events: TimelineEvent[];
  /** Minion positions read from the replay, when available. */
  waves?: WaveTrack;
  windows?: RecallWindow[];
}

/** A moment your wave was crashing into their tower and you had item gold: a free recall. */
export interface RecallWindow {
  t: number;
  end: number;
  gold: number;
  taken: boolean;
}

/** Shop visits that were recalls (not respawns), by purchase time. */
function recallVisits(c: Ctx, deaths: TimelineEvent[]): number[] {
  const buys = c.events.filter((e) => e.type === "ITEM_PURCHASED" && e.participantId === c.me.participantId && e.timestamp > 90_000);
  const visits: number[] = [];
  for (const b of buys) if (!visits.length || b.timestamp - visits[visits.length - 1] > 45_000) visits.push(b.timestamp);
  return visits.filter((t0) => !deaths.some((d) => t0 > d.timestamp && t0 - d.timestamp < 75_000));
}

const WINDOW_GOLD = 1100;

function findWindows(c: Ctx, deaths: TimelineEvent[]): RecallWindow[] {
  const lane = laneOf(c.me.teamPosition);
  if (!lane || !c.waves) return [];
  const lefts = recallVisits(c, deaths).map((t0) => t0 - 10_000);
  const out: RecallWindow[] = [];
  let cur: RecallWindow | null = null;
  for (const r of waveSeries(c.waves, 90_000, LANE_END, lane, c.me.teamId)) {
    const gold = goldInPocket(c, r.t);
    const ok = r.where === "under their tower" && r.mine >= 3 && gold >= WINDOW_GOLD && !wasDeadAt(c, deaths, r.t);
    if (!ok) continue;
    if (cur && r.t - cur.end <= 8000) cur.end = r.t;
    else {
      if (cur) out.push(cur);
      cur = { t: r.t, end: r.t, gold: Math.round(gold), taken: false };
    }
  }
  if (cur) out.push(cur);
  for (const w of out) w.taken = lefts.some((l) => l >= w.t - 5000 && l <= w.end + 25_000);
  return out;
}

/** Every recall window in the laning phase, taken or passed. Needs the replay read. */
export function recallWindows(match: MatchDto, timeline: TimelineDto, track: Track, me: Participant, waves?: WaveTrack): RecallWindow[] {
  const events = timeline.info.frames.flatMap((f) => f.events ?? []).sort((a, b) => a.timestamp - b.timestamp);
  const c: Ctx = { match, timeline, track, me, opp: null, byId: new Map(match.info.participants.map((p) => [p.participantId, p])), events, waves };
  return findWindows(c, events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === me.participantId));
}

/** Your lane's wave at time t, from the replay, if it was read and you were laning. */
function myWave(c: Ctx, t: number): WaveRead | null {
  const lane = laneOf(c.me.teamPosition);
  return lane && t < LANE_END + 2 * MIN ? waveAt(c.waves, t, lane, c.me.teamId) : null;
}

export function readGame(match: MatchDto, timeline: TimelineDto, track: Track, me: Participant, opp: Participant | null, waves?: WaveTrack): Leak[] {
  const events = timeline.info.frames.flatMap((f) => f.events ?? []).sort((a, b) => a.timestamp - b.timestamp);
  const c: Ctx = { match, timeline, track, me, opp, byId: new Map(match.info.participants.map((p) => [p.participantId, p])), events, waves };
  const deaths = events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === me.participantId);
  c.windows = findWindows(c, deaths);
  const leaks = [...recallLeaks(c, deaths), ...farmLeaks(c, deaths), ...objectiveLeaks(c, deaths), ...deaths.map((d) => deathLeak(c, d))];
  return leaks.filter((l) => l.cost >= 100).sort((a, b) => b.cost - a.cost);
}

// ---------- helpers ----------

function frameNear(c: Ctx, t: number): ParticipantFrame | undefined {
  const fs = c.timeline.info.frames;
  let best = fs[0];
  for (const f of fs) if (f.timestamp <= t) best = f;
  return best?.participantFrames[String(c.me.participantId)];
}

/** Linear interpolation of a per-frame number for any participant. */
function lerp(c: Ctx, id: number, t: number, pick: (f: ParticipantFrame) => number): number | null {
  const fs = c.timeline.info.frames;
  let a: (typeof fs)[number] | undefined;
  let b: (typeof fs)[number] | undefined;
  for (const f of fs) {
    if (f.timestamp <= t) a = f;
    else {
      b = f;
      break;
    }
  }
  const fa = a?.participantFrames[String(id)];
  const fb = b?.participantFrames[String(id)];
  if (!fa) return fb ? pick(fb) : null;
  if (!fb || !b || !a) return pick(fa);
  const k = (t - a.timestamp) / Math.max(1, b.timestamp - a.timestamp);
  return pick(fa) + (pick(fb) - pick(fa)) * k;
}

const csOf = (f: ParticipantFrame) => f.minionsKilled + f.jungleMinionsKilled;
const cs = (c: Ctx, id: number, t: number) => lerp(c, id, t, csOf) ?? 0;

function goldInPocket(c: Ctx, t: number): number {
  // Gold on hand just before t: last frame's current gold plus what was earned since.
  const f = frameNear(c, t);
  if (!f) return 0;
  const earned = (lerp(c, c.me.participantId, t, (x) => x.totalGold) ?? f.totalGold) - f.totalGold;
  return Math.max(0, Math.round(f.currentGold + earned));
}

function levelAt(c: Ctx, t: number): number {
  return frameNear(c, t)?.level ?? 1;
}

/** Your farm rate over the 3 minutes before t, in CS per minute. */
function csRate(c: Ctx, t: number): number {
  const a = cs(c, c.me.participantId, Math.max(0, t - 3 * MIN));
  const b = cs(c, c.me.participantId, t);
  return Math.max(3, (b - a) / Math.min(3, Math.max(1, t / MIN)));
}

function myLane(c: Ctx): string | null {
  return c.me.teamPosition === "TOP" ? "TOP_LANE" : c.me.teamPosition === "MIDDLE" ? "MID_LANE" : c.me.teamPosition === "BOTTOM" || c.me.teamPosition === "UTILITY" ? "BOT_LANE" : null;
}

const name = (c: Ctx, id: number) => c.byId.get(id)?.championName ?? "someone";
const spot = (c: Ctx, p: { x: number; y: number }) => describeSpot(p, c.me.teamId);
const g = (n: number) => `${Math.round(n).toLocaleString("en-US")}g`;
const near = (c: Ctx, at: number, id: number) => positionAt(c.track, id, at);

function wasDeadAt(c: Ctx, deaths: TimelineEvent[], t: number): boolean {
  return deaths.some((d) => t >= d.timestamp && t <= d.timestamp + (DEATH_TIMER[levelAt(c, d.timestamp)] ?? 30) * 1000 + 3000);
}

/** Dragon and baron availability at t, from kills and respawn timers. */
function objectiveUp(c: Ctx, t: number, type: "DRAGON" | "BARON_NASHOR"): boolean {
  const [first, respawn] = type === "DRAGON" ? [5 * MIN, 5 * MIN] : [20 * MIN, 6 * MIN];
  if (t < first) return false;
  const last = c.events.filter((e) => e.type === "ELITE_MONSTER_KILL" && e.monsterType === type && e.timestamp <= t).pop();
  return !last || t - last.timestamp >= respawn;
}

function lostWhile(c: Ctx, from: number, to: number) {
  const objectives = c.events.filter((e) => e.type === "ELITE_MONSTER_KILL" && e.killerTeamId && e.killerTeamId !== c.me.teamId && e.timestamp >= from && e.timestamp <= to);
  const lane = myLane(c);
  const plates = c.events.filter((e) => e.type === "TURRET_PLATE_DESTROYED" && e.teamId === c.me.teamId && (!lane || e.laneType === lane) && e.timestamp >= from && e.timestamp <= to);
  const towers = c.events.filter((e) => e.type === "BUILDING_KILL" && e.teamId === c.me.teamId && e.buildingType === "TOWER_BUILDING" && (!lane || e.laneType === lane) && e.timestamp >= from && e.timestamp <= to);
  return { objectives, plates, towers };
}

// ---------- recalls ----------

function recallLeaks(c: Ctx, deaths: TimelineEvent[]): Leak[] {
  const out: Leak[] = [];
  let prevVisit = 0;
  for (const t0 of recallVisits(c, deaths)) {
    const lastVisit = prevVisit;
    prevVisit = t0;
    const from = positionAt(c.track, c.me.participantId, t0 - 20_000);
    if (!from) continue;
    const walk = Math.min(60, dist(from, FOUNTAIN[c.me.teamId]) / MOVE_SPEED);
    const leftAt = t0 - 10_000;
    const backAt = t0 + walk * 1000;
    const pocket = goldInPocket(c, t0 - 1000);
    const parts: { label: string; gold: number }[] = [];
    const evidence: string[] = [];
    const tips: string[] = [];
    const late = t0 >= LANE_END + MIN;
    const pressure: Pressure | null = pressureAt(
      {
        players: c.track.players,
        meId: c.me.participantId,
        timeline: c.timeline,
        // Only positions known to within a few seconds count: a guess between two minute marks doesn't put anyone in reach.
        pos: (id, t) => {
          const p = positionAt(c.track, id, t);
          return p && !p.dead && (id === c.me.participantId || p.certainty >= 0.8) ? p : null;
        },
      },
      leftAt,
    );
    const blocked = !!pressure?.blocked;
    let richAt: number | undefined;
    let richGold: number | undefined;

    // Farm lost around the trip, measured against your lane opponent during laning.
    let lostCs = 0;
    if (c.opp && t0 < LANE_END + MIN) {
      const winA = t0 - 60_000;
      const winB = backAt + 45_000;
      const mine = cs(c, c.me.participantId, winB) - cs(c, c.me.participantId, winA);
      const theirs = cs(c, c.opp.participantId, winB) - cs(c, c.opp.participantId, winA);
      lostCs = Math.max(0, Math.round(theirs - mine));
      if (lostCs >= 4) {
        evidence.push(`${champName(c.opp.championName)} took ${lostCs} more CS than you between ${fmtTime(winA)} and ${fmtTime(winB)}.`);
        tips.push(`Shove the wave into ${champName(c.opp.championName)}'s tower before you back, so it crashes while you're gone instead of dying to their tower.`);
      }
    }
    // After laning every recall costs the walk's worth of farm, whenever it is taken: that is the price of
    // the trip, not a mistake, so it isn't charged.
    if (lostCs > 0) parts.push({ label: `${lostCs} CS lost around the trip`, gold: lostCs * GOLD_PER_CS });

    const lost = lostWhile(c, leftAt, backAt + 15_000);
    if (lost.plates.length) {
      parts.push({ label: `${lost.plates.length} plate${lost.plates.length > 1 ? "s" : ""} fell while you were gone`, gold: lost.plates.length * 160 });
      evidence.push(`${lost.plates.length} of your tower plates fell between ${fmtTime(leftAt)} and ${fmtTime(backAt + 15_000)}.`);
      if (!tips.some((x) => x.startsWith("Shove"))) tips.unshift(`Plates only fall when the wave is sitting on your tower. You left with the wave pushing into you: crash it into ${c.opp ? `${champName(c.opp.championName)}'s` : "their"} tower first, or back right after you clear a big wave under yours, never with one still walking in.`);
    }
    for (const o of lost.objectives) {
      const v = OBJECTIVE_VALUE[o.monsterType ?? ""] ?? 300;
      const nm = OBJECTIVE_NAME[o.monsterType ?? ""] ?? "an objective";
      parts.push({ label: `enemy took ${nm} while you were in base`, gold: v });
      evidence.push(`The enemy took ${nm} at ${fmtTime(o.timestamp)}, ${Math.round((o.timestamp - leftAt) / 1000)}s after you left.`);
      tips.push(`${cap(nm)} was ${Math.round((o.timestamp - leftAt) / 1000)}s away when you left. Back 60–90s before an objective, or after it's taken, never in the window right before.`);
    }

    // Gold you sat on before this recall.
    const fs = c.timeline.info.frames.filter((f) => f.timestamp < t0 && f.timestamp > Math.max(t0 - 6 * MIN, lastVisit + 30_000));
    const firstRich = fs.find((f) => (f.participantFrames[String(c.me.participantId)]?.currentGold ?? 0) >= 1300 && !wasDeadAt(c, deaths, f.timestamp));
    if (firstRich && t0 - firstRich.timestamp >= 90_000) {
      const held = Math.round((t0 - firstRich.timestamp) / 1000);
      const heldGold = firstRich.participantFrames[String(c.me.participantId)].currentGold;
      const v = Math.round((heldGold / 1000) * (held / 60) * 70);
      parts.push({ label: `${g(heldGold)}+ unspent for ${held}s`, gold: v });
      evidence.push(`You had ${g(heldGold)} at ${fmtTime(firstRich.timestamp)} and didn't back until ${fmtTime(leftAt)}.`);
      richAt = firstRich.timestamp;
      richGold = heldGold;
      tips.push(
        firstRich.timestamp < LANE_END
          ? `At ${fmtTime(firstRich.timestamp)} you already had ${g(heldGold)}. The recall was the next time your wave reached their tower after that, not ${held}s later: every fight in between was taken with ${g(heldGold)} unspent.`
          : `At ${fmtTime(firstRich.timestamp)} you already had ${g(heldGold)}. The recall was then, ${held}s before you took it: every fight in between was taken with ${g(heldGold)} unspent.`,
      );
    }

    // The wave when you left, read from the replay.
    const w = myWave(c, leftAt);
    const oppName = c.opp?.championName ?? "their laner";
    if (w) {
      const crashing = w.where === "under their tower" && w.mine >= 2;
      if (crashing) {
        evidence.push(`Wave read from the replay: when you started recalling, your wave was crashing into ${oppName}'s tower (${w.mine} of yours vs ${w.theirs} of theirs). Good timing on the wave.`);
        for (let i = tips.length - 1; i >= 0; i--) if (/^(Shove|Plates only fall)/.test(tips[i])) tips.splice(i, 1);
      } else if (w.theirs >= 3 && w.theirs >= w.mine + 2) {
        evidence.push(`Wave read from the replay: when you started recalling, ${w.theirs} of ${oppName}'s minions were pushing ${w.where} against ${w.mine} of yours.`);
        const passed = (c.windows ?? []).filter((x) => !x.taken && x.end < leftAt - 5000 && x.t > leftAt - 180_000);
        const before = waveSeries(c.waves, leftAt - 100_000, leftAt - 5000, laneOf(c.me.teamPosition)!, c.me.teamId).filter((x) => x.where === "under their tower" && x.mine >= 2);
        const window = passed[passed.length - 1] ?? before[before.length - 1];
        if (passed.length)
          evidence.push(`You passed ${passed.length} recall window${passed.length > 1 ? "s" : ""} before this (wave crashing into their tower, item gold in your pocket): ${passed.map((x) => `${fmtTime(x.t)} with ${g(x.gold)}`).join(", ")}.`);
        for (let i = tips.length - 1; i >= 0; i--) if (/^(Shove|Plates only fall)/.test(tips[i])) tips.splice(i, 1);
        tips.unshift(
          window
            ? `At ${fmtTime(window.t)} your wave was crashing into ${oppName}'s tower. That was the recall: their next wave would have walked into your tower with no one there for only a few seconds, instead of ${w.theirs} minions sitting on yours.`
            : `You left with ${w.theirs} of their minions coming at you. Kill that wave first (about ${w.theirs * GOLD_PER_CS}g and 20 seconds), push yours into their tower, then back as it crashes.`,
        );
        // Those minions die to your tower with nobody there to last-hit them.
        if (w.theirs > lostCs) {
          const i = parts.findIndex((p) => /CS lost around the trip/.test(p.label));
          if (i >= 0) parts.splice(i, 1);
          parts.push({ label: `${w.theirs} minions died to your tower while you were gone`, gold: w.theirs * GOLD_PER_CS });
        }
      } else if (w.where === "on their side" && w.mine >= w.theirs + 3) {
        evidence.push(`Wave read from the replay: your wave was ${w.mine} vs ${w.theirs} on their side when you left. It would have crashed in a few seconds; staying ~10s more lands the crash before you back.`);
      }
    }

    // With more of them in reach than of you, or one of them a breakpoint or an item ahead, there was no
    // wave to push: leaving was the play. What the wave did after is not charged, and nothing says "shove".
    // An earlier crash you passed up still counts: that one was on offer.
    if (pressure) evidence.push(pressure.line);
    if (blocked) {
      const hadWindow = tips.some((x) => /your wave was crashing into/.test(x));
      for (let i = tips.length - 1; i >= 0; i--) if (/^(Shove|Plates only fall|You left with)/.test(tips[i])) tips.splice(i, 1);
      if (!hadWindow) for (let i = parts.length - 1; i >= 0; i--) if (/CS lost around the trip|minions died to your tower|fell while you were gone/.test(parts[i].label)) parts.splice(i, 1);
      evidence.push(`Pushing the wave first was not on from there, so the minions and plates lost to this trip are not counted against you.`);
    }

    const small = !blocked && pocket < 900 && t0 < 25 * MIN;
    if (small) tips.push(`You backed with ${g(pocket)}, which is less than one real item step. If nothing forces you out, stay until about 1,100–1,300g.`);
    const cost = parts.reduce((s, p) => s + p.gold, 0);
    if (cost < 100) continue;
    const where = spot(c, from);
    out.push({
      kind: "recall",
      t: leftAt,
      cost,
      costParts: parts,
      title: `Recall at ${fmtTime(leftAt)} cost about ${g(cost)}`,
      doing: `You recalled from ${where.replace(/^in /, "")} with ${g(pocket)} and were back in about ${Math.round(walk + 18)}s.${small ? " That's a small trip for the time it costs." : ""}`,
      evidence,
      nextTime: tips.join(" ") || `Nobody in reach had the numbers or the lead to stop you: get the wave to their tower before you press B, so the next one meets you in lane.`,
      focus: from,
      tags: { cause: recallCause(parts), area: areaOf(from, c.me.teamId), phase: phaseOf(leftAt) },
      recall: { blocked, line: pressure?.line ?? "", late, richAt, richGold },
    });
  }
  return out;
}

function recallCause(parts: { label: string; gold: number }[]): string {
  const top = [...parts].sort((a, b) => b.gold - a.gold)[0]?.label ?? "";
  if (/minions died/.test(top)) return "recalled-into-their-wave";
  if (/CS lost/.test(top)) return "recall-cost-farm";
  if (/plate/.test(top)) return "plates-fell-while-recalling";
  if (/unspent/.test(top)) return "sat-on-gold";
  if (/enemy took/.test(top)) return "objective-lost-while-recalling";
  return "recall-other";
}

// ---------- farm gaps and roams ----------

function farmLeaks(c: Ctx, deaths: TimelineEvent[]): Leak[] {
  if (!c.opp) return [];
  const out: Leak[] = [];
  const buys = c.events.filter((e) => e.type === "ITEM_PURCHASED" && e.participantId === c.me.participantId).map((e) => e.timestamp);
  for (let m = 3; m < 14; m += 2) {
    const a = m * MIN;
    const b = (m + 2) * MIN;
    if (wasDeadAt(c, deaths, a + MIN) || deaths.some((d) => d.timestamp >= a && d.timestamp <= b)) continue; // deaths are graded separately
    if (buys.some((t) => t >= a - 20_000 && t <= b)) continue; // recalls are graded separately
    const mine = cs(c, c.me.participantId, b) - cs(c, c.me.participantId, a);
    const theirs = cs(c, c.opp.participantId, b) - cs(c, c.opp.participantId, a);
    const gap = Math.round(theirs - mine);
    if (gap < 5) continue;
    // Were you away from lane? Check the middle of the window.
    const mid = positionAt(c.track, c.me.participantId, a + MIN);
    const oppMid = positionAt(c.track, c.opp.participantId, a + MIN);
    const away = mid && oppMid && dist(mid, oppMid) > 4500;
    const took = c.events.filter(
      (e) =>
        e.timestamp >= a &&
        e.timestamp <= b &&
        ((e.type === "CHAMPION_KILL" && (e.killerId === c.me.participantId || e.assistingParticipantIds?.includes(c.me.participantId))) ||
          (e.type === "ELITE_MONSTER_KILL" && e.killerTeamId === c.me.teamId)),
    );
    if (away && took.length) continue; // a roam that paid off
    const cost = gap * GOLD_PER_CS;
    const lane = laneOf(c.me.teamPosition);
    const reads = lane ? waveSeries(c.waves, a, b, lane, c.me.teamId) : [];
    const share = (wh: string) => (reads.length ? reads.filter((r) => r.where === wh).length / reads.length : 0);
    const underMine = share("under your tower");
    const underTheirs = share("under their tower");
    const waveEvidence = reads.length
      ? [`Wave read from the replay: the wave was under your tower ${Math.round(underMine * 100)}% of this window and under theirs ${Math.round(underTheirs * 100)}%.`]
      : [];
    const waveTip =
      underTheirs >= 0.5
        ? `${champName(c.opp.championName)} kept the wave frozen in front of their tower, so every last-hit meant walking into their range. Don't stand there and lose it slowly: hit it hard with ${champName(c.opp.championName)} on cooldown, or ask your jungler to break the freeze with you.`
        : underMine >= 0.5
          ? `The wave sat under your tower and you lost the tower last-hits. Melee minions: 2 tower shots then an auto. Casters: 1 tower shot then an auto. Practice it in the lane lab until it's automatic.`
          : null;
    if (away && mid) {
      out.push({
        kind: "roam",
        t: a + MIN,
        cost,
        costParts: [{ label: `${gap} CS behind ${champName(c.opp.championName)} while you were away`, gold: cost }],
        title: `Roam at ${fmtTime(a + MIN)} got nothing and cost ${gap} CS`,
        doing: `You left lane: at ${fmtTime(a + MIN)} you were ${spot(c, mid)} while ${champName(c.opp.championName)} stayed ${spot(c, oppMid!)}.`,
        evidence: [`${champName(c.opp.championName)} farmed ${Math.round(theirs)} CS from ${fmtTime(a)} to ${fmtTime(b)}; you farmed ${Math.round(mine)}.`, "No kill, assist or objective for your team in that window."],
        tags: { cause: "roam-got-nothing", area: areaOf(mid, c.me.teamId), phase: phaseOf(a) },
        nextTime: `Only roam after you shove the wave into their tower, and turn back if the play isn't there within about 25 seconds. If ${champName(c.opp.championName)} doesn't follow, the roam has to make more than the ${gap} CS you give up.`,
        focus: mid,
      });
    } else {
      out.push({
        kind: "farm",
        t: a + MIN,
        cost,
        costParts: [{ label: `${gap} CS behind ${champName(c.opp.championName)} in lane`, gold: cost }],
        title: `${champName(c.opp.championName)} out-farmed you by ${gap} CS from ${fmtTime(a)} to ${fmtTime(b)}`,
        doing: `You were both in lane, but you took ${Math.round(mine)} CS to their ${Math.round(theirs)}.`,
        evidence: [`That's about ${(gap / 2).toFixed(1)} CS a minute lost with no death or recall to explain it.`, ...waveEvidence],
        nextTime: waveTip ?? (
          gap >= 9
            ? `A gap this size usually means the wave was sitting under your tower and you were missing tower last-hits, or you were zoned off it. Practice tower last-hitting (melee: 2 tower shots + 1 auto; caster: 1 tower shot + 1 auto) and don't trade when it costs you a cannon.`
            : `Watch this window and count the minions you missed. Most lost CS in Silver is casters dying while you trade.`),
        focus: mid ?? null,
        tags: { cause: underTheirs >= 0.5 ? "frozen-out" : underMine >= 0.5 ? "missed-tower-lasthits" : "lost-cs-in-lane", area: mid ? areaOf(mid, c.me.teamId) : "lane", phase: phaseOf(a) },
      });
    }
  }
  return out;
}

// ---------- objectives lost while you were across the map ----------

function objectiveLeaks(c: Ctx, deaths: TimelineEvent[]): Leak[] {
  const out: Leak[] = [];
  for (const e of c.events) {
    if (e.type !== "ELITE_MONSTER_KILL" || !e.killerTeamId || e.killerTeamId === c.me.teamId) continue;
    if (e.monsterType !== "DRAGON" && e.monsterType !== "BARON_NASHOR") continue;
    if (wasDeadAt(c, deaths, e.timestamp)) continue; // the death leak covers it
    const pit = e.monsterType === "DRAGON" ? PIT.DRAGON : PIT.BARON;
    const me = positionAt(c.track, c.me.participantId, e.timestamp);
    const before = positionAt(c.track, c.me.participantId, e.timestamp - 40_000);
    if (!me || !before || dist(me, pit) < 6500 || dist(before, pit) < 6500) continue;
    // Did you take something in exchange?
    const traded = c.events.some((x) => x.timestamp >= e.timestamp - 60_000 && x.timestamp <= e.timestamp + 60_000 && (x.type === "BUILDING_KILL" || x.type === "TURRET_PLATE_DESTROYED") && x.teamId !== c.me.teamId);
    if (traded) continue;
    const nm = OBJECTIVE_NAME[e.monsterType];
    const value = OBJECTIVE_VALUE[e.monsterType];
    const secs = Math.round(dist(before, pit) / MOVE_SPEED);
    out.push({
      kind: "objective",
      t: e.timestamp - 40_000,
      cost: Math.round(value * 0.6),
      costParts: [{ label: `${nm} given up with nothing taken in return`, gold: Math.round(value * 0.6) }],
      title: `${cap(nm)} at ${fmtTime(e.timestamp)} went with no trade`,
      doing: `40s before, you were ${spot(c, before)}, about ${secs}s from the pit, and you didn't take a tower or plate on the other side either.`,
      evidence: [`The enemy took ${nm} at ${fmtTime(e.timestamp)}.`, `You were ${spot(c, me)} when it died.`],
      nextTime: `${cap(nm)} timers are known a minute ahead. Either start walking at ${fmtTime(e.timestamp - 60_000)} so you arrive with your team, or commit to the other side and take a tower while they're on it. Doing neither gives it away for free.`,
      focus: before,
      tags: { cause: `${nm}-given-free`, area: areaOf(before, c.me.teamId), phase: phaseOf(e.timestamp) },
    });
  }
  return out;
}

// ---------- deaths ----------

function deathLeak(c: Ctx, d: TimelineEvent): Leak {
  const t = d.timestamp;
  const meId = c.me.participantId;
  const pos = d.position ?? positionAt(c.track, meId, t) ?? { x: 7400, y: 7400 };
  const enemyIds = [d.killerId ?? 0, ...(d.assistingParticipantIds ?? [])].filter((id) => c.byId.get(id)?.teamId !== c.me.teamId && id > 0);
  const enemies = enemyIds.map((id) => c.byId.get(id)!).filter(Boolean);
  const allies = c.track.players.filter((p) => p.teamId === c.me.teamId && p.id !== meId);
  const alliesNear = allies.filter((p) => {
    const q = positionAt(c.track, p.id, t);
    return q && !q.dead && dist(q, pos) < 3000;
  });
  const level = levelAt(c, t);
  const timer = DEATH_TIMER[level] ?? 30;
  const rate = csRate(c, t);
  const parts: { label: string; gold: number }[] = [];
  const bounty = (d.bounty ?? 300) + (d.shutdownBounty ?? 0);
  parts.push({ label: d.shutdownBounty ? `kill + ${g(d.shutdownBounty)} shutdown` : "kill gold given", gold: bounty });
  const timerCs = Math.round((rate * (timer + 20)) / 60);
  parts.push({ label: `${timer}s dead + walk back (~${timerCs} CS)`, gold: timerCs * GOLD_PER_CS });
  const lost = lostWhile(c, t, t + (timer + 25) * 1000);
  if (lost.plates.length) parts.push({ label: `${lost.plates.length} plate${lost.plates.length > 1 ? "s" : ""} lost while dead`, gold: lost.plates.length * 160 });
  if (lost.towers.length) parts.push({ label: "tower lost while dead", gold: 300 });
  for (const o of lost.objectives) parts.push({ label: `${OBJECTIVE_NAME[o.monsterType ?? ""] ?? "objective"} taken after`, gold: OBJECTIVE_VALUE[o.monsterType ?? ""] ?? 300 });
  const cost = parts.reduce((s, p) => s + p.gold, 0);

  // ---- What were you doing? ----
  const evidence: string[] = [];
  const myWard = c.events.find((e) => e.type === "WARD_PLACED" && e.creatorId === meId && e.timestamp <= t && t - e.timestamp < 40_000);
  const myFight = c.events.find(
    (e) => e.type === "CHAMPION_KILL" && e.victimId !== meId && (e.killerId === meId || e.assistingParticipantIds?.includes(meId)) && e.timestamp <= t && t - e.timestamp < 25_000,
  );
  const fromBase = c.events.find((e) => e.type === "ITEM_PURCHASED" && e.participantId === meId && e.timestamp <= t && t - e.timestamp < 75_000 && e.timestamp > 90_000);
  const prev = positionAt(c.track, meId, t - 30_000);
  const enemyHalf = c.me.teamId === 100 ? pos.x + pos.y > 15500 : pos.x + pos.y < 14000;
  const nearPit = dist(pos, PIT.DRAGON) < 2200 ? "dragon" : dist(pos, PIT.BARON) < 2200 ? "baron" : null;
  const sideLane = /top lane|bottom lane/.test(spot(c, pos));
  let doing: string;
  if (myFight) doing = `You were following up the ${name(c, myFight.victimId ?? 0)} kill at ${fmtTime(myFight.timestamp)} and kept going.`;
  else if (myWard) doing = `You were warding: you placed a ward at ${fmtTime(myWard.timestamp)} and died ${Math.round((t - myWard.timestamp) / 1000)}s later ${spot(c, pos)}.`;
  else if (nearPit) doing = `You were going to ${nearPit}: you died next to the pit.`;
  else if (fromBase) doing = `You were walking back from base (you bought at ${fmtTime(fromBase.timestamp)}) and took a path ${spot(c, pos)}.`;
  else if (sideLane && enemyHalf) doing = `You were pushing ${spot(c, pos).replace(/^in /, "")} alone, past the river.`;
  else if (prev && dist(prev, pos) > 2500) doing = `You were moving from ${spot(c, prev).replace(/^in /, "")} toward ${spot(c, pos).replace(/^in /, "")}.`;
  else doing = `You were ${spot(c, pos)}.`;

  // Where were your killers before they reached you?
  const jg = enemies.find((p) => p.teamPosition === "JUNGLE");
  if (jg) {
    const seen = positionAt(c.track, jg.participantId, t - 45_000);
    if (seen && seen.certainty > 0.3) evidence.push(`${champName(jg.championName)} was ${spot(c, seen)} 45s before (${(dist(seen, pos) / 1000).toFixed(1)}k units away).`);
  }
  evidence.push(
    `${enemies.length} enemy champion${enemies.length === 1 ? "" : "s"} took part (${enemies.map((p) => p.championName).join(", ") || "tower"}); ${alliesNear.length} of your teammates were within reach.`,
  );
  const pocket = goldInPocket(c, t - 1000);
  if (pocket >= 1300) evidence.push(`You died holding ${g(pocket)}.`);
  const w = myWave(c, t - 4000);
  const inLane = w && c.opp && enemies.some((p) => p.participantId === c.opp!.participantId) && enemies.length <= 2;
  if (w) evidence.push(`Wave read from the replay, 4s before: ${w.mine} of your minions vs ${w.theirs} of theirs, ${w.where}.`);

  // ---- Next time: built from the map state ----
  let nextTime: string;
  const enemyTeam = c.track.players.filter((p) => p.teamId !== c.me.teamId);
  const enemiesElsewhere = enemyTeam.filter((p) => !enemyIds.includes(p.id));
  const dragonUp = objectiveUp(c, t, "DRAGON");
  const baronUp = objectiveUp(c, t, "BARON_NASHOR");
  const nearestAlly = allies
    .map((p) => ({ p, q: positionAt(c.track, p.id, t - 5000) }))
    .filter((x) => x.q && !x.q.dead)
    .sort((a, b) => dist(a.q!, pos) - dist(b.q!, pos))[0];
  let cause = "other";
  if (inLane && w!.theirs >= w!.mine + 3) {
    cause = "fought-into-bigger-wave";
    nextTime = `You fought ${champName(c.opp!.championName)} with ${w!.mine} of your minions against ${w!.theirs} of theirs. Early on, a minion wave that size does as much damage as a champion. Trade when the wave is yours, or wait until theirs is under your tower and your tower is the extra hit.`;
  } else if (enemies.length >= 3) {
    cause = "collapsed-on";
    const farSide = pos.x - pos.y > 0 ? "top side" : "bottom side";
    const open = farSide === "bottom side" && dragonUp ? "dragon was up" : farSide === "top side" && baronUp ? "baron was up" : "their towers on that side were open";
    nextTime = `${enemies.length} of them came for you, which left ${enemiesElsewhere.length} on the rest of the map, and on the ${farSide} ${open}. That's the trade: when you see 3+ missing while you're ${sideLane ? "side-laning" : "out"} like this, walk back toward ${nearestAlly ? `${champName(nearestAlly.p.champion)} (${spot(c, nearestAlly.q!).replace(/^in /, "")})` : "your tower"} and ping your team to take it. Make them pay for sending ${enemies.length} to you instead of dying to it.`;
  } else if (jg && t < LANE_END) {
    cause = "ganked";
    const seen = positionAt(c.track, jg.participantId, t - 45_000);
    const secs = seen ? Math.round(dist(seen, pos) / 400) : null;
    nextTime = seen
      ? `${champName(jg.championName)} was ${spot(c, seen)} at ${fmtTime(t - 45_000)}, about ${secs}s from where you died. Once you know where they are, start a ${secs}-second clock: when it runs out and your wave is past the middle, step back toward your tower until they show up again.`
      : `${champName(jg.championName)} came to your lane. Track where they were last seen and when your wave is past the middle, assume they're coming.`;
  } else if (myFight) {
    cause = "chased-after-kill";
    nextTime = `The kill at ${fmtTime(myFight.timestamp)} was already the win. Take it and walk out: you gave back ${g(bounty)} chasing further ${spot(c, pos)}.`;
  } else if (pocket >= 1300) {
    cause = "died-holding-gold";
    nextTime = `You had ${g(pocket)} on you. Back before the next fight or wave you can't afford to lose; dying with it means fighting an item down and losing the gold's tempo.`;
  } else if (enemies.length === 1 && c.opp && enemies[0].participantId === c.opp.participantId) {
    cause = "lost-1v1";
    const gd = (lerp(c, meId, t - 1000, (f) => f.totalGold) ?? 0) - (lerp(c, c.opp.participantId, t - 1000, (f) => f.totalGold) ?? 0);
    nextTime = gd < -300 ? `You were ${g(-gd)} behind ${champName(c.opp.championName)} and lost a 1v1. Behind, don't take even trades: farm under tower and look for ${champName(c.opp.championName)}'s cooldowns before you step up.` : `You were ${gd >= 0 ? `${g(gd)} ahead` : "even"} and still lost the 1v1, so this one is mechanics or cooldowns, not position. Watch it and check what they used before you committed.`;
  } else {
    cause = alliesNear.length === 0 ? "caught-alone" : "lost-fight";
    nextTime = alliesNear.length === 0
      ? `None of your team was within reach. Before walking ${spot(c, pos)}, count the enemies you can see on the map; with ${enemiesElsewhere.length} unaccounted for, this spot needed a ward or a teammate.`
      : `You had ${alliesNear.length} teammate${alliesNear.length > 1 ? "s" : ""} nearby and still lost the fight. Look at who engaged first and whether you stepped in before your team was in range.`;
  }

  // ---- What you could see vs what was true (replay read with your fog) ----
  let vision: LeakTags["vision"];
  if (hasVision(c.waves, c.me.teamId)) {
    const vis = c.waves;
    const shown = visibleAt(vis, t - 5000);
    const missing = shown ? enemyTeam.filter((p) => !shown.has(p.id)) : [];
    if (shown) evidence.push(`Your minimap 5s before: ${enemyTeam.length - missing.length} of ${enemyTeam.length} enemies showing${missing.length ? `; missing ${missing.map((p) => p.champion).join(", ")}` : ""}.`);
    const key = enemies.find((p) => p.teamPosition === "JUNGLE") ?? enemies.find((p) => p.participantId !== c.opp?.participantId);
    if (key) {
      const ls = lastSeen(vis, key.participantId, t - 2000, 150_000);
      const truth = truthAt(vis, key.participantId, t - 20_000);
      const safeMove =
        t < LANE_END
          ? `step back behind your wave toward your tower`
          : nearestAlly
            ? `walk toward ${champName(nearestAlly.p.champion)} (${spot(c, nearestAlly.q!).replace(/^in /, "")})`
            : `walk back toward your tower`;
      let tip: string;
      vision = ls && t - ls.t <= 45_000 ? "seen" : "unseen";
      if (ls && t - ls.t <= 45_000) {
        const secs = Math.round((t - ls.t) / 1000);
        const walk = Math.round(dist(ls, pos) / 380);
        evidence.push(`${champName(key.championName)} showed on your minimap at ${fmtTime(ls.t)} ${spot(c, ls)}, ${secs}s before you died.`);
        tip = `You had the information: ${champName(key.championName)} showed on your minimap at ${fmtTime(ls.t)} ${spot(c, ls)}, about ${walk}s of walking from you. That was the moment to ${safeMove}. ${secs > walk ? `You stayed ${secs - walk}s longer than that clock allowed.` : "There was no time to finish anything first."}`;
      } else {
        const since = ls ? Math.round((t - ls.t) / 1000) : null;
        evidence.push(ls ? `${champName(key.championName)} was last on your minimap at ${fmtTime(ls.t)}, ${since}s before.` : `${champName(key.championName)} wasn't on your minimap at all in the 2½ minutes before.`);
        if (truth) evidence.push(`With fog off, 20s before you died ${champName(key.championName)} was ${spot(c, truth)}.`);
        tip = `You couldn't see ${champName(key.championName)} coming (${ls ? `last shown ${since}s earlier` : "not shown for over 2 minutes"}${missing.length > 1 ? `, ${missing.length} enemies off your minimap` : ""}). Reacting to the gank itself wasn't possible; the mistake was standing where an unseen jungler could reach you. With nobody accounted for, ${safeMove} until someone shows, or ward ${truth ? spot(c, truth).replace(/^in /, "") : "the river"} first.`;
      }
      nextTime = enemies.length >= 3 ? `${tip} ${nextTime}` : tip;
    }
  }

  return {
    kind: "death",
    t,
    cost,
    costParts: parts,
    title: `Death at ${fmtTime(t)} cost about ${g(cost)}`,
    doing,
    evidence,
    nextTime,
    focus: pos,
    deathMs: t,
    tags: { cause, area: areaOf(pos, c.me.teamId), phase: phaseOf(t), vision },
  };
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Total estimated cost per leak kind over many games: your biggest levers. */
export function leverTotals(games: { leaks?: Leak[] }[]): { kind: LeakKind; perGame: number; count: number }[] {
  const n = Math.max(1, games.filter((x) => x.leaks).length);
  const sums = new Map<LeakKind, { gold: number; count: number }>();
  for (const gm of games) for (const l of gm.leaks ?? []) {
    const s = sums.get(l.kind) ?? { gold: 0, count: 0 };
    s.gold += l.cost;
    s.count++;
    sums.set(l.kind, s);
  }
  return [...sums.entries()].map(([kind, s]) => ({ kind, perGame: Math.round(s.gold / n), count: s.count })).sort((a, b) => b.perGame - a.perGame);
}

export const LEAK_LABEL: Record<LeakKind, string> = {
  recall: "Recall timing",
  farm: "Farm lost in lane",
  roam: "Roams that got nothing",
  objective: "Objectives given for free",
  death: "Deaths",
};

/** How many moments a guided review of this game walks through. */
export const REVIEW_MOMENTS = 6;
export const momentCount = (r: { leaks?: Leak[]; mistakes: unknown[] }) => (r.leaks?.length ? Math.min(REVIEW_MOMENTS, r.leaks.length) : r.mistakes.length);
