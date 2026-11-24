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
 * dimmed by an ability), in two ways:
 *  1. Tracking: a ring of team T is champion X when X is the only one of T's missing
 *     champions whose last read, within 6 game seconds, is close enough to have walked
 *     there (under 500 units a second; up to 3500 units allows for blinks).
 *  2. Elimination: every living champion is on the minimap with fog off, and every
 *     living ally is with your team's fog. So when a frame has exactly as many unnamed
 *     rings of a team as it has living champions of that team missing, they pair up,
 *     nearest last read first. `aliveAt` (from Live Client's isDead) says who's living.
 * Works through both fog views in time order, and changes `champs` in place.
 */
export function nameRings(champs: ChampSample[], teamOf: (id: number) => number, o: { aliveAt?: (id: number, t: number) => boolean; ids?: number[]; myTeam?: number } = {}): number {
  let named = 0;
  for (const fog of ["off", "team"] as const) {
    const last = new Map<number, { t: number; x: number; y: number }>();
    for (const s of champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t)) {
      if (s.unk?.length) {
        const present = new Set(s.at.map((a) => a.id));
        const usedU = new Set<number>();
        const take = (u: number, id: number) => {
          usedU.add(u);
          present.add(id);
          s.at.push({ id, x: s.unk![u].x, y: s.unk![u].y });
          named++;
        };
        // 1. Tracking. Pair rings with candidates closest first, so two unknowns don't swap.
        const pairs: { u: number; id: number; d: number }[] = [];
        s.unk.forEach((u, i) => {
          for (const [id, p] of last) {
            if (present.has(id) || teamOf(id) !== u.team || s.t - p.t > 6000) continue;
            const d = Math.hypot(p.x - u.x, p.y - u.y);
            if (d <= Math.min(3500, 600 + ((s.t - p.t) / 1000) * 500)) pairs.push({ u: i, id, d });
          }
        });
        pairs.sort((a, b) => a.d - b.d);
        for (const p of pairs) {
          if (usedU.has(p.u) || present.has(p.id)) continue;
          // Ambiguous: another candidate nearly as close to the same ring.
          const rival = pairs.find((q) => q.u === p.u && q.id !== p.id && !present.has(q.id) && q.d < p.d + 400);
          if (rival) continue;
          take(p.u, p.id);
        }
        // 2. Elimination.
        if (o.aliveAt && o.ids) {
          for (const team of [100, 200]) {
            if (fog === "team" && team !== o.myTeam) continue;
            const rings = s.unk.map((u, i) => ({ u, i })).filter((x) => x.u.team === team && !usedU.has(x.i));
            const missing = o.ids.filter((id) => teamOf(id) === team && !present.has(id) && o.aliveAt!(id, s.t));
            if (!rings.length || rings.length !== missing.length) continue;
            const cand: { u: number; id: number; d: number }[] = [];
            for (const r of rings)
              for (const id of missing) {
                const p = last.get(id);
                cand.push({ u: r.i, id, d: p ? Math.hypot(p.x - r.u.x, p.y - r.u.y) : 1e9 });
              }
            cand.sort((a, b) => a.d - b.d);
            for (const c of cand) if (!usedU.has(c.u) && !present.has(c.id)) take(c.u, c.id);
          }
        }
        const left = s.unk.filter((_, i) => !usedU.has(i));
        if (left.length) s.unk = left;
        else delete s.unk;
      }
      for (const a of s.at) last.set(a.id, { t: s.t, x: a.x, y: a.y });
    }
  }
  return named;
}

/**
 * Drops champion reads that can't be true: a read far from both the previous and next
 * reads of that champion, when those two agree with each other (a wrong portrait match,
 * usually a ring on the far side of the map). Champions cover under 500 units a second;
 * 1500 units of slack covers blinks, dashes and the read's own error.
 * Teleports and recalls move a champion once and stay, so they survive.
 */
export function dropJumps(champs: ChampSample[]): number {
  let dropped = 0;
  for (const fog of ["off", "team"] as const) {
    const ss = champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t);
    const reads = new Map<number, { s: ChampSample; i: number }[]>();
    for (const s of ss) s.at.forEach((a, i) => (reads.get(a.id) ?? reads.set(a.id, []).get(a.id)!).push({ s, i }));
    const bad = new Map<ChampSample, Set<number>>();
    for (const list of reads.values()) {
      for (let k = 1; k < list.length - 1; k++) {
        const p = list[k - 1].s.at[list[k - 1].i];
        const c = list[k].s.at[list[k].i];
        const n = list[k + 1].s.at[list[k + 1].i];
        const reach = (a: ChampSample, b: ChampSample) => 1500 + (Math.abs(b.t - a.t) / 1000) * 500;
        const dp = Math.hypot(c.x - p.x, c.y - p.y);
        const dn = Math.hypot(c.x - n.x, c.y - n.y);
        const pn = Math.hypot(p.x - n.x, p.y - n.y);
        if (dp > reach(list[k - 1].s, list[k].s) && dn > reach(list[k].s, list[k + 1].s) && pn <= reach(list[k - 1].s, list[k + 1].s)) {
          (bad.get(list[k].s) ?? bad.set(list[k].s, new Set()).get(list[k].s)!).add(list[k].i);
        }
      }
    }
    for (const [s, idx] of bad) {
      s.at = s.at.filter((_, i) => !idx.has(i));
      dropped += idx.size;
    }
  }
  return dropped;
}

/**
 * Fills in a living champion who's missing from a frame because their icon is under
 * another one. The fill is only made when all of these hold:
 *  - they have a read before and after, at most 12 game seconds apart;
 *  - those two reads are within walking distance of each other;
 *  - an icon sits within 700 units of where they'd be (the icon covering them).
 * Their position is interpolated between the two reads and marked `inferred`, so checks
 * and coaching can tell a fill from a read.
 */
export function fillOcclusions(champs: ChampSample[], ids: number[], aliveAt: (id: number, t: number) => boolean, visibleIn: (id: number, fog: ChampSample["fog"]) => boolean = () => true): number {
  let filled = 0;
  for (const fog of ["off", "team"] as const) {
    const ss = champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t);
    for (const id of ids) {
      if (!visibleIn(id, fog)) continue;
      const reads: { k: number; x: number; y: number }[] = [];
      ss.forEach((s, k) => {
        const a = s.at.find((x) => x.id === id && !x.inferred);
        if (a) reads.push({ k, x: a.x, y: a.y });
      });
      for (let r = 1; r < reads.length; r++) {
        const A = reads[r - 1];
        const B = reads[r];
        if (B.k - A.k < 2) continue;
        const t0 = ss[A.k].t;
        const t1 = ss[B.k].t;
        if (t1 - t0 > 12_000) continue;
        if (Math.hypot(B.x - A.x, B.y - A.y) > 1500 + ((t1 - t0) / 1000) * 500) continue;
        for (let k = A.k + 1; k < B.k; k++) {
          const s = ss[k];
          if (!aliveAt(id, s.t)) continue;
          const f = (s.t - t0) / (t1 - t0);
          const x = Math.round(A.x + (B.x - A.x) * f);
          const y = Math.round(A.y + (B.y - A.y) * f);
          const cover = [...s.at, ...(s.unk ?? [])].some((o) => (!("id" in o) || o.id !== id) && Math.hypot(o.x - x, o.y - y) <= 700);
          if (!cover) continue;
          s.at.push({ id, x, y, inferred: true });
          filled++;
        }
      }
    }
  }
  return filled;
}
