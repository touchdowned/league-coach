/**
 * What you could see versus what was true, from the replay's minimap read twice per
 * moment: once with your team's fog of war, once with fog off.
 */
import type { Track } from "./track";
import type { ChampSample, WaveTrack } from "./waves";

type Pt = { x: number; y: number };

/** True when the replay was read with your team's fog, so "what you saw" is trustworthy. */
export function hasVision(w: WaveTrack | undefined, myTeam: number): w is WaveTrack & { champs: ChampSample[] } {
  return !!w?.champs?.some((s) => s.fog === "team") && w.viewTeam === myTeam;
}

function nearest(samples: ChampSample[], t: number, fog: ChampSample["fog"], within = 3000): ChampSample | null {
  let best: ChampSample | null = null;
  for (const s of samples) if (s.fog === fog && (!best || Math.abs(s.t - t) < Math.abs(best.t - t))) best = s;
  return best && Math.abs(best.t - t) <= within ? best : null;
}

/** The ids on your minimap at time t, or null if there's no read near t. */
export function visibleAt(w: WaveTrack | undefined, t: number): Set<number> | null {
  const s = w?.champs ? nearest(w.champs, t, "team") : null;
  return s ? new Set(s.at.map((a) => a.id)) : null;
}

/** The last time `id` showed on your minimap before t (looking back up to `within` ms). */
export function lastSeen(w: WaveTrack | undefined, id: number, t: number, within = 120_000): (Pt & { t: number }) | null {
  if (!w?.champs) return null;
  let best: (Pt & { t: number }) | null = null;
  for (const s of w.champs) {
    if (s.fog !== "team" || s.t > t || s.t < t - within) continue;
    const a = s.at.find((x) => x.id === id);
    if (a && (!best || s.t > best.t)) best = { t: s.t, x: a.x, y: a.y };
  }
  return best;
}

/** Where `id` really was near t (fog off). */
export function truthAt(w: WaveTrack | undefined, id: number, t: number): Pt | null {
  const s = w?.champs ? nearest(w.champs, t, "off") : null;
  const a = s?.at.find((x) => x.id === id);
  return a ? { x: a.x, y: a.y } : null;
}

/** Adds every fog-off champion position from the replay to the track, so paths are real, not interpolated. */
export function mergeReplayPositions(track: Track, w: WaveTrack | undefined): Track {
  if (!w?.champs) return track;
  const keys: Track["keys"] = {};
  for (const id in track.keys) keys[id] = [...track.keys[id]];
  for (const s of w.champs) {
    if (s.fog !== "off") continue;
    for (const a of s.at) keys[a.id]?.push({ t: s.t, x: a.x, y: a.y });
  }
  for (const id in keys) keys[id].sort((a, b) => a.t - b.t);
  return { ...track, keys };
}

/**
 * Names rings the portrait matcher couldn't (icons stacked on each other, a portrait
 * dimmed by an ability). A ring of team T is champion X when X is the only one of T's
 * missing champions whose last read, within 6 game seconds, is close enough to have
 * walked there (champions move under 500 units a second; 3500 units allows for blinks).
 * Works through both fog views in time order, and changes `champs` in place.
 */
export function nameRings(champs: ChampSample[], teamOf: (id: number) => number): number {
  let named = 0;
  for (const fog of ["off", "team"] as const) {
    const last = new Map<number, { t: number; x: number; y: number }>();
    for (const s of champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t)) {
      if (s.unk?.length) {
        const present = new Set(s.at.map((a) => a.id));
        const left: typeof s.unk = [];
        // Pair rings with candidates closest first, so two unknowns don't swap.
        const pairs: { u: number; id: number; d: number }[] = [];
        s.unk.forEach((u, i) => {
          for (const [id, p] of last) {
            if (present.has(id) || teamOf(id) !== u.team || s.t - p.t > 6000) continue;
            const d = Math.hypot(p.x - u.x, p.y - u.y);
            if (d <= Math.min(3500, 600 + ((s.t - p.t) / 1000) * 500)) pairs.push({ u: i, id, d });
          }
        });
        pairs.sort((a, b) => a.d - b.d);
        const usedU = new Set<number>();
        for (const p of pairs) {
          if (usedU.has(p.u) || present.has(p.id)) continue;
          // Ambiguous: another candidate nearly as close to the same ring.
          const rival = pairs.find((q) => q.u === p.u && q.id !== p.id && !present.has(q.id) && q.d < p.d + 400);
          if (rival) continue;
          usedU.add(p.u);
          present.add(p.id);
          s.at.push({ id: p.id, x: s.unk[p.u].x, y: s.unk[p.u].y });
          named++;
        }
        s.unk.forEach((u, i) => !usedU.has(i) && left.push(u));
        if (left.length) s.unk = left;
        else delete s.unk;
      }
      for (const a of s.at) last.set(a.id, { t: s.t, x: a.x, y: a.y });
    }
  }
  return named;
}
