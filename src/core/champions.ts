import { skillScores, SKILLS } from "./profile";
import type { GameReport, Position } from "./types";

export interface ChampionStats {
  champion: string;
  roles: Position[];
  games: number;
  wins: number;
  winRate: number;
  kda: number;
  avgCs10: number;
  avgGoldDiff15: number;
  avgDeathsPre14: number;
  score: number; // average profile score, 50 = typical
  matchups: { opponent: string; games: number; wins: number; avgGoldDiff15: number }[];
  verdict: "core" | "keep" | "practice" | "drop" | "new";
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function championStats(reports: GameReport[]): ChampionStats[] {
  const by = new Map<string, GameReport[]>();
  for (const r of reports) by.set(r.metrics.champion, [...(by.get(r.metrics.champion) ?? []), r]);

  return [...by.entries()]
    .map(([champion, rs]) => {
      const ms = rs.map((r) => r.metrics);
      const wins = ms.filter((m) => m.win).length;
      const k = ms.reduce((s, m) => s + m.kills + m.assists, 0);
      const d = ms.reduce((s, m) => s + m.deaths, 0);
      const score = avg(ms.map((m) => avg(SKILLS.map((s) => skillScores(m)[s.key]))));

      const mu = new Map<string, { games: number; wins: number; gd: number[] }>();
      for (const m of ms) {
        if (!m.opponentChampion) continue;
        const e = mu.get(m.opponentChampion) ?? { games: 0, wins: 0, gd: [] };
        e.games++;
        if (m.win) e.wins++;
        if (m.goldDiff15 !== null) e.gd.push(m.goldDiff15);
        mu.set(m.opponentChampion, e);
      }

      const winRate = wins / ms.length;
      let verdict: ChampionStats["verdict"];
      if (ms.length < 3) verdict = "new";
      else if (winRate >= 0.55 && score >= 50) verdict = "core";
      else if (winRate >= 0.45 || score >= 50) verdict = "keep";
      else if (ms.length >= 6 && winRate < 0.4 && score < 45) verdict = "drop";
      else verdict = "practice";

      return {
        champion,
        roles: [...new Set(ms.map((m) => m.role))],
        games: ms.length,
        wins,
        winRate,
        kda: k / Math.max(d, 1),
        avgCs10: avg(ms.map((m) => m.cs10)),
        avgGoldDiff15: avg(ms.filter((m) => m.goldDiff15 !== null).map((m) => m.goldDiff15 as number)),
        avgDeathsPre14: avg(ms.map((m) => m.deathsPre14)),
        score: Math.round(score),
        matchups: [...mu.entries()]
          .map(([opponent, e]) => ({ opponent, games: e.games, wins: e.wins, avgGoldDiff15: avg(e.gd) }))
          .sort((a, b) => b.games - a.games),
        verdict,
      };
    })
    .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
}
