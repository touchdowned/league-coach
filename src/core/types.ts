// Subset of Riot match-v5 and timeline DTOs that the coach uses.

export type Position = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | "";

export interface Participant {
  puuid: string;
  participantId: number;
  teamId: number;
  teamPosition: Position;
  championName: string;
  riotIdGameName?: string;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  goldEarned: number;
  visionScore: number;
  totalDamageDealtToChampions: number;
  win: boolean;
  challenges?: { soloKills?: number; [k: string]: unknown };
}

export interface MatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameCreation: number;
    gameDuration: number; // seconds
    queueId: number;
    gameVersion: string;
    participants: Participant[];
  };
}

export interface ParticipantFrame {
  participantId: number;
  totalGold: number;
  currentGold: number;
  xp: number;
  level: number;
  minionsKilled: number;
  jungleMinionsKilled: number;
  position: { x: number; y: number };
}

export interface TimelineEvent {
  type: string;
  timestamp: number; // ms
  killerId?: number;
  victimId?: number;
  assistingParticipantIds?: number[];
  position?: { x: number; y: number };
  shutdownBounty?: number;
  bounty?: number;
  monsterType?: string;
  killerTeamId?: number;
  creatorId?: number;
  wardType?: string;
  participantId?: number;
  itemId?: number;
  /** BUILDING_KILL / TURRET_PLATE_DESTROYED: the team that lost it. */
  teamId?: number;
  laneType?: string;
  buildingType?: string;
  towerType?: string;
}

export interface TimelineDto {
  metadata: { matchId: string };
  info: {
    frameInterval: number;
    frames: { timestamp: number; participantFrames: Record<string, ParticipantFrame>; events: TimelineEvent[] }[];
  };
}

// ---- Coach output ----

export type MistakeKind =
  | "ganked"
  | "overextended"
  | "gave_shutdown"
  | "died_with_gold"
  | "died_before_objective"
  | "threw_lead"
  | "early_death";

export interface MistakeContext {
  minute: number;
  currentGold: number | null;
  goldDiff: number | null; // vs lane opponent, just before the death
  position: { x: number; y: number } | null;
  killers: string[];
  enemyJunglerInvolved: boolean;
  numberOfEnemies: number;
  deepInEnemyHalf: boolean;
  followedBy: { name: string; afterSec: number } | null;
  shutdownGiven: number;
}

export interface Mistake {
  kind: MistakeKind;
  timeMs: number;
  severity: number; // 1-10
  title: string;
  detail: string;
  /** What the player was probably thinking, inferred from what they did. */
  read: string;
  /** Why that read was wrong and what to do instead. */
  tip: string;
  context: MistakeContext;
}

export interface GameMetrics {
  matchId: string;
  gameCreation: number;
  durationMin: number;
  queueId: number;
  role: Position;
  champion: string;
  opponentChampion: string | null;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs10: number;
  cs15: number;
  csPerMin: number;
  goldDiff10: number | null;
  goldDiff15: number | null;
  xpDiff10: number | null;
  xpDiff15: number | null;
  deathsPre14: number;
  killParticipation: number; // 0-1
  visionPerMin: number;
  soloKills: number;
  damageShare: number; // 0-1
}

export interface SeriesPoint {
  minute: number;
  goldDiff: number | null; // vs lane opponent
  xpDiff: number | null;
  cs: number;
  oppCs: number | null;
}

export interface MapEvent {
  timeMs: number;
  x: number;
  y: number;
}

export interface GameReport {
  metrics: GameMetrics;
  teamId: number;
  gameVersion: string;
  series: SeriesPoint[];
  deathsAt: MapEvent[];
  killsAt: MapEvent[];
  mistakes: Mistake[]; // top mistakes, most severe first
  strengths: string[];
  focus: string; // one thing to work on next game
  grade: "S" | "A" | "B" | "C" | "D";
  /** Where all ten champions were. Missing on reports saved before this existed. */
  track?: import("./track").Track;
  /** Every gold leak the engine found, biggest first. Missing on older saved reports. */
  leaks?: import("./engine").Leak[];
}
