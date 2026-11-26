/**
 * Game rules the engine does arithmetic with, for the 2026 season (patch 26.x; Riot's API
 * calls it 16.x). Each number says where it comes from. The ones the scan can observe are
 * checked against it (see `checkWaveSchedule` in tempo.ts); the rest are from patch-note trackers and
 * guides checked against patches 26.21 to 26.23 (riftpatchnotes.com/lol/system/minions,
 * senseos.gg minion-waves guide, boostpirate.com and neuralboost.gg objective timers).
 */

/** First wave spawns at 0:30 (26.1; it was 1:05 before). */
export const FIRST_WAVE_MS = 30_000;
/** Waves come every 30 s until 14:00, every 25 s until 30:00, then every 20 s (26.1). */
export function waveInterval(tMs: number): number {
  return tMs < 14 * 60_000 ? 30_000 : tMs < 30 * 60_000 ? 25_000 : 20_000;
}

export interface WaveSpawn {
  /** 1-based. */
  index: number;
  t: number;
  melee: number;
  caster: number;
  cannon: number;
}

/**
 * Every wave spawned up to `until`. A cannon comes with wave 3 and every third wave after
 * (26.1 moved the first cannon from wave 4 to wave 3). From 14:00 a cannon wave has one
 * melee fewer, from 30:00 one caster fewer too. The later cadence (every second wave, then
 * every wave) is in older sources only with pre-2026 times; the scan covers the laning
 * phase, where every third wave holds, and `checkWaveSchedule` measures it.
 */
export function waveSpawns(until: number): WaveSpawn[] {
  const out: WaveSpawn[] = [];
  let t = FIRST_WAVE_MS;
  for (let i = 1; t <= until; i++) {
    const cannon = i % 3 === 0 ? 1 : 0;
    out.push({ index: i, t, melee: 3 - (cannon && t >= 14 * 60_000 ? 1 : 0), caster: 3 - (cannon && t >= 30 * 60_000 ? 1 : 0), cannon });
    t += waveInterval(t);
  }
  return out;
}

/** Gold for the last hit: melee 20, caster 14, cannon 50 plus 1 per 90 s of game time. */
export const MINION_GOLD = { melee: 20, caster: 14, cannon: (tMs: number) => 50 + Math.floor(tMs / 90_000) };
/** Experience: melee 62, caster 31, cannon 75, to champions within 1500 units. */
export const MINION_XP = { melee: 62, caster: 31, cannon: 75 };
export const XP_RANGE = 1500;

export function waveGold(w: WaveSpawn): number {
  return w.melee * MINION_GOLD.melee + w.caster * MINION_GOLD.caster + w.cannon * MINION_GOLD.cannon(w.t);
}
export function waveXp(w: WaveSpawn): number {
  return w.melee * MINION_XP.melee + w.caster * MINION_XP.caster + w.cannon * MINION_XP.cannon;
}
export const waveSize = (w: WaveSpawn) => w.melee + w.caster + w.cannon;

/** Recall channels for 8 s (4 s with Hand of Baron, which lasts 180 s after the kill). */
export const RECALL_MS = 8000;
export const EMPOWERED_RECALL_MS = 4000;
export const BARON_BUFF_MS = 180_000;

/**
 * Epic monsters: first spawn and respawn after a kill (ms). 2026: Baron at 20:00, Atakhan
 * removed, Voidgrubs once at 8:00 (gone at 14:45), Herald once at 15:00 (gone at 19:45).
 * Dragon respawns 5:00 after each kill until a team has four, then Elder 6:00 later.
 */
export const OBJECTIVES = {
  DRAGON: { first: 5 * 60_000, respawn: 5 * 60_000 },
  HORDE: { first: 8 * 60_000, respawn: null as number | null, leaves: 14 * 60_000 + 45_000 },
  RIFTHERALD: { first: 15 * 60_000, respawn: null as number | null, leaves: 19 * 60_000 + 45_000 },
  BARON_NASHOR: { first: 20 * 60_000, respawn: 6 * 60_000 },
  ELDER_DRAGON: { afterFourth: 6 * 60_000, respawn: 6 * 60_000 },
} as const;

export interface ObjectiveWindow {
  type: "DRAGON" | "HORDE" | "RIFTHERALD" | "BARON_NASHOR";
  /** When it came up. */
  spawn: number;
  /** When it was killed (Voidgrubs: the first of the three), and by which team; null if it wasn't during the game. */
  taken: number | null;
  by: number | null;
}

/** Where each epic monster sits (game units). */
export const PITS = { DRAGON: { x: 9866, y: 4414 }, HORDE: { x: 5007, y: 10471 }, RIFTHERALD: { x: 5007, y: 10471 }, BARON_NASHOR: { x: 5007, y: 10471 } } as const;

/**
 * Every epic monster spawn up to `until`, with who took it. Spawn times follow from the
 * rules above and the kills in the timeline (a dragon is up 5:00 after the last one died).
 */
export function objectiveWindows(events: { type: string; timestamp: number; monsterType?: string; killerTeamId?: number }[], until: number): ObjectiveWindow[] {
  const kills = events.filter((e) => e.type === "ELITE_MONSTER_KILL").sort((a, b) => a.timestamp - b.timestamp);
  const out: ObjectiveWindow[] = [];
  const chain = (type: ObjectiveWindow["type"], first: number, respawn: number | null, leaves?: number) => {
    let spawn = first;
    const ks = kills.filter((k) => k.monsterType === type);
    let i = 0;
    while (spawn <= until) {
      while (i < ks.length && ks[i].timestamp < spawn) i++;
      const k = ks[i];
      const gone = k && (leaves === undefined || k.timestamp <= leaves) ? k : undefined;
      out.push({ type, spawn, taken: gone ? gone.timestamp : null, by: gone ? (gone.killerTeamId ?? null) : null });
      if (!gone || respawn === null) break;
      spawn = gone.timestamp + respawn;
      i++;
    }
  };
  chain("DRAGON", OBJECTIVES.DRAGON.first, OBJECTIVES.DRAGON.respawn);
  chain("HORDE", OBJECTIVES.HORDE.first, null, OBJECTIVES.HORDE.leaves);
  chain("RIFTHERALD", OBJECTIVES.RIFTHERALD.first, null, OBJECTIVES.RIFTHERALD.leaves);
  chain("BARON_NASHOR", OBJECTIVES.BARON_NASHOR.first, OBJECTIVES.BARON_NASHOR.respawn);
  return out.sort((a, b) => a.spawn - b.spawn);
}

/**
 * Jungle camps first spawn at 0:55 (buffs, wolves, raptors) and 1:07 (gromp, krugs); the
 * scuttle crabs at 2:55. A full six-camp first clear from 0:55 ends between about 2:50 and
 * 3:20 depending on the champion, so the first gank or scuttle fight falls in
 * FIRST_GANK_WINDOW. With the old 1:30 camp spawn the same window was the "3:15 to 3:45"
 * everyone quotes; the 35 s earlier start moves it.
 */
export const FIRST_GANK_WINDOW = { from: 2 * 60_000 + 40_000, to: 3 * 60_000 + 20_000 };
