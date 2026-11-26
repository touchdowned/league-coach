/**
 * Ward positions. Riot's timeline says who placed a ward and when (WARD_PLACED), never
 * where. The fog-off minimap shows ward icons but not whose. Put together: a ward is
 * where a new icon of the placer's team appears within 3 s of the event, nearest the
 * placer (and within 1200 units of them: wards are placed at most ~600 away).
 *
 * A ward dropped next to the placer is usually drawn under the placer's own portrait, and
 * portraits are masked when wards are read, so its icon only shows once they walk off.
 * On NA1_5686076870, 27 of 36 wards the 3 s rule missed had a new icon of the team appear
 * 3-30 s later within 1200 units of where the placer stood. So an icon that appears later
 * (up to HIDDEN_MS) still counts, but only if it could have been hidden all along: at least
 * UNDER_SHARE of the fog-off reads in between have a champion within UNDER_ICON of the spot.
 */
import type { TimelineEvent } from "./types";
import type { ChampSample, WaveSample } from "./waves";

export interface PlacedWard {
  t: number;
  creatorId: number;
  wardType: string;
  x: number;
  y: number;
  /** The icon it was matched to, when the scan told icons apart (see findWardIcons). */
  icon?: string;
}

/**
 * A control ward icon only counts once it has stayed put: on NA1_5686039660's frame dumps the
 * real ones were found in every frame they were up, anything else that fit the eye in a single
 * frame. CONTROL_HOLD samples (3 s at 2 a second) within CONTROL_WINDOW of each other.
 */
const CONTROL_HOLD = 6;
const CONTROL_WINDOW = 5000;
type Icon = { team: 100 | 200; x: number; y: number; kind?: string };
function steadyControls<T extends { t: number; wards?: Icon[] }>(s: T[]): T[] {
  return s.map((x, i) => {
    const wards = x.wards!.filter((w) => {
      if (w.kind !== "control") return true;
      let n = 0;
      for (let j = i; j >= 0 && x.t - s[j].t <= CONTROL_WINDOW; j--) if (s[j].wards!.some((v) => v.kind === "control" && v.team === w.team && Math.hypot(v.x - w.x, v.y - w.y) < SAME_SPOT)) n++;
      for (let j = i + 1; j < s.length && s[j].t - x.t <= CONTROL_WINDOW; j++) if (s[j].wards!.some((v) => v.kind === "control" && v.team === w.team && Math.hypot(v.x - w.x, v.y - w.y) < SAME_SPOT)) n++;
      return n >= CONTROL_HOLD;
    });
    return { ...x, wards };
  });
}

const SAME_SPOT = 350;
const SHOWN_MS = 3000;
const HIDDEN_MS = 30_000;
/**
 * A portrait's radius (12.5 px on a 247 px minimap, ~725 units), the 2 px mask margin and
 * half a star (~6 px): an icon this close to a champion read can be fully under it.
 */
const UNDER_ICON = 1300;
/** Share of the reads in between that must have a champion on the spot (a read can miss). */
const UNDER_SHARE = 0.85;
/**
 * A spot an earlier ward took frees up once that ward is gone: its icon missing for this long
 * in a row (longer than a champion standing on it for a moment), or its lifetime over:
 * trinket wards last 90-120 s by level, sight wards 150 s; control wards until killed.
 */
const GONE_MS = 3000;
const LIFETIME: Record<string, number> = { YELLOW_TRINKET: 120_000, SIGHT_WARD: 150_000 };

export function placeWards(samples: WaveSample[], champs: ChampSample[], events: TimelineEvent[], teamOf: (id: number) => number, until: number) {
  const s = steadyControls([...samples].filter((x) => x.wards).sort((a, b) => a.t - b.t));
  // With ward kinds read, a control ward event only takes an eye icon and a stealth ward event
  // only a star. Scans from before kinds have none: then any icon will do.
  const kinds = s.some((x) => x.wards!.some((w) => w.kind));
  const fits = (w: Icon, type: string | undefined) => !kinds || (type === "CONTROL_WARD" ? w.kind === "control" : w.kind !== "control");
  const off = champs.filter((c) => c.fog === "off");
  const placed: PlacedWard[] = [];
  const unplaced: TimelineEvent[] = [];
  // Spots taken by placed wards, and when their icon was matched.
  const used = new Map<string, { x: number; y: number; team: number; t: number; type: string }>();
  const stillThere = (u: { x: number; y: number; team: number; t: number; type: string }, t: number) => {
    if (t - u.t > (LIFETIME[u.type] ?? Infinity)) return false;
    let goneSince: number | null = null;
    for (const x of s) {
      if (x.t <= u.t) continue;
      if (x.t >= t) break;
      const seen = x.wards!.some((w) => w.team === u.team && Math.hypot(w.x - u.x, w.y - u.y) < SAME_SPOT);
      if (seen) goneSince = null;
      else if (goneSince === null) goneSince = x.t;
      else if (x.t - goneSince >= GONE_MS) return false;
    }
    return true;
  };
  const wards = events.filter((e) => e.type === "WARD_PLACED" && e.creatorId && e.wardType !== "UNDEFINED" && e.timestamp <= until && e.timestamp >= (s[0]?.t ?? Infinity));
  for (const e of wards) {
    const team = teamOf(e.creatorId!);
    // Where the placer was.
    let at: { x: number; y: number } | null = null;
    let dt = Infinity;
    for (const c of off) {
      const r = c.at.find((a) => a.id === e.creatorId);
      if (r && Math.abs(c.t - e.timestamp) < dt && Math.abs(c.t - e.timestamp) <= 2000) {
        dt = Math.abs(c.t - e.timestamp);
        at = r;
      }
    }
    if (!at) {
      unplaced.push(e);
      continue;
    }
    // Icons there before the event aren't this ward.
    const before = s.filter((x) => x.t >= e.timestamp - 4000 && x.t <= e.timestamp - 500).flatMap((x) => x.wards!.filter((w) => w.team === team && fits(w, e.wardType)));
    let best: { x: number; y: number; d: number; key: string; t: number; kind?: string } | null = null;
    // Hidden under a portrait from the event until `t`: nearly every fog-off read in between
    // has a champion on the spot.
    const hiddenUntil = (w: { x: number; y: number }, t: number) => {
      const mid = off.filter((c) => c.t >= e.timestamp && c.t < t);
      const on = mid.filter((c) => c.at.some((a) => Math.hypot(a.x - w.x, a.y - w.y) <= UNDER_ICON)).length;
      return mid.length > 0 && on >= mid.length * UNDER_SHARE;
    };
    for (const x of s) {
      if (x.t < e.timestamp || x.t > e.timestamp + HIDDEN_MS) continue;
      // Icons seen within 3 s all compete on distance; a later one only when none has.
      if (best && x.t > e.timestamp + SHOWN_MS) break;
      for (const w of x.wards!) {
        if (w.team !== team || !fits(w, e.wardType)) continue;
        if (before.some((b) => Math.hypot(b.x - w.x, b.y - w.y) < SAME_SPOT)) continue;
        const key = `${Math.round(w.x / SAME_SPOT)}:${Math.round(w.y / SAME_SPOT)}:${team}`;
        const prev = used.get(key);
        if (prev && stillThere(prev, e.timestamp)) continue;
        const d = Math.hypot(w.x - at.x, w.y - at.y);
        if (d > 1200 || (best && d >= best.d)) continue;
        if (x.t > e.timestamp + SHOWN_MS && !hiddenUntil(w, x.t)) continue;
        best = { x: w.x, y: w.y, d, key, t: x.t, kind: w.kind };
      }
    }
    if (!best) {
      unplaced.push(e);
      continue;
    }
    used.set(best.key, { x: best.x, y: best.y, team, t: best.t, type: e.wardType ?? "" });
    placed.push({ t: e.timestamp, creatorId: e.creatorId!, wardType: e.wardType ?? "", x: best.x, y: best.y, ...(best.kind ? { icon: best.kind } : {}) });
  }
  return { placed, unplaced, total: wards.length };
}

export function checkWards(r: ReturnType<typeof placeWards>) {
  const pct = r.total ? Math.round((r.placed.length / r.total) * 1000) / 10 : 0;
  const byType: Record<string, [number, number]> = {};
  for (const p of r.placed) (byType[p.wardType] ??= [0, 0])[0]++;
  for (const u of r.unplaced) (byType[u.wardType ?? ""] ??= [0, 0])[1]++;
  // Which icon kind each placed ward was matched to (scans that read kinds only).
  const icons: Record<string, Record<string, number>> = {};
  for (const p of r.placed) if (p.icon) (icons[p.wardType] ??= {})[p.icon] = ((icons[p.wardType] ??= {})[p.icon] ?? 0) + 1;
  return {
    name: "wards: WARD_PLACED events given a position",
    measured: `${pct}% (${r.placed.length}/${r.total}); by type placed/unplaced: ${Object.entries(byType).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", ")}${Object.keys(icons).length ? `; icon matched by type: ${Object.entries(icons).map(([k, v]) => `${k} ${Object.entries(v).map(([i, n]) => `${i} ${n}`).join("+")}`).join(", ")}` : ""}`,
    bar: ">= 85% get a position",
    pass: r.total > 0 && r.placed.length / r.total >= 0.85,
    n: r.total,
    detail: { unplaced: r.unplaced.map((e) => ({ t: e.timestamp, creatorId: e.creatorId, wardType: e.wardType })) },
  };
}
