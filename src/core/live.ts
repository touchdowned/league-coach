/**
 * Live game reading, from League's own Live Client Data API (https://127.0.0.1:2999/liveclientdata).
 *
 * That API is read-only, run by the game itself for third-party tools, and only reports what
 * the player can already see on their own screen (their stats, everyone's scoreboard, the
 * kill feed). Nothing here reads game memory or sends input to the game.
 *
 * This file is pure (no Electron, no network) so it can be tested with recorded snapshots.
 */

export type LiveTeam = "ORDER" | "CHAOS";

export interface LivePlayer {
  riotId?: string; // "Name#TAG"
  riotIdGameName?: string;
  summonerName?: string;
  championName: string;
  rawChampionName?: string;
  team: LiveTeam;
  position?: string; // "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY" | ""
  level: number;
  isDead: boolean;
  respawnTimer: number;
  isBot?: boolean;
  scores: { kills: number; deaths: number; assists: number; creepScore: number; wardScore: number };
  items: { itemID: number; price: number; count?: number }[];
}

export interface LiveEvent {
  EventID: number;
  EventName: string;
  EventTime: number; // seconds
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  DragonType?: string;
  Stolen?: string;
}

/** Shape of /liveclientdata/allgamedata (the parts we use). */
export interface AllGameData {
  activePlayer?: { riotId?: string; riotIdGameName?: string; summonerName?: string; level?: number; currentGold?: number; error?: string };
  allPlayers?: LivePlayer[];
  events?: { Events?: LiveEvent[] };
  gameData?: { gameMode?: string; gameTime?: number; mapNumber?: number };
}

const norm = (s?: string) => (s ?? "").split("#")[0].trim().toLowerCase();

/** Every name the kill feed might use for this player. */
export function namesOf(p: { riotId?: string; riotIdGameName?: string; summonerName?: string }): string[] {
  return [p.riotId, p.riotIdGameName, p.summonerName].map(norm).filter(Boolean);
}

export const isPlayer = (p: LivePlayer, name?: string) => !!name && namesOf(p).includes(norm(name));

export function findMe(d: AllGameData): LivePlayer | null {
  const a = d.activePlayer;
  if (!a || a.error || !d.allPlayers?.length) return null;
  const mine = namesOf(a);
  return d.allPlayers.find((p) => namesOf(p).some((n) => mine.includes(n))) ?? null;
}

/** Item gold: what a player has bought, which everyone can see on the scoreboard. */
export const itemGold = (p: LivePlayer) => p.items.reduce((s, i) => s + (i.price ?? 0) * Math.max(1, i.count ?? 1), 0);

/** The enemy in the same lane (by role), if the game reports roles. */
export function laneOpponent(d: AllGameData, me: LivePlayer): LivePlayer | null {
  if (!me.position) return null;
  return d.allPlayers?.find((p) => p.team !== me.team && p.position === me.position) ?? null;
}

export function enemyJungler(d: AllGameData, me: LivePlayer): LivePlayer | null {
  return d.allPlayers?.find((p) => p.team !== me.team && p.position === "JUNGLE") ?? null;
}

/** The live API is also served while watching a replay or spectating. Only a game you play counts (Practice Tool included, so the overlay can be tried there). */
export function isPlayableGame(d: AllGameData | null): d is AllGameData {
  return !!d && !!findMe(d) && (d.gameData?.gameTime ?? 0) > 0;
}

/** The champion's key as match-v5 spells it ("MonkeyKing", not "Wukong"). */
export function champKey(p: LivePlayer): string {
  const raw = p.rawChampionName?.match(/displayname_(\w+)$/i)?.[1];
  return raw ?? p.championName.replace(/[^A-Za-z]/g, "");
}
