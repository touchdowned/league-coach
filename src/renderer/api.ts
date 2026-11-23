import type { GameReport } from "../core/types";

export interface Settings {
  apiKey: string;
  riotId: string;
  region: string;
  matchCount: number;
}

export interface CoachApi {
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  sync(): Promise<{ ok: true; reports: GameReport[] } | { ok: false; error: string }>;
  listGames(): Promise<GameReport[]>;
  onProgress(cb: (p: { done: number; total: number; label: string }) => void): () => void;
}

declare global {
  interface Window {
    coach: CoachApi;
  }
}

export const coach = (): CoachApi => window.coach;
