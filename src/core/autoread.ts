/**
 * Which replay to read by itself, and when. Kept free of Electron so it can be tested.
 *
 * A read takes over the League replay window for a few minutes, so it only starts when the
 * client has sat outside a queue, champ select and a game for SETTLE_MS, and it is called off
 * the moment a queue starts. A game whose read was called off or failed is tried again later,
 * up to MAX_TRIES times; the newest game goes first.
 */
export const BUSY_PHASES = ["Matchmaking", "ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect", "WaitingForStats"];
/** A replay is on screen (ours or one the player opened). */
export const WATCH_PHASE = "WatchInProgress";
export const SETTLE_MS = 20_000;
export const RETRY_MS = 5 * 60_000;
export const MAX_TRIES = 3;
export const MAX_PENDING = 5;

export interface PendingRead {
  matchId: string;
  tries: number;
  /** Not before this time (ms). */
  after: number;
}

export class ReadQueue {
  private idleSince: number | null = null;
  running: string | null = null;

  constructor(public pending: PendingRead[] = []) {}

  /** A finished game to read. Newest first; the oldest drop off past MAX_PENDING. */
  add(matchId: string, now: number) {
    if (this.running === matchId || this.pending.some((p) => p.matchId === matchId)) return;
    this.pending = [{ matchId, tries: 0, after: now }, ...this.pending].slice(0, MAX_PENDING);
  }

  /** True when a running read has to stop: the player queued up or a game started. */
  mustCancel(phase: string | null): boolean {
    return this.running !== null && phase !== null && BUSY_PHASES.includes(phase);
  }

  /**
   * Feed each observed phase (null when the client is closed). Returns the game to start
   * reading now, and marks it running; null when it isn't time or nothing is waiting.
   */
  next(phase: string | null, now: number): string | null {
    const free = phase !== null && !BUSY_PHASES.includes(phase) && phase !== WATCH_PHASE;
    if (!free) {
      this.idleSince = null;
      return null;
    }
    this.idleSince ??= now;
    if (this.running || now - this.idleSince < SETTLE_MS) return null;
    const p = this.pending.find((x) => x.after <= now);
    if (!p) return null;
    this.running = p.matchId;
    return p.matchId;
  }

  /**
   * The running read ended. "later": it could not run yet or was called off, so it waits
   * RETRY_MS without using up a try. "retry": it failed, and is tried again up to MAX_TRIES.
   */
  finish(matchId: string, outcome: "done" | "later" | "retry" | "drop", now: number) {
    if (this.running === matchId) this.running = null;
    const p = this.pending.find((x) => x.matchId === matchId);
    if (!p) return;
    if (outcome === "later" || (outcome === "retry" && ++p.tries < MAX_TRIES)) p.after = now + RETRY_MS;
    else this.pending = this.pending.filter((x) => x !== p);
    // The next one waits for the client to settle again.
    this.idleSince = null;
  }
}

/** A read has to cover this much of what it set out to read to count. */
export const MIN_COVERAGE = 0.8;

/**
 * Why a scan is too short to count as a read of the game, or null when it covers it. A recording
 * that stops early (League lost the foreground, the recorder gave up) leaves a minute or two of
 * frames: saved as a read it yields no findings and the game is never read again.
 */
export function shortRead(info: { until?: number; lastFrame?: number; passes?: { fog: string; frames: number; expectedFrames?: number }[] } | undefined): string | null {
  if (!info) return null;
  if (info.until && info.lastFrame !== undefined && info.lastFrame < info.until * MIN_COVERAGE) return `the read stopped at ${Math.round(info.lastFrame / 1000)} s of ${Math.round(info.until / 1000)} s`;
  for (const p of info.passes ?? []) if (p.expectedFrames && p.frames < p.expectedFrames * MIN_COVERAGE) return `the ${p.fog === "off" ? "full-map" : "your-view"} pass got ${p.frames} of ${p.expectedFrames} frames`;
  return null;
}
