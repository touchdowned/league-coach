/**
 * Ward positions. Riot's timeline says who placed a ward and when (WARD_PLACED), never
 * where. The fog-off minimap shows ward icons but not whose. Put together: a ward is
 * where a new icon of the placer's team appears within 3 s of the event, nearest the
 * placer (and within 1200 units of them: wards are placed at most ~600 away).
 */
import type { TimelineEvent } from "./types";
import type { ChampSample, WaveSample } from "./waves";

export interface PlacedWard {
  t: number;
  creatorId: number;
  wardType: string;
  x: number;
  y: number;
}

const SAME_SPOT = 350;

export function placeWards(samples: WaveSample[], champs: ChampSample[], events: TimelineEvent[], teamOf: (id: number) => number, until: number) {
  const s = [...samples].filter((x) => x.wards).sort((a, b) => a.t - b.t);
  const off = champs.filter((c) => c.fog === "off");
  const placed: PlacedWard[] = [];
  const unplaced: TimelineEvent[] = [];
  const used = new Set<string>();
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
    const before = s.filter((x) => x.t >= e.timestamp - 4000 && x.t <= e.timestamp - 500).flatMap((x) => x.wards!.filter((w) => w.team === team));
    let best: { x: number; y: number; d: number; key: string } | null = null;
    for (const x of s) {
      if (x.t < e.timestamp || x.t > e.timestamp + 3000) continue;
      for (const w of x.wards!) {
        if (w.team !== team) continue;
        if (before.some((b) => Math.hypot(b.x - w.x, b.y - w.y) < SAME_SPOT)) continue;
        const key = `${Math.round(w.x / SAME_SPOT)}:${Math.round(w.y / SAME_SPOT)}:${team}`;
        if (used.has(key)) continue;
        const d = Math.hypot(w.x - at.x, w.y - at.y);
        if (d <= 1200 && (!best || d < best.d)) best = { x: w.x, y: w.y, d, key };
      }
    }
    if (!best) {
      unplaced.push(e);
      continue;
    }
    used.add(best.key);
    placed.push({ t: e.timestamp, creatorId: e.creatorId!, wardType: e.wardType ?? "", x: best.x, y: best.y });
  }
  return { placed, unplaced, total: wards.length };
}

export function checkWards(r: ReturnType<typeof placeWards>) {
  const pct = r.total ? Math.round((r.placed.length / r.total) * 1000) / 10 : 0;
  const byType: Record<string, [number, number]> = {};
  for (const p of r.placed) (byType[p.wardType] ??= [0, 0])[0]++;
  for (const u of r.unplaced) (byType[u.wardType ?? ""] ??= [0, 0])[1]++;
  return {
    name: "wards: WARD_PLACED events given a position",
    measured: `${pct}% (${r.placed.length}/${r.total}); by type placed/unplaced: ${Object.entries(byType).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", ")}`,
    bar: ">= 85% get a position",
    pass: r.total > 0 && r.placed.length / r.total >= 0.85,
    n: r.total,
    detail: { unplaced: r.unplaced.map((e) => ({ t: e.timestamp, creatorId: e.creatorId, wardType: e.wardType })) },
  };
}
