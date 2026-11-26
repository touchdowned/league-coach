/**
 * Module 3: the coaching synthesizer. Turns what Module 2 measured into feedback items.
 *
 * Every item carries five things, all computed:
 *  - the moment (MM:SS) and a replay jump to a few seconds before it;
 *  - proof: the telemetry that shows it happened (positions, counts, levels, timers);
 *  - cost: minions, XP and gold counted off the wave ledger and the kill events;
 *  - fix: the action with its own numbers (a time, a place, a count), found by running the
 *    same arithmetic on the alternatives (recall a few seconds earlier or later, the moment
 *    the level or item gap closed, the spot the jungler walked through);
 *  - where the numbers come from, so a reader can check them.
 *
 * There is no free text and no model: sentences are assembled from the numbers. `lint`
 * rejects an item without a timestamp, a number in its proof, cost and fix, or with any of
 * the stock phrases a generic coach falls back on.
 */
import { fmtTime } from "./analysis";
import { goldModel, type ItemTable } from "./gold";
import { champName } from "./names";
import { RECALL_MS, waveSpawns } from "./rules";
import { BAD_BACK_WAVES, laneLedger, lostBetween, objectiveSync, pathOf, trips, type ObjectiveSync, type Trip, type WaveLoss } from "./tempo";
import { describeSpot } from "./track";
import type { MatchDto, TimelineDto, TimelineEvent } from "./types";
import { exposures, fights, forwardOf, GANK_RANGE, ITEM_GAP, type Exposure, type Fight, type Matchup } from "./vulnerability";
import { laneLength, laneOf, type WaveTrack } from "./waves";
import { allWaveEvents, laneGeometry, MINION_SPEED, type WaveEvent } from "./wavestate";

export interface Finding {
  id: string;
  kind: "recall" | "exposure" | "fight" | "objective" | "death";
  /** The moment it is about, game ms, and as MM:SS. */
  t: number;
  time: string;
  title: string;
  /** Telemetry that shows it, one fact per line. */
  proof: string[];
  /** What it cost, in words, and as numbers for ranking. */
  cost: string;
  gold: number;
  xp: number;
  minions: number;
  /** The corrective action, with its own numbers. */
  fix: string;
  /** One click: seek the replay here, camera on this champion. */
  jump: { t: number; follow: string };
  /** The death this item explains, if any (two items about one death are merged to the costlier). */
  deathAt?: number;
  /** Ranking weight: gold plus XP at 0.6 gold a point (a caster minion gives 31 XP and 14 gold; a melee 62 and 20). */
  score: number;
}

export interface SynthInput {
  track: WaveTrack;
  match: MatchDto;
  timeline: TimelineDto;
  /** Participant id of the player. */
  id: number;
  items: ItemTable;
}

const SEC = 1000;
const s = (ms: number) => Math.round(ms / SEC);
const n1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
const units = (x: number) => `${Math.round(x / 50) * 50} units`;
const plural = (n: number, w: string) => `${n1(n)} ${w}${Math.abs(n - 1) < 0.05 ? "" : "s"}`;
const XP_GOLD = 0.6;
/** From a nexus to the inhibitor where the lane paths start (units). */
const NEXUS_TO_INHIBITOR = 2300;
const LANE_NAME = { TOP: "top", MIDDLE: "mid", BOTTOM: "bot" } as const;
const OBJ_NAME: Record<string, string> = { DRAGON: "Dragon", HORDE: "Voidgrubs", RIFTHERALD: "Rift Herald", BARON_NASHOR: "Baron" };

/** Phrases a generic coach falls back on. None may appear in a finding. */
const BANNED = [/ward more/i, /play(ing)? saf/i, /focus on farm/i, /watch (the|your) (mini)?map/i, /map awareness/i, /be (more )?careful/i, /better decisions?/i, /position better/i, /improve your/i, /try to/i, /farm better/i, /look at (the|your) (mini)?map/i];

/** Problems with a finding: empty when it meets the rules. */
export function lint(f: Finding): string[] {
  const out: string[] = [];
  const all = [f.title, ...f.proof, f.cost, f.fix].join(" ");
  if (!/^\d{1,2}:\d{2}$/.test(f.time)) out.push("no MM:SS timestamp");
  if (!f.proof.length || !f.proof.every((p) => /\d/.test(p))) out.push("a proof line without a number");
  if (!/\d/.test(f.cost)) out.push("cost without a number");
  if (!/\d/.test(f.fix)) out.push("fix without a number");
  if (!(f.jump.t >= 0) || !f.jump.follow) out.push("no replay jump");
  for (const b of BANNED) if (b.test(all)) out.push(`generic phrase: ${b.source}`);
  return out;
}

function lossLine(l: WaveLoss, lane: string): string {
  const waves = l.byWave.filter((w) => w.minions >= 1).map((w) => `${n1(w.minions)} of wave ${w.wave} (spawned ${fmtTime(w.spawnedAt)})`);
  return `${plural(l.minions, "enemy minion")} died in ${lane} while you were out of XP range${waves.length ? `: ${waves.join(", ")}` : ""}.`;
}
/** Hand counts on frame dumps of two scans came out 0 to 3 minions under the ledger's, per trip. */
const lossCost = (l: WaveLoss) => `${n1(l.waves)} waves (counted to within about 2 minions): ${l.xp} XP and up to ${l.gold} gold in last hits`;

interface Ctx extends SynthInput {
  me: MatchDto["info"]["participants"][number];
  events: TimelineEvent[];
  trips: Trip[];
  waveEvents: WaveEvent[];
  name: (pid: number) => string;
  where: (p: { x: number; y: number }) => string;
}

// ---- Recalls ----

function recallFinding(c: Ctx, v: Trip, k: number): Finding | null {
  if (v.kind !== "recall" || !v.loss || !v.lane) return null;
  if (!v.flags.includes("lost_waves") && !v.flags.includes("missed_cannon") && !v.flags.includes("left_wave_pushing_in")) return null;
  const lane = LANE_NAME[v.lane];
  const enemy = c.me.teamId === 100 ? 200 : 100;
  const ledger = laneLedger(c.track, v.lane, enemy);
  const gone = v.until - v.away;
  // The same trip, started up to 45 s earlier or 30 s later, on the wave timeline as it played out.
  let best = { at: v.away, loss: v.loss };
  for (let at = v.away - 45 * SEC; at <= v.away + 30 * SEC; at += SEC) {
    const l = lostBetween(ledger, at, at + gone);
    if (l.minions < best.loss.minions - 0.01 || (Math.abs(l.minions - best.loss.minions) <= 0.01 && Math.abs(at - v.away) < Math.abs(best.at - v.away))) best = { at, loss: l };
  }
  const saved = v.loss.minions - best.loss.minions;
  const proof = [
    `Recall began at ${fmtTime(v.start)} ${v.from ? c.where(v.from) : ""}${v.channelSeen ? ` (stood still for the ${s(RECALL_MS)} s channel)` : ""}; in the fountain ${fmtTime(v.arrive)}${v.leave !== null ? ` to ${fmtTime(v.leave)}` : ""}.`,
    v.back !== null ? `Last in XP range of the ${lane} wave at ${fmtTime(v.away)}, back in range at ${fmtTime(v.back)}: ${s(gone)} s away.` : `Last in XP range of the ${lane} wave at ${fmtTime(v.away)} and not back within 150 s; cost counted to ${fmtTime(v.until)}, the earliest a walk from the fountain gets there.`,
  ];
  if (v.state) proof.push(`When you left: ${v.state.theirs} enemy minions against your ${v.state.mine} at the front${v.state.toMyTower !== null ? `, ${units(Math.max(0, v.state.toMyTower))} from your tower` : ""}.`);
  proof.push(lossLine(v.loss, lane));
  for (const w of v.loss.cannonWaves) proof.push(`Wave ${w} was a cannon wave: alive when you left, dead when you got back.`);
  let fix: string;
  if (saved >= 3) {
    const d = s(best.at - v.away);
    const crash = c.waveEvents.find((e) => e.kind === "crash" && !e.inferred && e.side === "mine" && e.lane === v.lane && Math.abs(e.t0 - best.at) <= 8 * SEC);
    const when = d < 0 ? `${-d} s earlier, leaving the wave at ${fmtTime(best.at)}` : `${d} s later, leaving the wave at ${fmtTime(best.at)}`;
    fix = `Start this recall ${when}${crash ? `, as your ${crash.size}-minion wave reached their tower at ${fmtTime(crash.t0)}` : ""}. The same ${s(gone)} s trip then loses ${plural(best.loss.minions, "minion")} instead of ${n1(v.loss.minions)}: ${v.loss.xp - best.loss.xp} XP and ${v.loss.gold - best.loss.gold} gold kept.`;
    if (d > 0 && v.state && v.state.theirs > 0) fix += ` That means killing the ${v.state.theirs} enemy minions at the front first; they died at your tower without you.`;
  } else {
    // No better moment within the window: the trip itself was too long.
    const walk = v.leave !== null && v.back !== null ? s(v.back - v.leave) : null;
    fix = `No start time within 45 s loses fewer than ${n1(best.loss.minions)} minions, so the time has to come out of the trip: ${walk !== null ? `the walk back took ${walk} s from leaving the fountain at ${fmtTime(v.leave!)}` : `you did not return to ${lane}`}. A wave reaches the middle of ${lane} ${Math.round((laneLength(v.lane) / 2 + NEXUS_TO_INHIBITOR) / MINION_SPEED)} s after it spawns (${Math.round(laneLength(v.lane) / 2 + NEXUS_TO_INHIBITOR)} units at ${MINION_SPEED} a second), so be back before the wave that spawned at ${fmtTime(nextSpawnAfter(v.arrive))} gets there.`;
  }
  return {
    id: `recall-${k}`,
    kind: "recall",
    t: v.start,
    time: fmtTime(v.start),
    title: v.flags.includes("missed_cannon") ? `Recall at ${fmtTime(v.start)} gave up cannon wave ${v.loss.cannonWaves[0]}` : `Recall at ${fmtTime(v.start)} cost ${n1(v.loss.waves)} waves`,
    proof,
    cost: `${lossCost(v.loss)}${v.loss.waves > BAD_BACK_WAVES ? ` (over the ${BAD_BACK_WAVES}-wave line)` : ""}.`,
    gold: v.loss.gold,
    xp: v.loss.xp,
    minions: v.loss.minions,
    fix,
    jump: { t: Math.max(0, Math.min(v.away, v.start) - 6 * SEC), follow: c.me.championName },
    score: v.loss.gold + v.loss.xp * XP_GOLD,
  };
}

function nextSpawnAfter(t: number): number {
  const w = waveSpawns(t + 60 * SEC).find((x) => x.t >= t);
  return w ? w.t : t;
}

// ---- Exposure to the enemy jungler ----

function exposureFinding(c: Ctx, x: Exposure, k: number): Finding | null {
  // Only stretches that cost something or came within a second or two of it.
  const hpLost = x.hpStart !== null && x.hpLow !== null ? x.hpStart - x.hpLow : 0;
  if (x.died === null && x.arrived === null && !(x.closest !== null && x.closest <= GANK_RANGE / 2)) return null;
  const jg = c.match.info.participants.find((p) => p.teamId !== c.me.teamId && p.teamPosition === "JUNGLE")!;
  const J = champName(jg.championName);
  const death = x.died !== null ? c.trips.find((v) => v.kind === "death" && Math.abs(v.start - x.died!) <= 2000) : undefined;
  const proof = [
    `From ${fmtTime(x.t0)} to ${fmtTime(x.t1)} you stood up to ${units(x.depth)} past the middle of the map (deepest at ${fmtTime(x.depthAt)}, ${c.where(x.player)}).`,
    x.lastSeen
      ? `${J} was last on your team's minimap at ${fmtTime(x.lastSeen.t)} ${c.where(x.lastSeen)}, ${s(x.unseenFor)} s before: far enough back to have walked to you (${units(Math.hypot(x.lastSeen.x - x.player.x, x.lastSeen.y - x.player.y))} at 500 units a second).`
      : `${J} had not been on your team's minimap at all in the ${s(x.unseenFor)} s scanned before ${fmtTime(x.t0)}.`,
  ];
  if (x.closest !== null && x.jungler) proof.push(`With fog off: ${J} was ${units(x.closest)} from you at ${fmtTime(x.closestAt!)}, ${c.where(x.jungler)}${x.arrived !== null ? `, and on you at ${fmtTime(x.arrived)}` : ""}.`);
  proof.push(`Allied wards standing within 3000 units of you: ${x.wardsNear}.${x.flash === null ? "" : ` Flash was ${x.flash ? "up" : "down"} at ${fmtTime(x.t0)}.`}`);
  if (x.firstGankWindow) proof.push(`This is the first-clear window: a six-camp clear from the 0:55 spawn ends between 2:40 and 3:20.`);
  let cost: string;
  let gold = 0;
  let xp = 0;
  let minions = 0;
  if (x.died !== null) {
    gold = x.goldGiven + (death?.loss?.gold ?? 0);
    xp = death?.loss?.xp ?? 0;
    minions = death?.loss?.minions ?? 0;
    cost = `You died at ${fmtTime(x.died)}: ${x.goldGiven} gold to them${death?.loss ? `, and ${lossCost(death.loss)} while dead and walking back (${s(death.until - death.start)} s)` : ""}.`;
  } else {
    cost = `No death, but ${hpLost > 0 ? `${Math.round(hpLost)}% of your health gone by ${fmtTime(x.t1 + 10 * SEC)}` : "0% health lost"}${x.flashUsed ? " and Flash used (300 s cooldown)" : ""}; ${J} arrived ${x.arrived !== null ? `at ${fmtTime(x.arrived)}` : `within ${units(x.closest ?? 0)}`}.`;
  }
  // The spot the jungler came through 5 s before reaching the player: a ward there shows the gank coming.
  const jPath = pathOf(c.track, jg.participantId);
  const reach = x.arrived ?? x.closestAt ?? x.t1;
  let through: { x: number; y: number; t: number } | null = null;
  for (const p of jPath) if (p.t <= reach - 5 * SEC && p.t >= reach - 12 * SEC) through = p;
  const line = Math.max(0, x.depth);
  let fix = `From ${fmtTime(x.t0)}, when ${J} could first have reached you unseen, stand ${units(line)} further back (at or behind the middle line) until ${J} shows`;
  fix += through ? `. ${J} came through ${c.where(through)} at ${fmtTime(through.t)}: a ward there placed before ${fmtTime(Math.max(0, through.t - 10 * SEC))} shows the gank ${s(reach - through.t)} s before it lands.` : ".";
  if (x.flash === false) fix += ` With Flash down that line is not optional: you had no way out of a ${units(x.closest ?? GANK_RANGE)} approach.`;
  return {
    id: `exposure-${k}`,
    kind: "exposure",
    t: x.t0,
    time: fmtTime(x.t0),
    title: x.died !== null ? `${fmtTime(x.t0)}: past the middle with ${J} unseen for ${s(x.unseenFor)} s, dead at ${fmtTime(x.died)}` : `${fmtTime(x.t0)}: past the middle with ${J} unseen for ${s(x.unseenFor)} s`,
    proof,
    cost,
    gold,
    xp,
    minions,
    fix,
    deathAt: x.died ?? undefined,
    jump: { t: Math.max(0, x.t0 - 5 * SEC), follow: c.me.championName },
    score: gold + xp * XP_GOLD + (x.died === null ? hpLost + (x.flashUsed ? 100 : 0) : 0),
  };
}

// ---- Fights at a deficit ----

function levelTime(events: TimelineEvent[], pid: number, level: number): number | null {
  let l = 1;
  for (const e of events) {
    if (e.type !== "LEVEL_UP" || e.participantId !== pid) continue;
    if (++l >= level) return e.timestamp;
  }
  return null;
}

function fightFinding(c: Ctx, f: Fight, k: number): Finding | null {
  if (!f.flags.length) return null;
  const hpLost = f.hpStart !== null && f.hpEnd !== null ? f.hpStart - f.hpEnd : 0;
  // A fight at a deficit that went fine isn't a finding.
  if (f.died === null && hpLost < 40) return null;
  const worst = [...f.opponents].sort((a, b) => score(b) - score(a))[0];
  if (!worst) return null;
  const W = champName(worst.champion);
  const death = f.died !== null ? c.trips.find((v) => v.kind === "death" && Math.abs(v.start - f.died!) <= 2000) : undefined;
  const unspent = goldModel(c.timeline, c.items).at(c.id, f.t0);
  const proof = [`Fight began at ${fmtTime(f.t0)}${f.at ? ` ${c.where(f.at)}` : ""}: ${f.opponents.length} of them (${f.opponents.map((o) => champName(o.champion)).join(", ")}) against ${f.allies.length + 1} of you.`];
  for (const o of f.opponents) {
    const bits = [`level ${o.level} to your ${f.me.level}`];
    if (o.breakpoint !== null) {
      const at = levelTime(c.events, o.id, o.breakpoint);
      bits.push(`across the level ${o.breakpoint} breakpoint${at !== null ? ` since ${fmtTime(at)}` : ""}`);
    }
    bits.push(`${o.itemGoldLead >= 0 ? "+" : ""}${o.itemGoldLead} gold in items${o.legendaryLead > 0 ? ` and ${o.legendaryLead} more finished item${o.legendaryLead > 1 ? "s" : ""}` : ""}`);
    proof.push(`${champName(o.champion)}: ${bits.join(", ")}.`);
  }
  if (f.closedBy) proof.push(f.closedBy === "me" ? `In the 4 s before it you walked at them; they held their ground.` : f.closedBy === "them" ? `In the 4 s before it they walked at you; you held your ground.` : `In the 4 s before it both sides closed the distance.`);
  if (unspent >= ITEM_GAP) proof.push(`You were carrying about ${Math.round(unspent / 25) * 25} unspent gold (estimated from the timeline's income and purchases).`);
  let gold = 0;
  let xp = 0;
  let minions = 0;
  let cost: string;
  if (f.died !== null) {
    gold = f.goldGiven + (death?.loss?.gold ?? 0) - f.goldTaken;
    xp = death?.loss?.xp ?? 0;
    minions = death?.loss?.minions ?? 0;
    cost = `You died at ${fmtTime(f.died)}: ${f.goldGiven} gold to them${f.goldTaken ? ` against ${f.goldTaken} you took` : ""}${death?.loss ? `, and ${lossCost(death.loss)} while dead and walking back` : ""}.`;
  } else cost = `${Math.round(hpLost)}% of your health gone by ${fmtTime(f.t1)} for ${f.killed.length} kills.`;
  // When the gap closed: the player's own level-up, or the next shop stop.
  const parts: string[] = [];
  if (worst.breakpoint !== null) {
    const mine = levelTime(c.events, c.id, worst.breakpoint);
    parts.push(mine !== null ? `You reached level ${worst.breakpoint} at ${fmtTime(mine)}, ${s(mine - f.t0)} s after this fight began: before ${fmtTime(mine)}, give ${W} the ${f.at ? units(Math.max(600, forwardOf(f.at, c.me.teamId))) : "600 units"} you were standing past the middle and take the trade after it.` : `You never reached level ${worst.breakpoint} in the scanned part of the game; ${W} had it for this whole fight.`);
  } else if (worst.level - f.me.level >= 2) parts.push(`${W} was level ${worst.level} to your ${f.me.level}: ${worst.level - f.me.level} ability ranks you didn't have. ${(() => { const m = levelTime(c.events, c.id, worst.level); return m !== null ? `You reached level ${worst.level} at ${fmtTime(m)}, ${s(m - f.t0)} s later` : `You did not reach level ${worst.level} in the scanned part of the game`; })()}.`);
  if (worst.legendaryLead >= 1 || worst.itemGoldLead >= ITEM_GAP) {
    const next = c.trips.find((v) => v.arrive > f.t0 && v.kind !== "death");
    const last = [...c.trips].reverse().find((v) => v.leave !== null && v.leave <= f.t0);
    parts.push(
      `${W} had ${worst.itemGoldLead} gold more in items${unspent >= ITEM_GAP ? `, and ${Math.round(unspent / 25) * 25} of that gap was sitting unspent in your pocket: your last shop stop ended at ${last?.leave != null ? fmtTime(last.leave) : "0:00"}` : ""}${next ? `; your next one was at ${fmtTime(next.arrive)}, ${s(next.arrive - f.t0)} s later. Fight after it, not before` : ""}.`,
    );
  }
  if (f.flags.includes("outnumbered")) parts.push(`It was ${f.opponents.length} against ${f.allies.length + 1} within 1600 units when it began; the nearest other ally was not in range.`);
  if (!parts.length) return null;
  return {
    id: `fight-${k}`,
    kind: "fight",
    t: f.t0,
    time: fmtTime(f.t0),
    title: `${fmtTime(f.t0)}: fought ${W} ${worst.breakpoint !== null ? `a level-${worst.breakpoint} breakpoint down` : worst.itemGoldLead >= ITEM_GAP ? `${worst.itemGoldLead} gold of items down` : `${f.opponents.length} against ${f.allies.length + 1}`}`,
    proof,
    cost,
    gold: Math.max(0, gold),
    xp,
    minions,
    fix: parts.join(" "),
    deathAt: f.died ?? undefined,
    jump: { t: Math.max(0, f.t0 - 6 * SEC), follow: c.me.championName },
    score: Math.max(0, gold) + xp * XP_GOLD + (f.died === null ? hpLost : 0),
  };
}

const score = (o: Matchup) => (o.breakpoint !== null ? 1000 : 0) + Math.max(0, o.itemGoldLead) + o.legendaryLead * 500;

// ---- Objectives ----

function objectiveFinding(c: Ctx, o: ObjectiveSync, k: number): Finding | null {
  if (o.taken === null || o.by === c.me.teamId || (!o.away && !o.unspent)) return null;
  const name = OBJ_NAME[o.type];
  const trip = c.trips.find((v) => v.kind !== "death" && ((o.spawn >= v.start && o.spawn <= v.until) || (o.taken! >= v.start && o.taken! <= v.until)));
  const recalls = c.trips.filter((v) => v.kind === "recall" && v.back !== null).map((v) => v.back! - v.start).sort((a, b) => a - b);
  const typical = recalls.length ? recalls[recalls.length >> 1] : 40 * SEC;
  const proof = [`${name} came up at ${fmtTime(o.spawn)} and the enemy took it at ${fmtTime(o.taken)}.`];
  if (trip) proof.push(`Your ${trip.kind === "recall" ? "recall" : "walk to base"} began at ${fmtTime(trip.start)} and you were back on the map at ${fmtTime(trip.until)}.`);
  if (o.distanceAtTake !== null) proof.push(`When it died you were ${units(o.distanceAtTake)} from the pit.`);
  if (o.gold !== null) proof.push(`Unspent gold at the last minute mark before it spawned: ${o.gold}.`);
  const leaveBy = o.spawn - 15 * SEC - typical;
  return {
    id: `objective-${k}`,
    kind: "objective",
    t: trip ? trip.start : o.spawn,
    time: fmtTime(trip ? trip.start : o.spawn),
    title: `${name} at ${fmtTime(o.taken)}: you were ${trip ? "on a base trip" : `carrying ${o.gold} gold`} when it was taken`,
    proof,
    cost: `1 ${name} to the enemy${o.distanceAtTake !== null ? `, with you ${units(o.distanceAtTake)} away` : ""}.`,
    gold: 0,
    xp: 0,
    minions: 0,
    fix: `Its spawn time was known from ${fmtTime(Math.max(0, o.spawn - 300 * SEC))}. Your recall trips in this game took ${s(typical)} s from channel to back in lane (median of ${recalls.length || 0}), so the recall for it has to start by ${fmtTime(Math.max(0, leaveBy))} to have you on the map with your gold spent 15 s before ${fmtTime(o.spawn)}.`,
    jump: { t: Math.max(0, (trip ? trip.start : o.spawn) - 6 * SEC), follow: c.me.championName },
    // No gold number is invented for an epic monster: these rank after the counted ones.
    score: 1,
  };
}

// ---- Deaths that cost waves (and weren't already explained) ----

function deathFinding(c: Ctx, v: Trip, k: number): Finding | null {
  if (v.kind !== "death" || !v.loss || !v.lane || v.loss.waves <= BAD_BACK_WAVES) return null;
  const kill = c.events.find((e) => e.type === "CHAMPION_KILL" && e.victimId === c.id && Math.abs(e.timestamp - v.start) <= 1000);
  const bounty = kill ? (kill.bounty ?? 0) + (kill.shutdownBounty ?? 0) : 0;
  const lane = LANE_NAME[v.lane];
  const first = v.loss.byWave.find((w) => w.minions >= 1);
  return {
    id: `death-${k}`,
    kind: "death",
    t: v.start,
    time: fmtTime(v.start),
    title: `Death at ${fmtTime(v.start)} cost ${n1(v.loss.waves)} waves on top of the kill`,
    proof: [
      `Killed at ${fmtTime(v.start)}${v.from ? ` ${c.where(v.from)}` : ""}${kill?.killerId ? ` by ${c.name(kill.killerId)}` : ""}; respawned ${fmtTime(v.arrive)}, back in XP range of the ${lane} wave at ${fmtTime(v.until)}: ${s(v.until - v.start)} s out.`,
      lossLine(v.loss, lane),
      ...(v.state ? [`At the kill: ${v.state.theirs} enemy minions against your ${v.state.mine} at the front.`] : []),
    ],
    cost: `${bounty} gold to them, plus ${lossCost(v.loss)}.`,
    gold: bounty + v.loss.gold,
    xp: v.loss.xp,
    minions: v.loss.minions,
    fix: first
      ? `Wave ${first.wave} spawned at ${fmtTime(first.spawnedAt)} and was ${v.state && v.state.theirs > v.state.mine ? "already the bigger wave" : "on its way"} when you took this fight. A death here always costs the ${s(v.arrive - v.start)} s timer plus a ${s(v.until - v.arrive)} s walk; ${n1(v.loss.minions)} minions die in that time. Take the fight only after the wave in front of you is dead: ${v.state ? `${v.state.theirs} minions were still up` : "it was still up"}.`
      : `A death here costs the ${s(v.arrive - v.start)} s timer plus a ${s(v.until - v.arrive)} s walk.`,
    jump: { t: Math.max(0, v.start - 12 * SEC), follow: c.me.championName },
    score: bounty + v.loss.gold + v.loss.xp * XP_GOLD,
  };
}

/** Every finding for one game, costliest first. Items that fail `lint` are dropped (and counted in `rejected`). */
export function synthesize(input: SynthInput): { findings: Finding[]; rejected: { id: string; why: string[] }[] } {
  const me = input.match.info.participants.find((p) => p.participantId === input.id);
  if (!me) return { findings: [], rejected: [] };
  const events = input.timeline.info.frames.flatMap((f) => f.events ?? []).sort((a, b) => a.timestamp - b.timestamp);
  const ts = trips(input);
  const c: Ctx = {
    ...input,
    me,
    events,
    trips: ts,
    waveEvents: laneOf(me.teamPosition) ? allWaveEvents(input.track, me.teamId, laneGeometry(events)) : [],
    name: (pid) => champName(input.match.info.participants.find((p) => p.participantId === pid)?.championName),
    where: (p) => describeSpot(p, me.teamId),
  };
  const all: (Finding | null)[] = [];
  ts.forEach((v, k) => all.push(recallFinding(c, v, k)));
  const ex = exposures(input);
  ex.forEach((x, k) => all.push(exposureFinding(c, x, k)));
  const fs = fights(input);
  fs.forEach((f, k) => all.push(fightFinding(c, f, k)));
  objectiveSync(input, ts).forEach((o, k) => all.push(objectiveFinding(c, o, k)));
  // A death already explained by an exposure or a fight isn't listed a third time.
  const explained = new Set<number>();
  for (const x of ex) if (x.died !== null) explained.add(x.died);
  for (const f of fs) if (f.died !== null && f.flags.length) explained.add(f.died);
  ts.forEach((v, k) => {
    if (v.kind === "death" && ![...explained].some((t) => Math.abs(t - v.start) <= 2000)) all.push(deathFinding(c, v, k));
  });
  const findings: Finding[] = [];
  const rejected: { id: string; why: string[] }[] = [];
  for (const f of all) {
    if (!f) continue;
    const why = lint(f);
    if (why.length) rejected.push({ id: f.id, why });
    else findings.push(f);
  }
  findings.sort((a, b) => b.score - a.score);
  // One death, one item: when an exposure and a fight end in the same death, the costlier
  // stays and takes the other's proof lines it doesn't already have.
  const kept: Finding[] = [];
  for (const f of findings) {
    const twin = f.deathAt === undefined ? undefined : kept.find((x) => x.deathAt !== undefined && Math.abs(x.deathAt - f.deathAt!) <= 2000);
    if (twin) twin.proof.push(...f.proof.filter((p) => !twin.proof.includes(p)));
    else kept.push(f);
  }
  return { findings: kept, rejected };
}
