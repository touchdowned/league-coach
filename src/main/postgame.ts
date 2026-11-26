import {
  backoffSec,
  EogStats,
  GameEndDetector,
  GameflowSession,
  gameFromEog,
  gameFromSession,
  isRanked,
  PostGameStatus,
  SAFE_TO_LAUNCH_PHASES,
  TrackedGame,
} from "../core/postgame";
import type { GameReport } from "../core/types";
import { gameIdOf, LeagueClient } from "./league";
import type { Settings } from "./store";

/**
 * Watches the League client and, after each ranked game:
 *   1. waits for Riot to publish the match, then syncs and analyzes it,
 *   2. opens the guided review for it,
 *   3. downloads the replay through the client, and opens it in League if asked to.
 *
 * Polls the client's gameflow phase (every 2s while the client is open, 10s while it
 * is closed). Polling is used instead of the client's WebSocket event feed because it
 * needs no extra dependency, survives client restarts on its own, and a missed event
 * can't strand a game: the detector compares phases, not single events.
 */

export interface PostGameDeps {
  settings(): Promise<Settings>;
  league(): Promise<LeagueClient>;
  /** True once match-v5 lists this game for the player. */
  matchPublished(gameId: string): Promise<boolean>;
  /** Full sync; returns all reports. */
  sync(): Promise<GameReport[]>;
  status(s: PostGameStatus): void;
  /** Bring the app forward on this game's review. */
  openReview(matchId: string): void;
  /** The game is analyzed: its replay can be read when the client is idle. */
  queueRead?(matchId: string): void;
  /** Every observed phase (null when the client is closed), for the live overlay and draft card. */
  onPhase?(phase: string | null): void;
  sleep?(ms: number): Promise<void>;
}

const MATCH_DEADLINE_MS = 15 * 60_000;
const REPLAY_DEADLINE_MS = 20 * 60_000;

export class PostGameWatcher {
  private detector = new GameEndDetector();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = new Set<string>();
  private last: PostGameStatus = { stage: "idle", label: "" };

  constructor(private deps: PostGameDeps) {}

  get status() {
    return this.last;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      let delay = 10_000;
      try {
        delay = await this.tick();
      } catch {
        /* keep watching */
      }
      if (!this.stopped) this.timer = setTimeout(loop, delay);
    };
    loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One poll. Returns ms until the next one. */
  async tick(): Promise<number> {
    const lc = await this.deps.league();
    const phase = await lc.gameflowPhase();
    this.deps.onPhase?.(phase);
    if (phase === null) {
      this.detector.update(null);
      return 10_000;
    }
    let game: TrackedGame | null = null;
    if (phase === "GameStart" || phase === "InProgress" || phase === "Reconnect") {
      // The session only needs reading once per game.
      if (!this.detector.inGame?.queueId) game = gameFromSession(await lc.lcuGet<GameflowSession>("/lol-gameflow/v1/session"));
      else game = this.detector.inGame;
    } else if (phase === "EndOfGame" || phase === "PreEndOfGame") {
      game = gameFromEog(await lc.lcuGet<EogStats>("/lol-end-of-game/v1/eog-stats-block"));
    }
    const ended = this.detector.update(phase, game);
    if (ended) this.handle(ended);
    return 2_000;
  }

  private emit(s: PostGameStatus) {
    this.last = s;
    this.deps.status(s);
  }

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  /** Runs the pipeline for a finished game (ranked only, unless forced). */
  async handle(game: TrackedGame, force = false): Promise<void> {
    if (!force && !isRanked(game.queueId)) return;
    const s = await this.deps.settings();
    if (!force && !s.autoReview) return;
    if (this.running.has(game.gameId)) return;
    this.running.add(game.gameId);
    try {
      const replay = this.replay(game.gameId, s.autoLaunchReplay);
      await this.analyze(game.gameId);
      await replay;
    } finally {
      this.running.delete(game.gameId);
    }
  }

  private async analyze(gameId: string): Promise<void> {
    const gid = { gameId };
    this.emit({ stage: "waiting-match", ...gid, label: "Waiting for Riot to publish your game" });
    const deadline = Date.now() + MATCH_DEADLINE_MS;
    let published = false;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      // Riot takes a minute or more to publish a match; the first check waits too.
      await this.sleep(backoffSec(attempt) * 1000);
      try {
        published = await this.deps.matchPublished(gameId);
      } catch (err) {
        this.emit({ stage: "failed", ...gid, label: (err as Error).message });
        return;
      }
      if (published) break;
    }
    if (!published) {
      this.emit({ stage: "failed", ...gid, label: "Riot hasn't published this game yet. Press Sync games later." });
      return;
    }
    this.emit({ stage: "analyzing", ...gid, label: "Analyzing your game" });
    let reports: GameReport[];
    try {
      reports = await this.deps.sync();
    } catch (err) {
      this.emit({ stage: "failed", ...gid, label: (err as Error).message });
      return;
    }
    const r = reports.find((x) => gameIdOf(x.metrics.matchId) === gameId);
    if (!r) {
      this.emit({ stage: "failed", ...gid, label: "That game was too short to review (remake)." });
      return;
    }
    this.emit({ stage: "ready", ...gid, matchId: r.metrics.matchId, label: "Your review is ready" });
    this.deps.openReview(r.metrics.matchId);
    this.deps.queueRead?.(r.metrics.matchId);
  }

  /** Downloads the replay as soon as Riot has it. Never blocks the review. */
  private async replay(gameId: string, launch: boolean): Promise<void> {
    const lc = await this.deps.league();
    const deadline = Date.now() + REPLAY_DEADLINE_MS;
    let requested = false;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      const meta = await lc.replayMeta(gameId);
      const state = meta?.state ?? "";
      if (state === "watch") {
        if (this.last.stage === "ready" && this.last.gameId === gameId) this.deps.status({ ...this.last, label: "Your review is ready · replay downloaded" });
        if (launch && SAFE_TO_LAUNCH_PHASES.includes((await lc.gameflowPhase()) ?? "None")) {
          await lc.watch(gameId).catch(() => undefined);
        }
        return;
      }
      if (state === "incompatible" || state === "missingOrExpired") return;
      if (state === "download" && !requested) {
        requested = true;
        await lc.download(gameId).catch(() => {
          requested = false;
        });
      }
      if (state === "downloading" && this.last.stage === "ready") {
        // Only surfaced once the review is up, so it never hides the analysis status.
        const raw = meta?.downloadProgress ?? 0;
        const pct = Math.round(raw > 1 ? raw : raw * 100); // the client has reported both 0..1 and 0..100
        this.deps.status({ ...this.last, label: `Your review is ready · replay ${pct}% downloaded` });
      }
      await this.sleep((state === "downloading" ? 3 : Math.min(backoffSec(attempt), 30)) * 1000);
    }
  }
}
