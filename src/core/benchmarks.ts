import type { Position } from "./types";

// Rough Silver/Gold averages per role. These are estimates to compare against,
// not official Riot numbers; tune them as real data comes in.
export interface Benchmark {
  cs10: number;
  csPerMin: number;
  deathsPre14: number;
  killParticipation: number;
  visionPerMin: number;
}

export const BENCHMARKS: Record<string, Benchmark> = {
  TOP: { cs10: 58, csPerMin: 6.2, deathsPre14: 1.4, killParticipation: 0.42, visionPerMin: 0.55 },
  MIDDLE: { cs10: 62, csPerMin: 6.5, deathsPre14: 1.4, killParticipation: 0.52, visionPerMin: 0.6 },
  JUNGLE: { cs10: 50, csPerMin: 5.4, deathsPre14: 1.3, killParticipation: 0.6, visionPerMin: 0.8 },
  BOTTOM: { cs10: 62, csPerMin: 6.8, deathsPre14: 1.5, killParticipation: 0.5, visionPerMin: 0.5 },
  UTILITY: { cs10: 8, csPerMin: 1.2, deathsPre14: 1.6, killParticipation: 0.6, visionPerMin: 1.6 },
};

export function benchmarkFor(role: Position): Benchmark {
  return BENCHMARKS[role] ?? BENCHMARKS.MIDDLE;
}

export const ROLE_LABEL: Record<string, string> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
  "": "Unknown",
};
