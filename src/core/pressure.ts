/**
 * Could the player have pushed the wave here? A recall is only "badly timed" when a better
 * one was on offer. With more enemies than allies in reach, or an enemy in reach who is across
 * a level breakpoint or a major item's worth of gold ahead, walking up to shove a wave is a
 * fight the numbers say is lost, so leaving was the play and the wave is not the player's to
 * answer for. Same thresholds as the fight findings: 2500 units, levels 2/3/6/11/16, 875 gold.
 */
import type { TimelineDto } from "./types";
import { champName } from "./names";

type Pt = { x: number; y: number };

export const REACH = 2500;
export const LEVEL_BREAKPOINTS = [2, 3, 6, 11, 16];
export const GOLD_GAP = 875;

export interface Pressure {
  /** Living enemies within REACH, nearest first. */
  enemies: { id: number; champion: string; d: number; breakpoint: number | null; goldLead: number }[];
  /** Allies within REACH, not counting the player. */
  allies: number;
  outnumbered: boolean;
  /** The enemy in reach with the biggest lead, when one is across a breakpoint or GOLD_GAP ahead. */
  ahead: Pressure["enemies"][number] | null;
  /** Pushing the wave first was not on. */
  blocked: boolean;
  /** The count in a sentence, with its numbers. */
  line: string;
}

export interface PressureInput {
  players: { id: number; champion: string; teamId: number }[];
  meId: number;
  timeline: TimelineDto;
  /** Where a champion was at t; null when unknown or dead. */
  pos: (id: number, t: number) => Pt | null;
}

function frameOf(tl: TimelineDto, id: number, t: number) {
  let best = tl.info.frames[0];
  for (const f of tl.info.frames) if (f.timestamp <= t) best = f;
  return best?.participantFrames[String(id)];
}

function levelAt(tl: TimelineDto, id: number, t: number): number {
  let lv = 1;
  let seen = false;
  for (const f of tl.info.frames) {
    if (f.timestamp > t + 60_000) break;
    for (const e of f.events ?? []) {
      if (e.type === "LEVEL_UP" && e.participantId === id && e.timestamp <= t) {
        lv = Math.max(lv, (e as { level?: number }).level ?? lv + 1);
        seen = true;
      }
    }
  }
  return seen ? lv : (frameOf(tl, id, t)?.level ?? 1);
}

function goldAt(tl: TimelineDto, id: number, t: number): number {
  const fs = tl.info.frames;
  let a: (typeof fs)[number] | undefined;
  let b: (typeof fs)[number] | undefined;
  for (const f of fs) {
    if (f.timestamp <= t) a = f;
    else {
      b = f;
      break;
    }
  }
  const ga = a?.participantFrames[String(id)]?.totalGold;
  const gb = b?.participantFrames[String(id)]?.totalGold;
  if (ga === undefined) return gb ?? 0;
  if (gb === undefined || !a || !b) return ga;
  return ga + (gb - ga) * ((t - a.timestamp) / Math.max(1, b.timestamp - a.timestamp));
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function one(i: PressureInput, t: number): Pressure | null {
  const at = i.pos(i.meId, t);
  const me = i.players.find((p) => p.id === i.meId);
  if (!at || !me) return null;
  const myLevel = levelAt(i.timeline, i.meId, t);
  const myGold = goldAt(i.timeline, i.meId, t);
  const enemies: Pressure["enemies"] = [];
  let allies = 0;
  let known = 0;
  for (const p of i.players) {
    if (p.id === i.meId) continue;
    const q = i.pos(p.id, t);
    if (!q) continue;
    if (p.teamId !== me.teamId) known++;
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d > REACH) continue;
    if (p.teamId === me.teamId) {
      allies++;
      continue;
    }
    const lv = levelAt(i.timeline, p.id, t);
    const breakpoint = [...LEVEL_BREAKPOINTS].reverse().find((b) => lv >= b && myLevel < b) ?? null;
    enemies.push({ id: p.id, champion: p.champion, d, breakpoint, goldLead: Math.round(goldAt(i.timeline, p.id, t) - myGold) });
  }
  // With no enemy placed at all there is nothing to count: unknown, not "nobody there".
  if (!known) return null;
  enemies.sort((a, b) => a.d - b.d);
  const outnumbered = enemies.length > allies + 1;
  const lead = (e: Pressure["enemies"][number]) => (e.breakpoint !== null ? 10_000 : 0) + e.goldLead;
  const top = [...enemies].sort((a, b) => lead(b) - lead(a))[0];
  const ahead = top && (top.breakpoint !== null || top.goldLead >= GOLD_GAP) ? top : null;
  // A lead only blocks the push when your side doesn't have the extra champion to answer it.
  const blocked = outnumbered || (!!ahead && enemies.length >= allies + 1);
  const who = list(enemies.map((e) => champName(e.champion)));
  const bits: string[] = [];
  if (enemies.length) bits.push(`${who} ${enemies.length === 1 ? "was" : "were"} within ${REACH} units of you against ${allies + 1} of your side`);
  else bits.push(`no enemy was within ${REACH} units of you`);
  if (ahead) bits.push(`${champName(ahead.champion)} was ${ahead.breakpoint !== null ? `across the level ${ahead.breakpoint} breakpoint` : `${ahead.goldLead.toLocaleString("en-US")} gold ahead of you`}`);
  const line = `${bits.join(", and ")}.`;
  return { enemies, allies, outnumbered, ahead, blocked, line: line[0].toUpperCase() + line.slice(1) };
}

/**
 * The pressure on the player around t: the worse of the reads at t - 6 s and t, since the
 * enemies that forced a recall are often already walking off when the channel starts.
 */
export function pressureAt(i: PressureInput, t: number): Pressure | null {
  const reads = [one(i, t - 6000), one(i, t)].filter((p): p is Pressure => !!p);
  if (!reads.length) return null;
  return reads.sort((a, b) => Number(b.blocked) - Number(a.blocked) || b.enemies.length - a.enemies.length)[0];
}
