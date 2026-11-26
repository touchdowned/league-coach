/**
 * One focus at a time. The findings of the games whose replays were read (Module 3) are grouped
 * by kind; the kind that cost the most per game becomes the focus, with one rule to follow in
 * game and a pass line counted the same way the findings are. Every later read game is graded
 * against it. The focus stays until it holds in 3 of the last 4 graded games, then the next
 * costliest kind takes its place, so one habit is built before the next is asked for.
 *
 * Nothing here is free text about the player: the sentences are fixed rules with the player's
 * own counts in them, and the grade is a count of findings.
 */
import type { Finding } from "./synth";
import type { GameReport } from "./types";

export type FocusKey = Finding["kind"];

/** Read games looked at when choosing a focus. */
export const FOCUS_WINDOW = 10;
/** Graded games looked at when deciding the focus has stuck, and how many of them must hold. */
export const FOCUS_LAST = 4;
export const FOCUS_HOLD = 3;

export interface FocusState {
  key: FocusKey;
  /** gameCreation of the newest read game when the focus was set: games after it are graded. */
  since: number;
  /** Findings of this kind per read game before the focus was set. */
  baseline: number;
  /** A game holds the focus with at most this many findings of the kind. */
  target: number;
  /** Focuses that stuck, newest first. */
  mastered: { key: FocusKey; at: number }[];
}

export interface FocusGame {
  matchId: string;
  champion: string;
  win: boolean;
  gameCreation: number;
  count: number;
  held: boolean;
  findings: { id: string; time: string; title: string }[];
}

export interface Focus {
  key: FocusKey;
  /** Short name. */
  title: string;
  /** The one thing to do in game. */
  rule: string;
  /** The moment in game to ask yourself the question. */
  cue: string;
  /** The counts that made this the focus. */
  why: string;
  /** "At most 1 recall that loses more than 1.5 waves". */
  pass: string;
  target: number;
  baseline: number;
  /** Read games since the focus was set, newest first. */
  graded: FocusGame[];
  /** Games held among the last FOCUS_LAST graded. */
  held: number;
  /** Held games still needed before the focus moves on (0 to FOCUS_HOLD). */
  needed: number;
  /** The costliest case in the window, to watch. */
  worst: { matchId: string; findingId: string; time: string; title: string } | null;
  /** How many read games the choice was made from. */
  from: number;
}

interface Def {
  title: string;
  rule: string;
  cue: string;
  /** Singular and plural of the thing counted, for the why and pass lines. */
  unit: [string, string];
}

/** The rule for each kind of finding. Thresholds are the ones the findings themselves use. */
export const FOCUS_DEFS: Record<FocusKey, Def> = {
  recall: {
    title: "Recall on a crash",
    rule: "Press B only once your wave has reached their tower. If it hasn't, kill the wave in front of you first, or stay for the next one.",
    cue: "Each time your hand goes to B, ask: where is my wave right now?",
    unit: ["recall that loses more than 1.5 waves or a cannon wave", "recalls that lose more than 1.5 waves or a cannon wave"],
  },
  exposure: {
    title: "Hold the middle line while their jungler is unseen",
    rule: "When you stand past the middle of your lane and their jungler has been off your minimap for 10 s with no allied ward within 3000 units, walk back to the middle line and stay there until the jungler shows.",
    cue: "Each time you finish a wave, ask: when did I last see their jungler?",
    unit: ["stretch past the middle line with their jungler unseen and in reach", "stretches past the middle line with their jungler unseen and in reach"],
  },
  fight: {
    title: "Check levels, items and numbers before you fight",
    rule: "Before you commit, hold Tab for a second. If the one you are about to fight has reached level 2, 3, 6, 11 or 16 before you, has 875 gold more in items, or they have more champions within 2500 units, walk back instead of fighting.",
    cue: "The moment someone walks at you, ask: level, items, how many of them?",
    unit: ["fight taken while down a level breakpoint, 875 gold of items, or a champion", "fights taken while down a level breakpoint, 875 gold of items, or a champion"],
  },
  objective: {
    title: "Be on the map before the objective spawns",
    rule: "Start your recall 60 s before Dragon, Voidgrubs, Rift Herald or Baron spawns, so you are back with your gold spent 15 s before it comes up.",
    cue: "Each time an objective timer shows 1:00, ask: have I recalled yet?",
    unit: ["objective lost while you were on a base trip or carrying item gold", "objectives lost while you were on a base trip or carrying item gold"],
  },
  death: {
    title: "Kill the wave before you fight",
    rule: "Take a fight only after the wave in front of you is dead. A death with a wave on its way costs the death timer, the walk back, and every minion that dies in that time.",
    cue: "Before you trade, ask: is there a wave arriving that I lose if this goes wrong?",
    unit: ["death that costs more than 1.5 waves", "deaths that cost more than 1.5 waves"],
  },
};

const read = (reports: GameReport[]) => reports.filter((r) => Array.isArray(r.findings)).sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation);
const ofKind = (r: GameReport, key: FocusKey) => (r.findings ?? []).filter((f) => f.kind === key);
const n1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));

/** A game against a focus: how many findings of its kind, and whether that is within the target. */
export function gradeGame(r: GameReport, state: Pick<FocusState, "key" | "target">): FocusGame {
  const list = ofKind(r, state.key).sort((a, b) => a.t - b.t);
  return {
    matchId: r.metrics.matchId,
    champion: r.metrics.champion,
    win: r.metrics.win,
    gameCreation: r.metrics.gameCreation,
    count: list.length,
    held: list.length <= state.target,
    findings: list.map((f) => ({ id: f.id, time: f.time, title: f.title })),
  };
}

/** Half the usual count, rounded down: 3 a game becomes at most 1, 1 a game or fewer becomes none. */
export const targetFor = (baseline: number) => Math.max(0, Math.floor(baseline / 2));

function choose(games: GameReport[], mastered: FocusState["mastered"]): FocusState | null {
  const window = games.slice(0, FOCUS_WINDOW);
  if (!window.length) return null;
  const last = mastered[0]?.key;
  let best: { key: FocusKey; score: number; count: number } | null = null;
  for (const key of Object.keys(FOCUS_DEFS) as FocusKey[]) {
    const all = window.flatMap((r) => ofKind(r, key));
    if (!all.length) continue;
    // The focus that just stuck isn't picked straight back, unless nothing else was found.
    const score = all.reduce((s, f) => s + f.score, 0) * (key === last ? 0.001 : 1);
    if (!best || score > best.score) best = { key, score, count: all.length };
  }
  if (!best) return null;
  const baseline = best.count / window.length;
  return { key: best.key, since: window[0].metrics.gameCreation, baseline, target: targetFor(baseline), mastered };
}

/**
 * The focus for the next game. `state` is what was saved last time (null the first time); the
 * returned state is what to save. `moved` names the focus that just stuck, when one did.
 */
export function computeFocus(reports: GameReport[], state: FocusState | null): { focus: Focus | null; state: FocusState | null; moved: FocusKey | null } {
  const games = read(reports);
  if (!games.length) return { focus: null, state, moved: null };
  let moved: FocusKey | null = null;
  let st = state;
  if (st) {
    const graded = games.filter((r) => r.metrics.gameCreation > st!.since).map((r) => gradeGame(r, st!));
    if (graded.slice(0, FOCUS_LAST).filter((g) => g.held).length >= FOCUS_HOLD) {
      moved = st.key;
      st = choose(games, [{ key: st.key, at: graded[0].gameCreation }, ...st.mastered]);
    }
  } else st = choose(games, []);
  if (!st) return { focus: null, state: st, moved };
  const cur = st;
  const def = FOCUS_DEFS[cur.key];
  const window = games.filter((r) => r.metrics.gameCreation <= cur.since).slice(0, FOCUS_WINDOW);
  const cases = window.flatMap((r) => ofKind(r, cur.key).map((f) => ({ f, matchId: r.metrics.matchId })));
  const inGames = window.filter((r) => ofKind(r, cur.key).length).length;
  const sum = (pick: (f: Finding) => number) => Math.round(cases.reduce((s, c) => s + pick(c.f), 0));
  const [gold, xp, minions] = [sum((f) => f.gold), sum((f) => f.xp), sum((f) => f.minions)];
  const costs = [minions ? `${minions} minions` : "", xp ? `${xp} XP` : "", gold ? `${gold} gold` : ""].filter(Boolean).join(", ");
  const graded = games.filter((r) => r.metrics.gameCreation > cur.since).map((r) => gradeGame(r, cur));
  const held = graded.slice(0, FOCUS_LAST).filter((g) => g.held).length;
  const worst = [...cases].sort((a, b) => b.f.score - a.f.score)[0];
  return {
    state: cur,
    moved,
    focus: {
      key: cur.key,
      title: def.title,
      rule: def.rule,
      cue: def.cue,
      why: `${cases.length} ${def.unit[cases.length === 1 ? 0 : 1]} in ${inGames} of your last ${window.length} read ${window.length === 1 ? "game" : "games"} (${n1(cur.baseline)} a game)${costs ? `: ${costs} in total` : ""}.`,
      pass: cur.target === 0 ? `No ${def.unit[0]} in the game.` : `At most ${cur.target} ${def.unit[cur.target === 1 ? 0 : 1]} in the game.`,
      target: cur.target,
      baseline: cur.baseline,
      graded,
      held,
      needed: Math.max(0, FOCUS_HOLD - held),
      worst: worst ? { matchId: worst.matchId, findingId: worst.f.id, time: worst.f.time, title: worst.f.title } : null,
      from: window.length,
    },
  };
}
