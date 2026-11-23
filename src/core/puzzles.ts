import { isDeepInEnemyHalf } from "./analysis";
import type { GameReport, MistakeKind } from "./types";

/**
 * Decision puzzles. Each one freezes a moment just before a mistake, shows the
 * situation on the map, and asks for the right play. Puzzles come first from the
 * player's own games (the moment before they died), then from generated drills,
 * so the stream never ends.
 */

export type Choice = "recall" | "push" | "fight" | "retreat" | "ward" | "group" | "farm_safe";

export const CHOICES: Record<Choice, string> = {
  recall: "Recall and buy",
  push: "Keep pushing / take the plate",
  fight: "Go for the kill",
  retreat: "Back off to your side of the map",
  ward: "Ward river, then play forward",
  group: "Reset and group for the objective",
  farm_safe: "Let the wave come and farm under tower",
};

export interface Puzzle {
  id: string;
  source: "your-game" | "drill";
  champion: string;
  opponent: string | null;
  minute: number;
  facts: string[];
  /** Where you are, in Summoner's Rift coordinates. */
  position: { x: number; y: number };
  teamId: number;
  /** Threat markers shown on the map (e.g. last-seen enemy jungler). */
  threats: { x: number; y: number; label: string }[];
  options: Choice[];
  answer: Choice;
  /** What the player actually did in that game, if from their games. */
  youChose: Choice | null;
  explanation: string;
  outcome: string | null;
  matchId: string | null;
}

interface Template {
  answer: Choice;
  youChose: Choice;
  distractors: Choice[];
  explanation: string;
}

const TEMPLATES: Partial<Record<MistakeKind, Template>> = {
  died_with_gold: {
    answer: "recall",
    youChose: "push",
    distractors: ["push", "fight", "ward"],
    explanation: "You're holding a full component. Every second you stay, you're fighting with less stats than you've paid for. Recall now and come back stronger.",
  },
  ganked: {
    answer: "ward",
    youChose: "push",
    distractors: ["push", "fight", "recall"],
    explanation: "The enemy jungler is unaccounted for and your wave is past the middle. Without a river ward you're guessing. Get vision first, then play forward.",
  },
  overextended: {
    answer: "retreat",
    youChose: "push",
    distractors: ["push", "fight", "ward"],
    explanation: "You're on their half of the map without knowing where they are. Missing enemies means they're coming for you. Walk back until you have information.",
  },
  gave_shutdown: {
    answer: "recall",
    youChose: "fight",
    distractors: ["fight", "push", "retreat"],
    explanation: "You're worth a big shutdown. Turn the lead into items instead of risking it in a fight you don't need.",
  },
  threw_lead: {
    answer: "recall",
    youChose: "fight",
    distractors: ["fight", "push", "farm_safe"],
    explanation: "You're ahead in lane. The only way to lose that lead is to die. Bank it: shove, recall, buy.",
  },
  died_before_objective: {
    answer: "group",
    youChose: "push",
    distractors: ["push", "fight", "farm_safe"],
    explanation: "An objective is about to be contested. Your job is to be alive and next to your team when it spawns, not to take one more wave.",
  },
  early_death: {
    answer: "farm_safe",
    youChose: "fight",
    distractors: ["fight", "push", "recall"],
    explanation: "You don't know if you win this trade. When in doubt in lane, take the free CS and wait for them to make the mistake.",
  },
};

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function zone(teamId: number, pos: { x: number; y: number }): string {
  const sum = pos.x + pos.y;
  if (isDeepInEnemyHalf(teamId, pos)) return "deep on the enemy's half of the map";
  if (Math.abs(sum - 14870) < 1800) return "near the river";
  return "on your half of the map";
}

function laneSpot(role: string, teamId: number): { x: number; y: number } {
  const ahead = teamId === 100 ? 1 : -1;
  if (role === "TOP") return { x: 2200, y: 11500 + ahead * 800 };
  if (role === "BOTTOM" || role === "UTILITY") return { x: 11500 + ahead * 800, y: 2200 };
  return { x: 7400 + ahead * 600, y: 7400 + ahead * 600 };
}

function junglerGuess(role: string, teamId: number): { x: number; y: number } {
  const enemyBlue = teamId === 100;
  if (role === "TOP") return enemyBlue ? { x: 4500, y: 12000 } : { x: 3000, y: 10000 };
  if (role === "BOTTOM" || role === "UTILITY") return enemyBlue ? { x: 12000, y: 4500 } : { x: 10000, y: 3000 };
  return enemyBlue ? { x: 9000, y: 10500 } : { x: 5800, y: 4400 };
}

function buildFacts(minute: number, gold: number | null, goldDiff: number | null, where: string, opponent: string | null, objectiveSoon: string | null): string[] {
  if (gold !== null) gold = Math.round(gold);
  const secs = Math.round(minute * 60);
  const f = [`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} in game. You're ${where}.`];
  if (gold !== null) f.push(`You have ${gold}g unspent.`);
  if (goldDiff !== null) goldDiff = Math.round(goldDiff);
  if (goldDiff !== null) f.push(`You're ${goldDiff >= 0 ? `${goldDiff}g ahead of` : `${-goldDiff}g behind`} ${opponent ?? "your lane opponent"}.`);
  f.push("The enemy jungler hasn't been seen for over 40 seconds.");
  if (objectiveSoon) f.push(`${objectiveSoon[0].toUpperCase()}${objectiveSoon.slice(1)} spawns in about a minute.`);
  return f;
}

/** Puzzles from the player's own deaths, newest games first. */
export function puzzlesFromGames(reports: GameReport[]): Puzzle[] {
  const out: Puzzle[] = [];
  for (const r of reports) {
    const seen = new Set<number>();
    for (const m of r.mistakes) {
      if (seen.has(m.timeMs)) continue; // one puzzle per death
      const t = TEMPLATES[m.kind];
      if (!t || !m.context) continue;
      seen.add(m.timeMs);
      const c = m.context;
      // Show the moment ~10 seconds before the death.
      const minute = Math.max(0, c.minute - 10 / 60);
      const pos = c.position ?? laneSpot(r.metrics.role, r.teamId);
      const opts = shuffle([t.answer, ...t.distractors.filter((d) => d !== t.answer).slice(0, 3)], Math.round(m.timeMs) + out.length);
      out.push({
        id: `${r.metrics.matchId}-${m.timeMs}`,
        source: "your-game",
        champion: r.metrics.champion,
        opponent: r.metrics.opponentChampion,
        minute,
        facts: buildFacts(minute, c.currentGold, c.goldDiff, zone(r.teamId, pos), r.metrics.opponentChampion, c.followedBy?.name ?? null),
        position: pos,
        teamId: r.teamId,
        threats: c.enemyJunglerInvolved ? [{ ...junglerGuess(r.metrics.role, r.teamId), label: "?" }] : [],
        options: opts,
        answer: t.answer,
        youChose: t.youChose,
        explanation: t.explanation,
        outcome: `${m.title}. ${m.detail}`,
        matchId: r.metrics.matchId,
      });
    }
  }
  return out;
}

const DRILL_KINDS: MistakeKind[] = ["died_with_gold", "ganked", "overextended", "threw_lead", "died_before_objective", "early_death"];
const DRILL_CHAMPS = ["Ahri", "Syndra", "Orianna", "Yasuo", "Zed", "Viktor", "Darius", "Garen", "Sett", "Malphite", "Camille", "Jax"];

/** A generated drill. Same index always gives the same puzzle. */
export function drill(index: number, champion?: string, role = "MIDDLE"): Puzzle {
  let s = index * 7919 + 17;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const kind = DRILL_KINDS[Math.floor(rnd() * DRILL_KINDS.length)];
  const t = TEMPLATES[kind]!;
  const teamId = rnd() < 0.5 ? 100 : 200;
  const me = champion ?? DRILL_CHAMPS[Math.floor(rnd() * DRILL_CHAMPS.length)];
  const opp = DRILL_CHAMPS.filter((c) => c !== me)[Math.floor(rnd() * (DRILL_CHAMPS.length - 1))];
  const minute = kind === "died_before_objective" ? 18 + rnd() * 10 : 4 + rnd() * 9;
  const gold = kind === "died_with_gold" ? 1300 + Math.round(rnd() * 900) : Math.round(100 + rnd() * 700);
  const goldDiff = kind === "threw_lead" ? 500 + Math.round(rnd() * 1000) : Math.round(-400 + rnd() * 800);
  const base = laneSpot(role, teamId);
  const dir = teamId === 100 ? 1 : -1;
  const pos =
    kind === "overextended"
      ? { x: 7400 + dir * (2200 + rnd() * 1500), y: 7400 + dir * (2200 + rnd() * 1500) }
      : { x: base.x + dir * rnd() * 600, y: base.y + dir * rnd() * 600 };
  const objective = kind === "died_before_objective" ? (rnd() < 0.5 ? "dragon" : "baron") : null;

  return {
    id: `drill-${index}`,
    source: "drill",
    champion: me,
    opponent: opp,
    minute,
    facts: buildFacts(minute, gold, goldDiff, zone(teamId, pos), opp, objective),
    position: pos,
    teamId,
    threats: kind === "ganked" || kind === "overextended" ? [{ ...junglerGuess(role, teamId), label: "?" }] : [],
    options: shuffle([t.answer, ...t.distractors.filter((d) => d !== t.answer).slice(0, 3)], index + 3),
    answer: t.answer,
    youChose: null,
    explanation: t.explanation,
    outcome: null,
    matchId: null,
  };
}

/** Endless stream: your own moments first, then a drill every other puzzle. */
export function puzzleAt(i: number, own: Puzzle[], champion?: string, role?: string): Puzzle {
  if (i < own.length) return own[i];
  const k = i - own.length;
  if (own.length && k % 2 === 1) return own[Math.floor(k / 2) % own.length];
  return drill(k, champion, role);
}
