import { benchmarkFor, ROLE_LABEL } from "./benchmarks";
import type { GameMetrics, Position } from "./types";

export interface RoleStats {
  role: Position;
  label: string;
  games: number;
  winRate: number;
  avgCs10: number;
  avgGoldDiff15: number;
  avgDeathsPre14: number;
  avgKp: number;
  avgVision: number;
  champions: { name: string; games: number; winRate: number }[];
  score: number; // higher is better, ~0 means average for Silver/Gold
  confidence: "low" | "medium" | "high";
}

export interface RoleVerdict {
  roles: RoleStats[];
  best: Position | null;
  summary: string;
  reasons: string[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function roleStats(games: GameMetrics[], role: Position): RoleStats {
  const g = games.filter((x) => x.role === role);
  const bench = benchmarkFor(role);
  const champMap = new Map<string, { games: number; wins: number }>();
  for (const x of g) {
    const c = champMap.get(x.champion) ?? { games: 0, wins: 0 };
    c.games++;
    if (x.win) c.wins++;
    champMap.set(x.champion, c);
  }
  const winRate = avg(g.map((x) => (x.win ? 1 : 0)));
  const s = {
    avgCs10: avg(g.map((x) => x.cs10)),
    avgGoldDiff15: avg(g.filter((x) => x.goldDiff15 !== null).map((x) => x.goldDiff15 as number)),
    avgDeathsPre14: avg(g.map((x) => x.deathsPre14)),
    avgKp: avg(g.map((x) => x.killParticipation)),
    avgVision: avg(g.map((x) => x.visionPerMin)),
  };
  // Each term is roughly "how far above the Silver/Gold norm" on a similar scale.
  const score =
    (winRate - 0.5) * 4 +
    s.avgGoldDiff15 / 500 +
    (s.avgCs10 - bench.cs10) / 10 +
    (bench.deathsPre14 - s.avgDeathsPre14) +
    (s.avgKp - bench.killParticipation) * 3;

  return {
    role,
    label: ROLE_LABEL[role] ?? role,
    games: g.length,
    winRate,
    ...s,
    champions: [...champMap.entries()]
      .map(([name, c]) => ({ name, games: c.games, winRate: c.wins / c.games }))
      .sort((a, b) => b.games - a.games),
    score: g.length ? score : 0,
    confidence: g.length >= 15 ? "high" : g.length >= 8 ? "medium" : "low",
  };
}

export function recommendRole(games: GameMetrics[]): RoleVerdict {
  const roles = (["MIDDLE", "TOP", "JUNGLE", "BOTTOM", "UTILITY"] as Position[])
    .map((r) => roleStats(games, r))
    .filter((r) => r.games > 0)
    .sort((a, b) => b.score - a.score);

  if (roles.length === 0) return { roles, best: null, summary: "No games imported yet.", reasons: [] };

  const best = roles[0];
  const reasons: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const signed = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x)}`;

  if (roles.length === 1) {
    return {
      roles,
      best: best.role,
      summary: `All your recent games are ${best.label}. Play some games in another role to compare.`,
      reasons,
    };
  }

  const second = roles[1];
  const gap = best.score - second.score;
  reasons.push(`Win rate: ${pct(best.winRate)} on ${best.label} vs ${pct(second.winRate)} on ${second.label}.`);
  reasons.push(
    `Gold vs your lane opponent at 15 min: ${signed(best.avgGoldDiff15)}g on ${best.label} vs ${signed(second.avgGoldDiff15)}g on ${second.label}.`,
  );
  reasons.push(
    `Deaths before 14 min: ${best.avgDeathsPre14.toFixed(1)} on ${best.label} vs ${second.avgDeathsPre14.toFixed(1)} on ${second.label}.`,
  );
  reasons.push(`CS at 10 min: ${best.avgCs10.toFixed(0)} on ${best.label} vs ${second.avgCs10.toFixed(0)} on ${second.label}.`);

  const lowData = best.confidence === "low" || second.confidence === "low";
  let summary: string;
  if (gap < 0.75) {
    summary = `${best.label} and ${second.label} are close for you right now. Pick the one you enjoy more and keep a small champion pool.`;
  } else {
    summary = `${best.label} looks like your best role right now.`;
  }
  if (lowData) summary += ` This is based on only ${Math.min(best.games, second.games)} game${Math.min(best.games, second.games) === 1 ? "" : "s"} in one role, so treat it as an early read. About 15 games in each role gives a reliable answer.`;

  return { roles, best: best.role, summary, reasons };
}
