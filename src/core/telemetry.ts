/**
 * Module 1 telemetry: what a replay pass records, and the checks that decide whether
 * a stream is good enough for the game-state engine to use.
 *
 * Streams (all times are game ms from the Replay API clock):
 *  - pos / lane: minimap reads (see minimap.ts, waves.ts), kept in WaveTrack.
 *  - inv: Live Client Data polled while the replay plays. Each poll is the full state
 *    of every player at the replay's current time; we keep only changes, stamped at the
 *    midpoint between the two polls that bracket them.
 */
import type { TimelineDto, TimelineEvent } from "./types";
import type { ChampSample, WaveTrack } from "./waves";

/** The slice of /liveclientdata/allgamedata we keep, per player. */
export interface LivePlayer {
  championName: string;
  team: "ORDER" | "CHAOS" | string;
  level: number;
  items: number[];
  cs: number;
  kills: number;
  deaths: number;
  assists: number;
  wardScore: number;
  isDead: boolean;
  respawnTimer: number;
}

export interface LivePoll {
  /** Replay clock (gameData.gameTime), ms. */
  t: number;
  players: LivePlayer[];
}

export type InvChange =
  | { t: number; window: number; champion: string; kind: "item+"; item: number }
  | { t: number; window: number; champion: string; kind: "item-"; item: number }
  | { t: number; window: number; champion: string; kind: "level"; value: number }
  | { t: number; window: number; champion: string; kind: "cs"; value: number; delta: number }
  | { t: number; window: number; champion: string; kind: "death" | "respawn" };

/** Parses one allgamedata response. Null when it isn't one. */
export function parseLive(raw: unknown): LivePoll | null {
  const d = raw as { gameData?: { gameTime?: number }; allPlayers?: Record<string, unknown>[] } | null;
  if (!d?.gameData || typeof d.gameData.gameTime !== "number" || !Array.isArray(d.allPlayers)) return null;
  const players = d.allPlayers.map((p) => {
    const sc = (p.scores ?? {}) as Record<string, number>;
    const items = Array.isArray(p.items) ? (p.items as { itemID?: number }[]).map((i) => i.itemID ?? 0).filter((x) => x > 0) : [];
    return {
      championName: String(p.championName ?? ""),
      team: String(p.team ?? ""),
      level: Number(p.level ?? 0),
      items,
      cs: Number(sc.creepScore ?? 0),
      kills: Number(sc.kills ?? 0),
      deaths: Number(sc.deaths ?? 0),
      assists: Number(sc.assists ?? 0),
      wardScore: Number(sc.wardScore ?? 0),
      isDead: !!p.isDead,
      respawnTimer: Number(p.respawnTimer ?? 0),
    };
  });
  return { t: Math.round(d.gameData.gameTime * 1000), players };
}

const multiset = (xs: number[]) => {
  const m = new Map<number, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Changes between consecutive polls (sorted by time; polls that go backwards are skipped). */
export function invChanges(polls: LivePoll[]): InvChange[] {
  const out: InvChange[] = [];
  const sorted = [...polls].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.t <= a.t) continue;
    const t = Math.round((a.t + b.t) / 2);
    const window = b.t - a.t;
    for (const pb of b.players) {
      const pa = a.players.find((x) => x.championName === pb.championName && x.team === pb.team);
      if (!pa) continue;
      const c = pb.championName;
      const ma = multiset(pa.items);
      const mb = multiset(pb.items);
      for (const [id, n] of mb) for (let k = ma.get(id) ?? 0; k < n; k++) out.push({ t, window, champion: c, kind: "item+", item: id });
      for (const [id, n] of ma) for (let k = mb.get(id) ?? 0; k < n; k++) out.push({ t, window, champion: c, kind: "item-", item: id });
      if (pb.level !== pa.level) out.push({ t, window, champion: c, kind: "level", value: pb.level });
      if (pb.cs !== pa.cs) out.push({ t, window, champion: c, kind: "cs", value: pb.cs, delta: pb.cs - pa.cs });
      if (pb.isDead && !pa.isDead) out.push({ t, window, champion: c, kind: "death" });
      if (!pb.isDead && pa.isDead) out.push({ t, window, champion: c, kind: "respawn" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification

export interface StreamCheck {
  name: string;
  measured: string;
  bar: string;
  pass: boolean;
  n: number;
  detail?: unknown;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

function nearest(samples: ChampSample[], t: number, fog: ChampSample["fog"], within: number): ChampSample | null {
  let best: ChampSample | null = null;
  for (const s of samples) if (s.fog === fog && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  return best && Math.abs(best.t - t) <= within ? best : null;
}

/**
 * Checks the minimap champion reads against every kill's exact victim position.
 * A victim is still standing on the kill spot in the last sample before the event.
 */
export function checkPositions(w: WaveTrack, events: TimelineEvent[], until: number): StreamCheck {
  const errs: { t: number; victim: number; err: number }[] = [];
  let missing = 0;
  const kills = events.filter((e) => e.type === "CHAMPION_KILL" && e.position && e.victimId && e.timestamp <= until);
  for (const k of kills) {
    const s = nearest(w.champs ?? [], k.timestamp - 700, "off", 1500);
    const a = s?.at.find((x) => x.id === k.victimId);
    if (!a) {
      missing++;
      continue;
    }
    errs.push({ t: k.timestamp, victim: k.victimId!, err: Math.round(Math.hypot(a.x - k.position!.x, a.y - k.position!.y)) });
  }
  const e = errs.map((x) => x.err);
  const med = median(e);
  const p90 = quantile(e, 0.9);
  return {
    name: "pos: victim at each kill (fog off)",
    measured: errs.length ? `median ${med} units, 90th pct ${p90} units, ${missing} of ${kills.length} kills with no read` : `no reads (${kills.length} kills)`,
    bar: "median < 400, 90% < 800",
    pass: errs.length >= Math.max(3, kills.length * 0.7) && med < 400 && p90 < 800,
    n: kills.length,
    detail: errs,
  };
}

/** Your allies must be on your own minimap in every team-fog sample. */
export function checkAllies(w: WaveTrack, allyIds: number[], aliveAt: (id: number, t: number) => boolean): StreamCheck {
  let seen = 0;
  let total = 0;
  for (const s of (w.champs ?? []).filter((x) => x.fog === "team")) {
    for (const id of allyIds) {
      if (!aliveAt(id, s.t)) continue;
      total++;
      if (s.at.some((a) => a.id === id)) seen++;
    }
  }
  return { name: "pos: allies shown in team-fog samples", measured: `${pct(seen, total)}% (${seen}/${total})`, bar: ">= 98%", pass: total > 0 && seen / total >= 0.98, n: total };
}

/** Every ITEM_PURCHASED in the timeline should show up in the Live Client stream within a second. */
export function checkItems(changes: InvChange[], events: TimelineEvent[], champOf: (id: number) => string, until: number): StreamCheck {
  const buys = events.filter((e) => e.type === "ITEM_PURCHASED" && e.itemId && e.participantId && e.timestamp <= until);
  const used = new Set<InvChange>();
  const offsets: number[] = [];
  let matched = 0;
  for (const b of buys) {
    const champ = champOf(b.participantId!);
    let best: InvChange | null = null;
    for (const c of changes) {
      if (c.kind !== "item+" || c.champion !== champ || c.item !== b.itemId || used.has(c)) continue;
      if (Math.abs(c.t - b.timestamp) > 3000) continue;
      if (!best || Math.abs(c.t - b.timestamp) < Math.abs(best.t - b.timestamp)) best = c;
    }
    if (best) {
      used.add(best);
      matched++;
      offsets.push(Math.abs(best.t - b.timestamp));
    }
  }
  const p90 = quantile(offsets, 0.9);
  return {
    name: "inv: item buys vs ITEM_PURCHASED",
    measured: `${pct(matched, buys.length)}% matched (${matched}/${buys.length}), 90th pct offset ${isNaN(p90) ? "-" : `${p90} ms`}`,
    bar: "100% matched within 1 game s",
    pass: buys.length > 0 && matched / buys.length >= 0.95 && p90 <= 1000,
    n: buys.length,
  };
}

/** Level-ups in the Live Client stream vs the timeline's LEVEL_UP events. */
export function checkLevels(changes: InvChange[], events: TimelineEvent[], champOf: (id: number) => string, until: number): StreamCheck {
  const ups = events.filter((e) => e.type === "LEVEL_UP" && e.participantId && e.timestamp <= until && e.timestamp > 5000);
  let matched = 0;
  const offsets: number[] = [];
  for (const u of ups) {
    const c = changes.find((x) => x.kind === "level" && x.champion === champOf(u.participantId!) && Math.abs(x.t - u.timestamp) <= 3000);
    if (c) {
      matched++;
      offsets.push(Math.abs(c.t - u.timestamp));
    }
  }
  return { name: "inv: level-ups vs LEVEL_UP", measured: `${pct(matched, ups.length)}% (${matched}/${ups.length}), median offset ${median(offsets)} ms`, bar: ">= 95% within 1 game s", pass: ups.length > 0 && matched / ups.length >= 0.95, n: ups.length };
}

/** CS from Live Client vs the timeline's per-minute minion + jungle counts. */
export function checkCs(polls: LivePoll[], timeline: TimelineDto, champOf: (id: number) => string, until: number): StreamCheck {
  const diffs: number[] = [];
  for (const f of timeline.info.frames) {
    if (f.timestamp <= 0 || f.timestamp > until) continue;
    let best: LivePoll | null = null;
    for (const p of polls) if (!best || Math.abs(p.t - f.timestamp) < Math.abs(best.t - f.timestamp)) best = p;
    if (!best || Math.abs(best.t - f.timestamp) > 1500) continue;
    for (const id in f.participantFrames) {
      const pf = f.participantFrames[id];
      const lp = best.players.find((x) => x.championName === champOf(Number(id)));
      if (lp) diffs.push(Math.abs(lp.cs - (pf.minionsKilled + pf.jungleMinionsKilled)));
    }
  }
  const within = diffs.filter((d) => d <= 2).length;
  return { name: "inv: CS vs timeline frames", measured: `${pct(within, diffs.length)}% within 2 CS (${diffs.length} checks), max off ${diffs.length ? Math.max(...diffs) : "-"}`, bar: ">= 95% within 2 CS", pass: diffs.length > 0 && within / diffs.length >= 0.95, n: diffs.length };
}
