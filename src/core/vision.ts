/**
 * What you could see versus what was true, from the replay's minimap read twice per
 * moment: once with your team's fog of war, once with fog off.
 */
import { FOUNTAINS } from "./minimap";
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
 *     A ring is only given to a champion who could have got there (see `canReach`): on
 *     NA1_5686076870 at 10:29 elimination gave Heimerdinger's top-lane ring to Master Yi,
 *     last read 9.5 s before 12,000 units away in the bottom lane.
 * Before both, a weak portrait match (score >= WEAK_SCORE) that puts a champion more than
 * JUMP units off their own track gives way to an unnamed ring of their team that fits the
 * track, and its own ring goes back to the unnamed ones. That 10:29 frame had
 * Heimerdinger matched at score 34 in the bottom lane (cover 0.38) while his own ring,
 * 460 units from his read 2 s before, sat unnamed in the top lane.
 * Works through both fog views in time order, and changes `champs` in place.
 */
export function nameRings(champs: ChampSample[], teamOf: (id: number) => number, o: { aliveAt?: (id: number, t: number) => boolean; ids?: number[]; myTeam?: number } = {}): number {
  let named = 0;
  for (const fog of ["off", "team"] as const) {
    const last = new Map<number, { t: number; x: number; y: number }>();
    for (const s of champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t)) {
      // 0a. A weak match its champion couldn't have reached at all (by canReach, from a read
      // in the last REACH_MS) isn't them: the ring goes back to the unnamed ones. At 10:27.5
      // Master Yi was matched at score 35 in the top lane, 14,600 units and 7.5 s from his
      // last read in the bottom lane.
      for (let k = s.at.length - 1; k >= 0; k--) {
        const a = s.at[k];
        const p = last.get(a.id);
        if ((a.score ?? 0) < WEAK_SCORE || !p || s.t - p.t > REACH_MS || canReach(p, a, s.t - p.t, teamOf(a.id))) continue;
        (s.unk ??= []).push({ team: teamOf(a.id) as 100 | 200, x: a.x, y: a.y });
        s.at.splice(k, 1);
      }
      // 0b. A weak match far off its champion's track loses to a ring that fits the track.
      if (s.unk?.length)
        for (const a of s.at) {
          const p = last.get(a.id);
          if ((a.score ?? 0) < WEAK_SCORE || !p || s.t - p.t > TRACK_MS || Math.hypot(a.x - p.x, a.y - p.y) <= JUMP) continue;
          let best = -1;
          let bd = Infinity;
          s.unk.forEach((u, i) => {
            const d = Math.hypot(u.x - p.x, u.y - p.y);
            if (u.team === teamOf(a.id) && d <= walkReach(s.t - p.t) && d < bd) {
              best = i;
              bd = d;
            }
          });
          if (best < 0) continue;
          const u = s.unk[best];
          s.unk[best] = { team: u.team, x: a.x, y: a.y };
          a.x = u.x;
          a.y = u.y;
          delete a.score;
          named++;
        }
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
            if (d <= walkReach(s.t - p.t)) pairs.push({ u: i, id, d });
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
                if (p && !canReach(p, r.u, s.t - p.t, teamOf(id))) continue;
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
      for (const a of s.at) if (!a.inferred) last.set(a.id, { t: s.t, x: a.x, y: a.y });
    }
  }
  return named;
}

/** Portrait match score (mean colour difference) from which a match counts as weak: confident matches score under 20 (the bar for learning icons), and the misread at 10:29 scored 34. */
const WEAK_SCORE = 30;
/** How far off a champion's own track a weak match must be to give way: well past any blink or dash (Flash 400, the longest common dashes ~1000) plus read error. */
const JUMP = 3000;
/** How recent the track must be to judge a jump against it (the same 6 s tracking uses). */
const TRACK_MS = 6000;
/** How far back a read still says where a champion can't be (past this, a recall or teleport could explain anything). */
const REACH_MS = 30_000;
/** Walking reach used by tracking: 500 units a second (faster than any base move speed) plus 600 of slack for the read itself, at most 3500 (a blink or dash on top). */
const walkReach = (dtMs: number) => Math.min(3500, 600 + (dtMs / 1000) * 500);
/** Recall channel (8 s), after which a champion stands in their fountain. */
const RECALL_MS = 8000;

/**
 * Could a champion last read at `p` be at `r` `dtMs` later? Walking (500 units a second plus
 * 600, without the 3500 cap, since elimination can look back further than 6 s); or the ring
 * is in their own fountain (respawn or recall); or there was time to recall and walk from
 * the fountain. Teleport isn't allowed for: a teleported champion stays unnamed until a
 * portrait match or tracking picks them up again.
 */
export function canReach(p: { x: number; y: number }, r: { x: number; y: number }, dtMs: number, teamId: number): boolean {
  if (Math.hypot(r.x - p.x, r.y - p.y) <= 600 + (dtMs / 1000) * 500) return true;
  const f = FOUNTAINS[teamId === 200 ? 1 : 0];
  const fromBase = Math.hypot(r.x - f.x, r.y - f.y);
  if (fromBase <= f.r) return true;
  return dtMs > RECALL_MS && fromBase <= f.r + ((dtMs - RECALL_MS) / 1000) * 500;
}

/**
 * Drops champion reads that can't be true: a read far from both the previous and next
 * reads of that champion, when those two agree with each other (a wrong portrait match,
 * usually a ring on the far side of the map). Champions cover under 500 units a second;
 * 1500 units of slack covers blinks, dashes and the read's own error.
 * Teleports and recalls move a champion once and stay, so they survive.
 * At the end of a run there's no read after to compare (Kayle read in the blue fountain
 * 0.45 s before dying in top lane on NA1_5686039660, her last read: Veigar's icon cut by the
 * minimap corner, read as a second ring). So an out-of-reach read with a read within NEAR_MS
 * on one side and none within UNCONFIRMED_MS on the other is dropped too.
 */
const NEAR_MS = 1500;
const UNCONFIRMED_MS = 3000;
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
      // The ends of a run (no read of that champion for UNCONFIRMED_MS on one side): a read
      // out of reach of a read just before it (or just after it) that nothing confirms. A real
      // teleport or recall leaves the champion visible where they landed.
      const kept = list.filter((r) => !bad.get(r.s)?.has(r.i));
      for (let k = 0; k < kept.length; k++) {
        const c = kept[k];
        for (const [a, b] of [[kept[k - 1], kept[k + 1]], [kept[k + 1], kept[k - 1]]] as const) {
          if (!a || Math.abs(a.s.t - c.s.t) > NEAR_MS) continue;
          if (b && Math.abs(b.s.t - c.s.t) <= UNCONFIRMED_MS) continue;
          const pa = a.s.at[a.i];
          const pc = c.s.at[c.i];
          if (Math.hypot(pc.x - pa.x, pc.y - pa.y) > 1500 + (Math.abs(a.s.t - c.s.t) / 1000) * 500)
            (bad.get(c.s) ?? bad.set(c.s, new Set()).get(c.s)!).add(c.i);
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
 * another one, marked `inferred` so checks and coaching can tell a fill from a read:
 *  - Only short gaps (reads either side at most 6 game seconds apart, within walking
 *    distance), with an icon (either team's) within an icon's width of the spot: interpolated between the two
 *    reads. Held-out reads on a real replay put this at median 94 units, 90% under 302
 *    for 1-2 s gaps, and median 303, 90% under 742 for ~5 s gaps; longer gaps were
 *    worse, hence the 6 s cap.
 *  - In the team view only, longer gaps, up to LONG_GAP_MS, when an icon covers the
 *    straight path in every frame of the gap (stacked under someone the whole time). In the
 *    fog-off view the same rule moved kill-time positions off (Aurelion Sol 332 -> 591 and
 *    90 -> 487 units on NA1_5686076870), so fog-off fills keep the 6 s cap. Against fog-off reads of the
 *    same champion at the same moments (NA1_5686076870, team view): 6-15 s gaps median 308
 *    units, 90% under 651 (11 points, 8 gaps); 15-30 s median 360, 90% under 473 (5 points,
 *    2 gaps). Gaps without full cover were 1600-4700 median off and stay unfilled.
 */
const LONG_GAP_MS = 30_000;

export function fillOcclusions(champs: ChampSample[], ids: number[], aliveAt: (id: number, t: number) => boolean, visibleIn: (id: number, fog: ChampSample["fog"]) => boolean = () => true): number {
  let filled = 0;
  // A covering icon's centre is up to one icon width away (icons are ~24 px, ~1400 units).
  const near = 1400;
  for (const fog of ["off", "team"] as const) {
    const ss = champs.filter((c) => c.fog === fog).sort((a, b) => a.t - b.t);
    const readOf = (s: ChampSample, id: number) => s.at.find((x) => x.id === id && !x.inferred);
    for (const id of ids) {
      if (!visibleIn(id, fog)) continue;
      // Placing a long-stacked champion on the icon over them was measured too: median
      // 600-700 units off at best, worse than interpolation at every gap length. Not used.
      const reads: { k: number; x: number; y: number }[] = [];
      ss.forEach((s, k) => {
        const a = readOf(s, id);
        if (a) reads.push({ k, x: a.x, y: a.y });
      });
      for (let r = 1; r < reads.length; r++) {
        const A = reads[r - 1];
        const B = reads[r];
        if (B.k - A.k < 2) continue;
        const t0 = ss[A.k].t;
        const t1 = ss[B.k].t;
        if (t1 - t0 > (fog === "team" ? LONG_GAP_MS : 6000)) continue;
        if (Math.hypot(B.x - A.x, B.y - A.y) > 1500 + ((t1 - t0) / 1000) * 500) continue;
        const pointAt = (s: ChampSample) => {
          const f = (s.t - t0) / (t1 - t0);
          return { x: Math.round(A.x + (B.x - A.x) * f), y: Math.round(A.y + (B.y - A.y) * f) };
        };
        const covered = (s: ChampSample, p: { x: number; y: number }) => [...s.at, ...(s.unk ?? [])].some((o) => (!("id" in o) || o.id !== id) && Math.hypot(o.x - p.x, o.y - p.y) <= near);
        // Past 6 s, only when an icon covers the straight path in every frame of the gap.
        if (t1 - t0 > 6000 && ss.slice(A.k + 1, B.k).some((s) => aliveAt(id, s.t) && !covered(s, pointAt(s)))) continue;
        for (let k = A.k + 1; k < B.k; k++) {
          const s = ss[k];
          if (!aliveAt(id, s.t)) continue;
          const { x, y } = pointAt(s);
          if (!covered(s, { x, y })) continue;
          s.at.push({ id, x, y, inferred: true });
          filled++;
        }
      }
    }
  }
  return filled;
}
