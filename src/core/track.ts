import type { MatchDto, Position, TimelineDto } from "./types";

/**
 * A compact record of where all ten champions were during a game, built from the
 * match timeline. Riot gives every champion's position once a minute, plus the exact
 * spot of every kill. Between those points positions are estimated, and the UI shows
 * how sure it is (see `positionAt`).
 */
export interface Track {
  players: { id: number; champion: string; teamId: number; role: Position }[];
  /** Per player id: known positions, oldest first. `dead` marks a kill spot where this player died. */
  keys: Record<number, { t: number; x: number; y: number; dead?: boolean }[]>;
  kills: { t: number; x: number; y: number; killer: number; victim: number; assists: number[] }[];
  objectives: { t: number; x: number; y: number; teamId: number; label: string }[];
  durationMs: number;
}

// Summoner's Rift bounds in game units (the minimap image covers exactly this).
export const RIFT = { minX: -120, minY: -120, maxX: 14870, maxY: 14980 };

const OBJECTIVE_LABEL: Record<string, string> = { DRAGON: "Dragon", BARON_NASHOR: "Baron", RIFTHERALD: "Herald", HORDE: "Grubs", ATAKHAN: "Atakhan" };
const OBJECTIVE_AT: Record<string, { x: number; y: number }> = {
  DRAGON: { x: 9866, y: 4414 },
  BARON_NASHOR: { x: 5007, y: 10471 },
  RIFTHERALD: { x: 5007, y: 10471 },
  HORDE: { x: 5007, y: 10471 },
  ATAKHAN: { x: 7400, y: 7400 },
};

export function buildTrack(match: MatchDto, timeline: TimelineDto): Track {
  const players = match.info.participants.map((p) => ({ id: p.participantId, champion: p.championName, teamId: p.teamId, role: p.teamPosition }));
  const keys: Track["keys"] = {};
  for (const p of players) keys[p.id] = [];
  const kills: Track["kills"] = [];
  const objectives: Track["objectives"] = [];

  for (const f of timeline.info.frames) {
    for (const p of players) {
      const pos = f.participantFrames[String(p.id)]?.position;
      if (pos) keys[p.id].push({ t: f.timestamp, x: pos.x, y: pos.y });
    }
    for (const e of f.events ?? []) {
      if (e.type === "CHAMPION_KILL" && e.position && e.victimId) {
        const assists = e.assistingParticipantIds ?? [];
        kills.push({ t: e.timestamp, x: e.position.x, y: e.position.y, killer: e.killerId ?? 0, victim: e.victimId, assists });
        keys[e.victimId]?.push({ t: e.timestamp, x: e.position.x, y: e.position.y, dead: true });
        // Killers and assisters were near the kill, not exactly on it, but it's the best point we have.
        for (const id of [e.killerId ?? 0, ...assists]) keys[id]?.push({ t: e.timestamp, x: e.position.x, y: e.position.y });
      }
      if (e.type === "ELITE_MONSTER_KILL" && e.monsterType && e.killerTeamId) {
        const at = e.position ?? OBJECTIVE_AT[e.monsterType];
        if (at) objectives.push({ t: e.timestamp, x: at.x, y: at.y, teamId: e.killerTeamId, label: OBJECTIVE_LABEL[e.monsterType] ?? e.monsterType });
      }
    }
  }
  for (const id in keys) keys[id].sort((a, b) => a.t - b.t);
  return { players, keys, kills, objectives, durationMs: match.info.gameDuration * 1000 };
}

export interface Placed {
  x: number;
  y: number;
  /** 1 = Riot recorded this exact spot within a few seconds; falls toward 0 the further we are from a known point. */
  certainty: number;
  dead: boolean;
}

/** Where a player most likely was at time t. */
export function positionAt(track: Track, id: number, t: number): Placed | null {
  const ks = track.keys[id];
  if (!ks?.length) return null;
  let i = ks.findIndex((k) => k.t > t);
  if (i === -1) i = ks.length;
  const a = ks[i - 1];
  const b = ks[i];
  if (!a) return { x: b.x, y: b.y, certainty: certaintyFor(b.t - t), dead: false };
  if (a.dead) return { x: a.x, y: a.y, certainty: 1, dead: !b || t < b.t }; // hold on the death spot until the next known point
  if (!b) return { x: a.x, y: a.y, certainty: certaintyFor(t - a.t), dead: false };
  const f = (t - a.t) / Math.max(1, b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, certainty: certaintyFor(Math.min(t - a.t, b.t - t)), dead: false };
}

function certaintyFor(gapMs: number): number {
  const s = Math.abs(gapMs) / 1000;
  if (s <= 4) return 1;
  return Math.max(0.25, 1 - (s - 4) / 30);
}

export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** A plain-words description of a map spot, used when revealing an answer. */
export function describeSpot(p: { x: number; y: number }, myTeam: number): string {
  const { x, y } = p;
  const side = (blueHalf: boolean) => (blueHalf === (myTeam === 100) ? "your" : "their");
  const d = x - y; // >0 bottom-right half, <0 top-left half
  const s = x + y; // <~14700 blue half
  if (x < 2500 && y < 2500) return "near the blue base";
  if (x > 12300 && y > 12300) return "near the red base";
  if (Math.abs(d) < 1600 && s > 6000 && s < 23500) {
    if (Math.abs(s - 14800) < 2600) return "in mid lane";
    return `in mid lane, on ${side(s < 14800)} side`;
  }
  if (Math.abs(s - 14800) < 1700) return d > 0 ? "in the bottom river by dragon" : "in the top river by baron";
  if (y > 12000 || x < 2000) return "in top lane";
  if (x > 12800 || y < 2000) return "in bottom lane";
  const blueHalf = s < 14800;
  return `in ${side(blueHalf)} ${d > 0 ? "bottom-side" : "top-side"} jungle`;
}

export interface JunglePuzzle {
  id: string;
  matchId: string;
  t: number;
  teamId: number;
  jungler: { id: number; champion: string };
  /** The jungler's actual spot at t. */
  answer: { x: number; y: number };
  /** Where the jungler was last seen (one minute earlier). */
  lastSeen: { t: number; x: number; y: number };
}

/**
 * Jungle tracking questions from your own games: at a given minute in the laning
 * phase, where is the enemy jungler? You see everyone else, plus where they were a
 * minute ago, the same information a good minimap habit gives you.
 */
export function junglePuzzles(games: { metrics: { matchId: string }; teamId: number; track?: Track }[]): JunglePuzzle[] {
  const out: JunglePuzzle[] = [];
  for (const g of games) {
    const tr = g.track;
    if (!tr) continue;
    const jg = tr.players.find((p) => p.teamId !== g.teamId && p.role === "JUNGLE");
    if (!jg) continue;
    const frames = tr.keys[jg.id].filter((k) => !k.dead && k.t % 60000 < 1500);
    for (let i = 1; i < frames.length; i++) {
      const cur = frames[i];
      const min = Math.round(cur.t / 60000);
      if (min < 3 || min > 14) continue;
      const prev = frames[i - 1];
      if (dist(cur, prev) < 1200) continue; // stood still: not a tracking question
      out.push({ id: `${g.metrics.matchId}:${min}`, matchId: g.metrics.matchId, t: cur.t, teamId: g.teamId, jungler: { id: jg.id, champion: jg.champion }, answer: { x: cur.x, y: cur.y }, lastSeen: prev });
    }
  }
  return out;
}

/** How close a guess was, in plain words. 1000 units is roughly a lane brush to the next. */
export function gradeGuess(d: number): { label: string; tone: "good" | "ok" | "bad"; right: boolean } {
  if (d < 1500) return { label: "Spot on", tone: "good", right: true };
  if (d < 3000) return { label: "Close", tone: "ok", right: true };
  if (d < 5000) return { label: "Wrong area", tone: "bad", right: false };
  return { label: "Other side of the map", tone: "bad", right: false };
}
