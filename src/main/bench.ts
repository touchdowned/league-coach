import { laneStats, LaneStats } from "../core/benchmark";
import { RiotClient } from "../core/riot";
import type { Position } from "../core/types";
import type { JsonStore } from "./store";

/**
 * Grows a local set of Master+ laning benchmarks a little after each sync, so it never
 * eats the API key's rate limit in one go.
 */
interface BenchFile {
  players: string[];
  playersAt: number;
  seen: string[];
  stats: LaneStats[];
}
const EMPTY: BenchFile = { players: [], playersAt: 0, seen: [], stats: [] };
const FILE = "bench.json";
const PER_ROLE = 60;

export async function readBench(store: JsonStore): Promise<LaneStats[]> {
  return (await store.readJson<BenchFile>(FILE, EMPTY)).stats;
}

/** Adds up to `budget` new high-elo games for the roles you play. Returns how many stats were added. */
export async function growBench(store: JsonStore, riot: RiotClient, roles: Position[], budget = 8, isCancelled: () => boolean = () => false): Promise<number> {
  const b = await store.readJson<BenchFile>(FILE, EMPTY);
  const need = roles.filter((r) => b.stats.filter((s) => s.role === r).length < PER_ROLE);
  if (!need.length) return 0;
  if (!b.players.length || Date.now() - b.playersAt > 3 * 86_400_000) {
    b.players = await riot.getApexPuuids();
    b.playersAt = Date.now();
  }
  if (!b.players.length) return 0;
  const seen = new Set(b.seen);
  let added = 0;
  let timelines = 0;
  for (let tries = 0; tries < 4 && timelines < budget && !isCancelled(); tries++) {
    const puuid = b.players[Math.floor(Math.random() * b.players.length)];
    const ids = await riot.getMatchIds(puuid, 10, 420);
    for (const id of ids) {
      if (timelines >= budget || isCancelled()) break;
      if (seen.has(id)) continue;
      seen.add(id);
      const match = await riot.getMatch(id);
      if (match.info.gameDuration < 15 * 60) continue;
      const wanted = match.info.participants.filter((p) => need.includes(p.teamPosition));
      if (!wanted.length) continue;
      const tl = await riot.getTimeline(id);
      timelines++;
      for (const p of wanted) {
        const s = laneStats(match, tl, p.participantId);
        if (s) {
          b.stats.push(s);
          added++;
        }
      }
    }
  }
  b.seen = [...seen].slice(-3000);
  await store.writeJson(FILE, b);
  return added;
}
