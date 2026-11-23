/**
 * Post-game detection, kept free of Electron and network code so it can be tested.
 *
 * The League client (LCU) reports a "gameflow phase". A game you play walks through
 *   ChampSelect -> GameStart -> InProgress -> (Reconnect) -> WaitingForStats -> PreEndOfGame -> EndOfGame
 * and back to Lobby/None. We remember the game while it is in progress and report it
 * exactly once when the phase leaves the in-game states, whichever state comes next
 * (the end-of-game screen can be skipped, or the client closed before we see it).
 */

export type GameflowPhase =
  | "None"
  | "Lobby"
  | "Matchmaking"
  | "CheckedIntoTournament"
  | "ReadyCheck"
  | "ChampSelect"
  | "GameStart"
  | "FailedToLaunch"
  | "InProgress"
  | "Reconnect"
  | "WaitingForStats"
  | "PreEndOfGame"
  | "EndOfGame"
  | "TerminatedInError"
  | (string & {});

export const IN_GAME_PHASES: GameflowPhase[] = ["GameStart", "InProgress", "Reconnect"];

/** Phases where opening a replay won't get in the way of a queue or a live game. */
export const SAFE_TO_LAUNCH_PHASES: GameflowPhase[] = ["None", "Lobby", "WaitingForStats", "PreEndOfGame", "EndOfGame"];

/** Ranked solo/duo and ranked flex on Summoner's Rift. */
export const RANKED_QUEUES = [420, 440];

const QUEUE_TYPES: Record<string, number> = { RANKED_SOLO_5x5: 420, RANKED_FLEX_SR: 440, NORMAL_DRAFT: 400 };

export interface TrackedGame {
  gameId: string;
  queueId: number;
}

/** Shape of the parts of /lol-gameflow/v1/session we use. */
export interface GameflowSession {
  phase?: string;
  gameData?: { gameId?: number; queue?: { id?: number; type?: string } };
}

/** Shape of the parts of /lol-end-of-game/v1/eog-stats-block we use. */
export interface EogStats {
  gameId?: number;
  queueId?: number;
  queueType?: string;
}

export function gameFromSession(s: GameflowSession | null | undefined): TrackedGame | null {
  const id = s?.gameData?.gameId;
  if (!id) return null;
  const q = s?.gameData?.queue;
  return { gameId: String(id), queueId: q?.id ?? QUEUE_TYPES[q?.type ?? ""] ?? 0 };
}

export function gameFromEog(e: EogStats | null | undefined): TrackedGame | null {
  if (!e?.gameId) return null;
  return { gameId: String(e.gameId), queueId: e.queueId ?? QUEUE_TYPES[e.queueType ?? ""] ?? 0 };
}

export const isRanked = (queueId: number) => RANKED_QUEUES.includes(queueId);

export class GameEndDetector {
  private current: TrackedGame | null = null;
  private handled = new Set<string>();

  /**
   * Feed each observed phase (null when the client is closed) with the game the client
   * reports, if known. Returns the game that just ended, once per game.
   */
  update(phase: GameflowPhase | null, game?: TrackedGame | null): TrackedGame | null {
    if (phase && IN_GAME_PHASES.includes(phase)) {
      if (game && !this.handled.has(game.gameId)) this.current = { ...game, queueId: game.queueId || this.current?.queueId || 0 };
      return null;
    }
    // Client closed: keep waiting, it may come back to the end-of-game screen.
    if (phase === null) return null;
    const ended = this.current ?? (phase === "EndOfGame" || phase === "PreEndOfGame" ? (game ?? null) : null);
    this.current = null;
    if (!ended || this.handled.has(ended.gameId)) return null;
    this.handled.add(ended.gameId);
    return ended;
  }

  /** The game being played right now, if any. */
  get inGame(): TrackedGame | null {
    return this.current;
  }
}

/**
 * Seconds to wait before the next check while Riot publishes the match (usually 1 to 5
 * minutes after the game) or the replay file (usually a few minutes more).
 */
export function backoffSec(attempt: number): number {
  const steps = [20, 30, 45, 60, 60, 90];
  return steps[Math.min(attempt, steps.length - 1)];
}

export type PostGameStage = "idle" | "waiting-match" | "analyzing" | "waiting-replay" | "downloading" | "ready" | "failed";

export interface PostGameStatus {
  stage: PostGameStage;
  gameId?: string;
  matchId?: string;
  label: string;
  /** 0..1 while downloading */
  progress?: number;
}
