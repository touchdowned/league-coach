/**
 * Master+ benchmarks from Riot's match timelines: what high-elo players in your role
 * (and on your champion, once enough games are found) did minute by minute.
 *
 * Riot stopped third-party replay downloads of other people's games in patch 26.20,
 * so wave state can't be compared; everything here comes from timelines, which the
 * API still serves for any ranked game.
 */
import type { MatchDto, Position, TimelineDto, TimelineEvent } from "./types";

const MIN = 60_000;

export interface LaneStats {
  matchId: string;
  role: Position;
  champion: string;
  opponent: string | null;
  cs10: number;
  cs15: number;
  firstBack: { t: number; gold: number } | null;
  backs14: number;
  goldPerBack: number | null;
  deaths14: number;
  plates14: number;
  gd15: number | null;
  /** Per minute 0..15: CS, recalls done, gold spent. */
  curve: { cs: number; backs: number; spent: number }[];
}

function csAt(tl: TimelineDto, pid: number, min: number): number {
  const f = tl.info.frames[Math.min(min, tl.info.frames.length - 1)]?.participantFrames[String(pid)];
  return f ? f.minionsKilled + f.jungleMinionsKilled : 0;
}

/** Laning stats for one player in one game. */
export function laneStats(match: MatchDto, tl: TimelineDto, pid: number): LaneStats | null {
  const me = match.info.participants.find((p) => p.participantId === pid);
  if (!me) return null;
  const opp = match.info.participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition) ?? null;
  const events: TimelineEvent[] = tl.info.frames.flatMap((f) => f.events ?? []).sort((a, b) => a.timestamp - b.timestamp);
  const deaths = events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === pid).map((e) => e.timestamp);
  const buys = events.filter((e) => e.type === "ITEM_PURCHASED" && e.participantId === pid && e.timestamp > 90_000).map((e) => e.timestamp);
  const visits: number[] = [];
  for (const b of buys) if (!visits.length || b - visits[visits.length - 1] > 45_000) visits.push(b);
  const backs = visits.filter((v) => !deaths.some((d) => v > d && v - d < 75_000));
  const pocket = (t: number) => {
    const f = tl.info.frames[Math.max(0, Math.floor(t / MIN))]?.participantFrames[String(pid)];
    return f?.currentGold ?? 0;
  };
  const backs14 = backs.filter((t) => t < 14 * MIN);
  const spentAt = (m: number) => {
    const f = tl.info.frames[Math.min(m, tl.info.frames.length - 1)]?.participantFrames[String(pid)];
    return f ? f.totalGold - f.currentGold : 0;
  };
  const gold15 = (id: number) => tl.info.frames[Math.min(15, tl.info.frames.length - 1)]?.participantFrames[String(id)]?.totalGold ?? null;
  const g15 = gold15(pid);
  const o15 = opp ? gold15(opp.participantId) : null;
  const curve = Array.from({ length: 16 }, (_, m) => ({ cs: csAt(tl, pid, m), backs: backs.filter((t) => t <= m * MIN).length, spent: spentAt(m) }));
  return {
    matchId: match.metadata.matchId,
    role: me.teamPosition,
    champion: me.championName,
    opponent: opp?.championName ?? null,
    cs10: csAt(tl, pid, 10),
    cs15: csAt(tl, pid, 15),
    firstBack: backs[0] ? { t: backs[0], gold: pocket(backs[0] - 15_000) } : null,
    backs14: backs14.length,
    goldPerBack: backs14.length ? Math.round(backs14.reduce((s, t) => s + pocket(t - 15_000), 0) / backs14.length) : null,
    deaths14: deaths.filter((t) => t < 14 * MIN).length,
    plates14: events.filter((e) => e.type === "TURRET_PLATE_DESTROYED" && e.killerId === pid && e.timestamp < 14 * MIN).length,
    gd15: g15 != null && o15 != null ? g15 - o15 : null,
    curve,
  };
}

export interface BenchSummary {
  role: Position;
  /** Set when there were enough games on this champion to compare to. */
  champion: string | null;
  n: number;
  med: {
    cs10: number;
    cs15: number;
    firstBackT: number | null;
    firstBackGold: number | null;
    backs14: number;
    goldPerBack: number | null;
    deaths14: number;
    plates14: number;
  };
  curve: { cs: number; backs: number; spent: number }[];
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export const MIN_CHAMP_GAMES = 5;

/** Medians for a role, narrowed to a champion when there are at least 5 games of it. */
export function summarize(all: LaneStats[], role: Position, champion?: string): BenchSummary | null {
  const inRole = all.filter((s) => s.role === role);
  const onChamp = champion ? inRole.filter((s) => s.champion === champion) : [];
  const list = onChamp.length >= MIN_CHAMP_GAMES ? onChamp : inRole;
  if (list.length < 3) return null;
  const m = (f: (s: LaneStats) => number | null | undefined) => median(list.map(f).filter((x): x is number => x != null)) ;
  return {
    role,
    champion: list === onChamp ? champion! : null,
    n: list.length,
    med: {
      cs10: m((s) => s.cs10) ?? 0,
      cs15: m((s) => s.cs15) ?? 0,
      firstBackT: m((s) => s.firstBack?.t),
      firstBackGold: m((s) => s.firstBack?.gold),
      backs14: m((s) => s.backs14) ?? 0,
      goldPerBack: m((s) => s.goldPerBack),
      deaths14: m((s) => s.deaths14) ?? 0,
      plates14: m((s) => s.plates14) ?? 0,
    },
    curve: Array.from({ length: 16 }, (_, i) => ({
      cs: m((s) => s.curve[i]?.cs) ?? 0,
      backs: m((s) => s.curve[i]?.backs) ?? 0,
      spent: m((s) => s.curve[i]?.spent) ?? 0,
    })),
  };
}

/** A one-line comparison at a given minute of your game, for review. */
export function atMinute(b: BenchSummary, mine: LaneStats, t: number): string | null {
  const m = Math.min(15, Math.max(1, Math.round(t / MIN)));
  const them = b.curve[m];
  const you = mine.curve[m];
  if (!them || !you) return null;
  const who = `Master+ ${b.champion ?? ROLE_NAME[b.role] ?? "players"}`;
  return `At ${m}:00, ${who} (median of ${b.n} games) had ${Math.round(them.cs)} CS, ${them.backs} recall${them.backs === 1 ? "" : "s"} and ${Math.round(them.spent).toLocaleString("en-US")}g spent. You: ${Math.round(you.cs)} CS, ${you.backs} recall${you.backs === 1 ? "" : "s"}, ${Math.round(you.spent).toLocaleString("en-US")}g spent.`;
}

const ROLE_NAME: Partial<Record<Position, string>> = { TOP: "top laners", MIDDLE: "mid laners", BOTTOM: "ADCs", UTILITY: "supports", JUNGLE: "junglers" };
