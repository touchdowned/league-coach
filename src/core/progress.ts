/**
 * Feedback loop: XP, levels, a daily streak and daily targets. Pure functions so the
 * main process can persist the state and the UI can animate the changes.
 */

export interface ProgressState {
  xp: number;
  /** yyyy-mm-dd of the last day with any activity, for the streak. */
  lastActive: string | null;
  streak: number;
  bestStreak: number;
  today: { date: string; moments: number; puzzles: number; puzzlesRight: number };
  reviewedMoments: string[]; // `${matchId}:${timeMs}`
  reviewedGames: string[];
}

export const EMPTY_PROGRESS: ProgressState = {
  xp: 0,
  lastActive: null,
  streak: 0,
  bestStreak: 0,
  today: { date: "", moments: 0, puzzles: 0, puzzlesRight: 0 },
  reviewedMoments: [],
  reviewedGames: [],
};

export const DAILY = { moments: 3, puzzles: 10 };

export const XP = {
  moment: 15,
  gameReviewed: 40,
  puzzleRight: 10,
  puzzleWrong: 3,
  dailyComplete: 100,
};

export type ProgressEvent =
  | { type: "moment"; id: string }
  | { type: "game"; matchId: string }
  | { type: "puzzle"; right: boolean };

export interface ProgressResult {
  state: ProgressState;
  gained: number;
  leveledUp: boolean;
  dailyJustCompleted: boolean;
  streakExtended: boolean;
}

/** Level n needs 100 * n * (n + 1) / 2 total XP: 100, 300, 600, 1000... */
export function levelOf(xp: number): { level: number; into: number; needed: number } {
  let level = 1;
  let floor = 0;
  while (xp >= floor + 100 * level) {
    floor += 100 * level;
    level++;
  }
  return { level, into: xp - floor, needed: 100 * level };
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

export function dailyDone(t: ProgressState["today"]): boolean {
  return t.moments >= DAILY.moments && t.puzzles >= DAILY.puzzles;
}

/** Applies one event. `now` is injectable for tests. */
export function applyEvent(prev: ProgressState, e: ProgressEvent, now = new Date()): ProgressResult {
  const today = dayKey(now);
  const s: ProgressState = {
    ...prev,
    today: prev.today.date === today ? { ...prev.today } : { date: today, moments: 0, puzzles: 0, puzzlesRight: 0 },
    reviewedMoments: [...prev.reviewedMoments],
    reviewedGames: [...prev.reviewedGames],
  };
  const wasDone = dailyDone(s.today);
  let gained = 0;

  if (e.type === "moment") {
    if (s.reviewedMoments.includes(e.id)) return { state: prev, gained: 0, leveledUp: false, dailyJustCompleted: false, streakExtended: false };
    s.reviewedMoments.push(e.id);
    s.today.moments++;
    gained += XP.moment;
  } else if (e.type === "game") {
    if (s.reviewedGames.includes(e.matchId)) return { state: prev, gained: 0, leveledUp: false, dailyJustCompleted: false, streakExtended: false };
    s.reviewedGames.push(e.matchId);
    gained += XP.gameReviewed;
  } else {
    s.today.puzzles++;
    if (e.right) s.today.puzzlesRight++;
    gained += e.right ? XP.puzzleRight : XP.puzzleWrong;
  }

  // Streak: any activity on consecutive days.
  let streakExtended = false;
  if (s.lastActive !== today) {
    const gap = s.lastActive ? daysBetween(s.lastActive, today) : null;
    s.streak = gap === 1 ? s.streak + 1 : 1;
    s.bestStreak = Math.max(s.bestStreak, s.streak);
    s.lastActive = today;
    streakExtended = true;
  }

  const dailyJustCompleted = !wasDone && dailyDone(s.today);
  if (dailyJustCompleted) gained += XP.dailyComplete;

  const before = levelOf(s.xp).level;
  s.xp += gained;
  return { state: s, gained, leveledUp: levelOf(s.xp).level > before, dailyJustCompleted, streakExtended };
}

/** Streak as shown today: broken if the last activity was before yesterday. */
export function liveStreak(s: ProgressState, now = new Date()): number {
  if (!s.lastActive) return 0;
  return daysBetween(s.lastActive, dayKey(now)) <= 1 ? s.streak : 0;
}
