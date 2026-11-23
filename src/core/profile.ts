import { benchmarkFor } from "./benchmarks";
import type { GameMetrics, GameReport, Position } from "./types";

/** The five skill areas the profile scores. 50 = typical Silver/Gold player in that role. */
export type Skill = "farming" | "laning" | "survival" | "fighting" | "vision";

export const SKILLS: { key: Skill; label: string; blurb: string }[] = [
  { key: "farming", label: "Farming", blurb: "CS at 10 and CS per minute" },
  { key: "laning", label: "Laning", blurb: "Gold and XP lead on your lane opponent at 15" },
  { key: "survival", label: "Survival", blurb: "Deaths before 14 and deaths per minute" },
  { key: "fighting", label: "Fighting", blurb: "Kill participation, damage share and KDA" },
  { key: "vision", label: "Vision", blurb: "Vision score per minute" },
];

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Score one game on each skill. */
export function skillScores(m: GameMetrics): Record<Skill, number> {
  const b = benchmarkFor(m.role);
  const kda = (m.kills + m.assists) / Math.max(m.deaths, 1);
  return {
    farming: clamp(50 + (m.cs10 - b.cs10) * 1.5 + (m.csPerMin - b.csPerMin) * 8),
    laning: clamp(50 + (m.goldDiff15 ?? 0) / 40 + (m.xpDiff15 ?? 0) / 50),
    survival: clamp(50 + (b.deathsPre14 - m.deathsPre14) * 15 + (0.2 - m.deaths / Math.max(m.durationMin, 1)) * 100),
    fighting: clamp(50 + (m.killParticipation - b.killParticipation) * 100 + (m.damageShare - 0.2) * 100 + (kda - 2.5) * 5),
    vision: clamp(50 + (m.visionPerMin - b.visionPerMin) * 60),
  };
}

export interface Profile {
  games: number;
  role: Position | "ALL";
  skills: Record<Skill, number>;
  /** Same scores over the previous block of games, for an up/down arrow. */
  previous: Record<Skill, number> | null;
  overall: number;
  strongest: Skill;
  weakest: Skill;
}

function averageSkills(ms: GameMetrics[]): Record<Skill, number> {
  const per = ms.map(skillScores);
  const out = {} as Record<Skill, number>;
  for (const s of SKILLS) out[s.key] = clamp(avg(per.map((p) => p[s.key])));
  return out;
}

/** Builds a profile from the most recent `window` games (newest first in `reports`). */
export function buildProfile(reports: GameReport[], role: Position | "ALL" = "ALL", window = 20): Profile | null {
  const ms = reports.map((r) => r.metrics).filter((m) => role === "ALL" || m.role === role);
  if (ms.length === 0) return null;
  const recent = ms.slice(0, window);
  const older = ms.slice(window, window * 2);
  const skills = averageSkills(recent);
  const sorted = [...SKILLS].sort((a, b) => skills[b.key] - skills[a.key]);
  return {
    games: recent.length,
    role,
    skills,
    previous: older.length >= 5 ? averageSkills(older) : null,
    overall: clamp(avg(SKILLS.map((s) => skills[s.key]))),
    strongest: sorted[0].key,
    weakest: sorted[sorted.length - 1].key,
  };
}

/** Rolling average of a metric, oldest game first, for trend charts. */
export function trend(reports: GameReport[], pick: (m: GameMetrics) => number | null, windowSize = 5): { i: number; value: number; raw: number }[] {
  const chron = [...reports].reverse();
  const out: { i: number; value: number; raw: number }[] = [];
  const buf: number[] = [];
  chron.forEach((r, i) => {
    const v = pick(r.metrics);
    if (v === null) return;
    buf.push(v);
    if (buf.length > windowSize) buf.shift();
    out.push({ i, value: avg(buf), raw: v });
  });
  return out;
}
