import type { ProgressEvent, ProgressResult, ProgressState } from "../core/progress";
import type { PostGameStatus } from "../core/postgame";
import type { GameReport } from "../core/types";
import type { ChallengeId, Debrief, GamePlan, LiveRecord, LiveView } from "../core/mind";

export type { PostGameStatus };

export interface Settings {
  apiKey: string;
  riotId: string;
  region: string;
  matchCount: number;
  leagueDir: string;
  vodDir: string;
  autoAdvanceSec: number;
  autoReview: boolean;
  autoLaunchReplay: boolean;
  launchAtLogin: boolean;
  overlay: boolean;
  overlayNudges: boolean;
  overlayPos: { x: number; y: number } | null;
  draftCompanion: boolean;
  autoDebrief: boolean;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type ReplayState =
  | { kind: "client-closed" }
  | { kind: "api-disabled" }
  | { kind: "unavailable"; reason: string }
  | { kind: "can-download" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "open"; time: number; length: number; paused: boolean };

export interface Playback {
  time: number;
  length: number;
  paused: boolean;
  speed?: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The subset of /replay/render the walkthrough uses. */
export interface RenderState {
  cameraMode?: string;
  cameraAttached?: boolean;
  cameraPosition?: Vec3;
  cameraRotation?: Vec3;
  fieldOfView?: number;
  fogOfWar?: boolean;
  selectionName?: string;
  [k: string]: unknown;
}

export interface Vod {
  url: string;
  name: string;
}

export interface TaskProgress {
  done: number;
  total: number;
  label: string;
}

export interface CoachApi {
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  sync(): Promise<{ ok: true; reports: GameReport[]; warning?: string } | { ok: false; error: string }>;
  listGames(): Promise<GameReport[]>;
  onProgress(cb: (p: TaskProgress) => void): () => void;

  getProgress(): Promise<ProgressState>;
  progressEvent(e: ProgressEvent): Promise<ProgressResult>;

  replayState(matchId: string): Promise<Result<ReplayState>>;
  /** The synced game whose replay is open in League right now, or null. */
  replayOpenMatch(): Promise<Result<string | null>>;
  replayDownload(matchId: string): Promise<Result<void>>;
  replayWatch(matchId: string): Promise<Result<void>>;
  replaySeek(sec: number, paused: boolean): Promise<Result<boolean>>;
  replayFollow(champion: string): Promise<Result<void>>;
  replayEnableApi(): Promise<Result<void>>;
  /** Plays the replay and reads minions off the minimap, then returns the re-read game. */
  replayRead(matchId: string): Promise<Result<GameReport>>;
  replayReadCancel(): Promise<Result<void>>;
  benchGet(): Promise<Result<import("../core/benchmark").LaneStats[]>>;
  onBenchUpdated(cb: (added: number) => void): () => void;
  onScanProgress(cb: (p: TaskProgress & { phase?: string }) => void): () => void;
  clipsList(matchId: string): Promise<Result<Record<string, string>>>;
  clipsRecord(matchId: string, moments: number[]): Promise<Result<Record<string, string>>>;
  clipsCancel(): Promise<Result<void>>;
  onClipsProgress(cb: (p: TaskProgress) => void): () => void;

  /** Opens this game's replay in League (downloads first if needed). */
  stageOpen(matchId: string): Promise<Result<Playback>>;
  /** The League game window, for streaming it into the app. */
  stageSource(): Promise<Result<{ id: string; name: string } | null>>;
  /** Without a body: read playback. With one: set time/paused/speed. */
  stagePlayback(body?: { time?: number; paused?: boolean; speed?: number }): Promise<Result<Playback | null>>;
  stageRender(body?: Record<string, unknown>): Promise<Result<RenderState | null>>;
  stageSequence(body: Record<string, unknown>): Promise<Result<boolean>>;
  /** Smoothly moves the free camera to a target. */
  stageGlide(target: { cameraPosition: Vec3; cameraRotation: Vec3; fieldOfView?: number }, ms?: number): Promise<Result<boolean>>;
  stageFocus(): Promise<Result<void>>;
  onStageProgress(cb: (label: string) => void): () => void;
  /** Coaching overlay over the League replay window. */
  overlayOpen(matchId: string): Promise<Result<void>>;
  overlayClose(finished: boolean): Promise<Result<void>>;
  overlayInteractive(on: boolean): Promise<Result<void>>;
  overlayFocus(): Promise<Result<void>>;
  onOverlayClosed(cb: (e: { matchId: string; finished: boolean; lost?: boolean }) => void): () => void;

  vodFind(matchId: string): Promise<Result<Vod | null>>;
  vodPick(matchId: string): Promise<Result<Vod | null>>;
  folderPick(): Promise<Result<string | null>>;

  postGameStatus(): Promise<Result<PostGameStatus | undefined>>;
  onPostGameStatus(cb: (s: PostGameStatus) => void): () => void;
  onPostGameOpen(cb: (matchId: string) => void): () => void;

  mindGet(): Promise<Result<MindData>>;
  mindDraftInfo(): Promise<Result<DraftInfo>>;
  mindLockPlan(p: { skill: ChallengeId; mental: ChallengeId; intention: string; champion?: string; role?: string }): Promise<Result<GamePlan>>;
  mindNextPlan(): Promise<Result<GamePlan | null>>;
  mindCloseDraft(): Promise<Result<void>>;
  mindSaveDebrief(db: Debrief): Promise<Result<MindData>>;
  mindSkipDebrief(gameId: string): Promise<Result<MindData>>;
  mindCheckIn(n: number): Promise<Result<void>>;
  mindPreview(): Promise<Result<void>>;
  mindEndPreview(): Promise<Result<void>>;
  mindWindowMode(): Promise<Result<"fullscreen" | "windowed" | "borderless" | "unknown">>;
  mindSetOverlayPos(pos: { x: number; y: number }): Promise<Result<void>>;
  onMindDraft(cb: (d: DraftInfo) => void): () => void;
  onMindLive(cb: (p: LivePayload) => void): () => void;
  onMindPlan(cb: (p: GamePlan) => void): () => void;
  onMindDebrief(cb: (gameId: string) => void): () => void;
}

export interface MindData {
  plans: GamePlan[];
  records: LiveRecord[];
  debriefs: Debrief[];
  pending: string[];
}

export interface DraftOption {
  id: ChallengeId;
  title: string;
  rule: string;
  why: string;
  pass: string;
  reason: string;
}

export interface DraftInfo {
  phase: "champ-select" | "locked";
  champion: string | null;
  championName: string | null;
  role: string;
  enemy: string | null;
  enemyName: string | null;
  read: { games: number; winRate: number | null; cs10: number | null; deathsPre14: number | null; vsGames: number; vsWinRate: number | null; vsGold15: number | null } | null;
  skillOptions: DraftOption[];
  mentalOptions: DraftOption[];
  recommendedSkill: ChallengeId;
  recommendedMental: ChallengeId;
  queue: { tone: "good" | "warn" | "bad"; title: string; body: string };
  plan: GamePlan | null;
  lastIntention: string | null;
}

export interface LivePayload {
  view: LiveView;
  hidden?: boolean;
  editing?: boolean;
  pos?: { x: number; y: number } | null;
  nudges?: boolean;
  intention?: string;
  rules: { skill: string; mental: string; skillId: ChallengeId; mentalId: ChallengeId } | null;
  preview?: boolean;
}

declare global {
  interface Window {
    coach: CoachApi;
  }
}

export const coach = (): CoachApi => window.coach;
