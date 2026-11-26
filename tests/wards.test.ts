import { describe, expect, it } from "vitest";
import { placeWards } from "../src/core/wards";
import type { TimelineEvent } from "../src/core/types";
import type { ChampSample, WaveSample } from "../src/core/waves";

const lanes = { TOP: { b: [], r: [] }, MIDDLE: { b: [], r: [] }, BOTTOM: { b: [], r: [] } };

describe("ward positions", () => {
  it("puts a WARD_PLACED at the new icon near the placer, not at an old one", () => {
    const samples: WaveSample[] = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500].map((t) => ({
      t: 60_000 + t,
      lanes,
      wards: [{ team: 100, x: 5000, y: 9000 }, ...(t >= 2000 ? [{ team: 100 as const, x: 6900, y: 4100 }] : [])],
    }));
    const champs: ChampSample[] = [{ t: 61_500, fog: "off", at: [{ id: 4, x: 7100, y: 4000 }] }];
    const ev: TimelineEvent[] = [
      { type: "WARD_PLACED", timestamp: 61_700, creatorId: 4, wardType: "YELLOW_TRINKET" },
      { type: "WARD_PLACED", timestamp: 61_800, creatorId: 4, wardType: "UNDEFINED" }, // not a ward (e.g. a trap)
    ];
    const r = placeWards(samples, champs, ev, () => 100, 120_000);
    expect(r.total).toBe(1);
    expect(r.placed).toEqual([{ t: 61_700, creatorId: 4, wardType: "YELLOW_TRINKET", x: 6900, y: 4100 }]);
  });

  it("finds a ward that only shows once the placer walks off it, not one that appeared in the open", () => {
    // The icon at (6900, 4100) appears at +8 s; until then the placer stands on it.
    const samples: WaveSample[] = Array.from({ length: 25 }, (_, k) => 60_000 + k * 500).map((t) => ({
      t,
      lanes,
      wards: t >= 70_000 ? [{ team: 100 as const, x: 6900, y: 4100 }] : [],
    }));
    const champs: ChampSample[] = Array.from({ length: 25 }, (_, k) => 60_000 + k * 500).map((t) => ({
      t,
      fog: "off" as const,
      at: [{ id: 4, x: t < 70_000 ? 7100 : 8600, y: 4000 }],
    }));
    const ev: TimelineEvent[] = [{ type: "WARD_PLACED", timestamp: 61_700, creatorId: 4, wardType: "YELLOW_TRINKET" }];
    expect(placeWards(samples, champs, ev, () => 100, 120_000).placed).toEqual([{ t: 61_700, creatorId: 4, wardType: "YELLOW_TRINKET", x: 6900, y: 4100 }]);
    // Same icon, but the placer left the spot at +3 s: it was in the open and isn't theirs.
    const away = champs.map((c) => ({ ...c, at: [{ id: 4, x: c.t < 65_000 ? 7100 : 11_000, y: 4000 }] }));
    expect(placeWards(samples, away, ev, () => 100, 120_000).placed).toEqual([]);
  });

  it("lets a new ward take a spot once the earlier ward there is gone", () => {
    // A trinket at (6900, 4100) from 61 s; it's gone from 70 s (cleared) and a new one is
    // dropped on the same spot at 80 s.
    const ts = Array.from({ length: 60 }, (_, k) => 60_000 + k * 500);
    const icon = (t: number) => (t >= 61_000 && t < 70_000) || t >= 80_500;
    const samples: WaveSample[] = ts.map((t) => ({ t, lanes, wards: icon(t) ? [{ team: 100 as const, x: 6900, y: 4100 }] : [] }));
    const champs: ChampSample[] = ts.map((t) => ({ t, fog: "off" as const, at: [{ id: 4, x: 7100, y: 4000 }] }));
    const ev: TimelineEvent[] = [
      { type: "WARD_PLACED", timestamp: 60_700, creatorId: 4, wardType: "YELLOW_TRINKET" },
      { type: "WARD_PLACED", timestamp: 80_200, creatorId: 4, wardType: "SIGHT_WARD" },
    ];
    expect(placeWards(samples, champs, ev, () => 100, 120_000).placed.map((p) => p.t)).toEqual([60_700, 80_200]);
    // The first ward never left: the second can't be that same icon.
    const stays: WaveSample[] = ts.map((t) => ({ t, lanes, wards: t >= 61_000 ? [{ team: 100 as const, x: 6900, y: 4100 }] : [] }));
    expect(placeWards(stays, champs, ev, () => 100, 120_000).placed.map((p) => p.t)).toEqual([60_700]);
  });

  it("matches a control ward to a steady eye icon and a trinket to a star", () => {
    // A star appears at (6900, 4100) at 61 s and an eye at (7400, 4300) at 61.5 s; a one-frame
    // eye at (7000, 3900) at 62 s is noise (a minion clump that fit the eye once).
    const ts = Array.from({ length: 30 }, (_, k) => 60_000 + k * 500);
    const samples: WaveSample[] = ts.map((t) => ({
      t,
      lanes,
      wards: [
        ...(t >= 61_000 ? [{ team: 100 as const, x: 6900, y: 4100, kind: "stealth" as const }] : []),
        ...(t >= 61_500 ? [{ team: 100 as const, x: 7400, y: 4300, kind: "control" as const }] : []),
        ...(t === 62_000 ? [{ team: 100 as const, x: 7000, y: 3900, kind: "control" as const }] : []),
      ],
    }));
    const champs: ChampSample[] = ts.map((t) => ({ t, fog: "off" as const, at: [{ id: 4, x: 7100, y: 4000 }] }));
    const ev: TimelineEvent[] = [
      { type: "WARD_PLACED", timestamp: 60_700, creatorId: 4, wardType: "YELLOW_TRINKET" },
      { type: "WARD_PLACED", timestamp: 61_200, creatorId: 4, wardType: "CONTROL_WARD" },
    ];
    expect(placeWards(samples, champs, ev, () => 100, 120_000).placed).toEqual([
      { t: 60_700, creatorId: 4, wardType: "YELLOW_TRINKET", x: 6900, y: 4100, icon: "stealth" },
      { t: 61_200, creatorId: 4, wardType: "CONTROL_WARD", x: 7400, y: 4300, icon: "control" },
    ]);
  });
});
