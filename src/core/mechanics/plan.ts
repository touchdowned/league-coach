/**
 * Training plan for the mechanics trainers: which champions to drill, how hard,
 * and how combo attempts are graded. Built on motor-learning findings:
 * - Adaptive difficulty that holds you near ~70% success (challenge point framework).
 *   A 2-down/1-up staircase converges on 70.7%.
 * - Interleaved, varied practice over blocked repetition (contextual interference).
 * - Feedback only when a miss is outside a tolerance, plus a summary per set.
 * - Short daily sets rather than long sessions (spacing).
 */
import { championStats } from "../champions";
import type { GameReport, Position } from "../types";
import type { Combo, ComboInput } from "./kits";
import { STARTER_CHAMPIONS } from "./kits";

export type Drill = "aim" | "dodge" | "combo";

export const DRILLS: { id: Drill; label: string; cue: string }[] = [
  { id: "aim", label: "Skillshot aim", cue: "Land your skillshots on a target that moves and jukes." },
  { id: "dodge", label: "Dodging", cue: "Stay out of your lane opponents' skillshots." },
  { id: "combo", label: "Combos", cue: "Hit your champion's combos in order, faster each set." },
];

/** Shots, casts or combos per set. Short enough to keep focus, long enough to adapt. */
export const SET_LENGTH: Record<Drill, number> = { aim: 20, dodge: 20, combo: 12 };

// ---------------------------------------------------------------------------
// Adaptive difficulty
// ---------------------------------------------------------------------------

export interface Staircase {
  level: number; // 1-20
  run: number; // successes in a row at this level
}

export const START: Staircase = { level: 4, run: 0 };

/** 2-down/1-up: two successes in a row make it harder, one failure makes it easier. */
export function stepStair(s: Staircase, success: boolean): Staircase {
  if (!success) return { level: Math.max(1, s.level - 1), run: 0 };
  if (s.run + 1 >= 2) return { level: Math.min(20, s.level + 1), run: 0 };
  return { level: s.level, run: s.run + 1 };
}

// ---------------------------------------------------------------------------
// Champion pool
// ---------------------------------------------------------------------------

export interface PoolEntry {
  champion: string;
  games: number;
  roles: Position[];
  /** Lane opponents you met most on this champion, for the dodge trainer. */
  opponents: string[];
}

/** Your most-played mid and top champions, falling back to any role, then to starters. */
export function trainingPool(games: GameReport[], size = 6): PoolEntry[] {
  const stats = championStats(games);
  const laners = stats.filter((s) => s.roles.some((r) => r === "MIDDLE" || r === "TOP"));
  const pick = (laners.length ? laners : stats).slice(0, size);
  if (!pick.length) return STARTER_CHAMPIONS.slice(0, size).map((champion) => ({ champion, games: 0, roles: [], opponents: [] }));
  return pick.map((s) => ({
    champion: s.champion,
    games: s.games,
    roles: s.roles,
    opponents: s.matchups.slice(0, 5).map((m) => m.opponent),
  }));
}

/** Lane opponents you've met most across all games, for when a champion has none of its own. */
export function commonOpponents(games: GameReport[], n = 5): string[] {
  const count = new Map<string, number>();
  for (const g of games) {
    const o = g.metrics.opponentChampion;
    if (o && (g.metrics.role === "MIDDLE" || g.metrics.role === "TOP")) count.set(o, (count.get(o) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([c]) => c);
}

/**
 * Which drill to suggest first. Dying early in lane points at dodging; otherwise
 * aim, which most champions' lane trading depends on.
 */
export function suggestedDrill(games: GameReport[]): Drill {
  const recent = games.slice(0, 10).map((g) => g.metrics);
  if (!recent.length) return "aim";
  const earlyDeaths = recent.reduce((s, m) => s + m.deathsPre14, 0) / recent.length;
  return earlyDeaths >= 1.5 ? "dodge" : "aim";
}

// ---------------------------------------------------------------------------
// Combo grading
// ---------------------------------------------------------------------------

export interface ComboAttempt {
  inputs: ComboInput[];
  times: number[]; // ms timestamps of each input
}

export interface ComboResult {
  correct: boolean;
  /** Index of the first wrong input, or -1. */
  wrongAt: number;
  durationMs: number;
  /** Longest pause between two inputs, where most combos break. */
  slowestGapMs: number;
  slowestGapAt: number;
  withinTarget: boolean;
}

/** Target time for a combo at a level: ~450 ms per input at level 1, ~170 ms at level 20. */
export function comboTargetMs(combo: Combo, level: number): number {
  const k = (Math.max(1, Math.min(20, level)) - 1) / 19;
  const per = 450 - 280 * k;
  return Math.round(per * Math.max(1, combo.inputs.length - 1));
}

export function gradeCombo(combo: Combo, a: ComboAttempt, level: number): ComboResult {
  let wrongAt = -1;
  for (let i = 0; i < combo.inputs.length; i++) {
    if (a.inputs[i] !== combo.inputs[i]) {
      wrongAt = i;
      break;
    }
  }
  const correct = wrongAt === -1 && a.inputs.length === combo.inputs.length;
  const durationMs = a.times.length > 1 ? a.times[a.times.length - 1] - a.times[0] : 0;
  let slowestGapMs = 0;
  let slowestGapAt = -1;
  for (let i = 1; i < a.times.length; i++) {
    const gap = a.times[i] - a.times[i - 1];
    if (gap > slowestGapMs) {
      slowestGapMs = gap;
      slowestGapAt = i;
    }
  }
  return { correct, wrongAt, durationMs, slowestGapMs, slowestGapAt, withinTarget: correct && durationMs <= comboTargetMs(combo, level) };
}

/** Order for a set of combos: shuffled, never the same combo twice in a row (interleaving). */
export function interleave<T>(items: T[], n: number, r: () => number): T[] {
  if (!items.length) return [];
  const out: T[] = [];
  let last = -1;
  while (out.length < n) {
    let i = Math.floor(r() * items.length);
    if (items.length > 1 && i === last) i = (i + 1) % items.length;
    out.push(items[i]);
    last = i;
  }
  return out;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface SetRecord {
  date: string; // ISO
  drill: Drill;
  champion: string;
  /** Hit rate (aim), dodge rate (dodge) or clean-and-on-time rate (combo), 0-1. */
  score: number;
  level: number;
  /** Aim: mean absolute aim error in degrees. Combo: mean duration in ms. Dodge: hits taken. */
  detail: number;
}

export interface MechanicsState {
  stairs: Record<string, Staircase>; // `${drill}:${champion}`
  history: SetRecord[];
}

export const EMPTY_MECHANICS: MechanicsState = { stairs: {}, history: [] };

export const stairKey = (drill: Drill, champion: string) => `${drill}:${champion}`;

export function recordSet(s: MechanicsState, rec: SetRecord, stair: Staircase): MechanicsState {
  return {
    stairs: { ...s.stairs, [stairKey(rec.drill, rec.champion)]: stair },
    history: [...s.history, rec].slice(-400),
  };
}

/** Best and latest score per drill for one champion, for the trend line on each card. */
export function trend(s: MechanicsState, drill: Drill, champion: string): SetRecord[] {
  return s.history.filter((h) => h.drill === drill && h.champion === champion).slice(-12);
}

/** Sets done today, for the "5-10 minute warm-up" target. */
export function setsToday(s: MechanicsState, now = new Date()): number {
  const day = now.toDateString();
  return s.history.filter((h) => new Date(h.date).toDateString() === day).length;
}

export const DAILY_SETS = 3;
