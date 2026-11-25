import { describe, expect, it } from "vitest";
import { checkCs, checkItems, type InvChange, type LivePoll } from "../src/core/telemetry";
import type { TimelineDto, TimelineEvent } from "../src/core/types";
import { fillOcclusions } from "../src/core/vision";
import { rematch } from "../src/core/minimap";

const champOf = (id: number) => ({ 1: "Jax", 2: "Mordekaiser" })[id as 1 | 2] ?? "";

describe("stream checks", () => {
  it("compares Live Client CS in steps of 10 and names a stream that's wrong throughout", () => {
    const frames = [60, 120, 180, 240].map((m, k) => ({
      timestamp: m * 1000,
      participantFrames: { "1": { minionsKilled: 8 + k * 11, jungleMinionsKilled: 0 }, "2": { minionsKilled: 0, jungleMinionsKilled: 12 + k * 16 } },
      events: [],
    }));
    const polls: LivePoll[] = frames.map((f, k) => ({
      t: f.timestamp + 200,
      players: [
        { championName: "Jax", cs: Math.floor((8 + k * 11) / 10) * 10 } as never,
        { championName: "Mordekaiser", cs: 10 } as never,
      ],
    }));
    const r = checkCs(polls, { info: { frames } } as unknown as TimelineDto, champOf, 300_000);
    expect(r.measured).toMatch(/Mordekaiser/);
    expect((r.detail as { off: Record<string, number> }).off.Jax).toBeUndefined();
  });

  it("judges only buys a poll could see, inside the poll window", () => {
    const ev = (type: string, t: number, itemId: number): TimelineEvent => ({ type, timestamp: t, participantId: 1, itemId }) as TimelineEvent;
    const events = [ev("ITEM_PURCHASED", 10_000, 1055), ev("ITEM_PURCHASED", 131_000, 2055), ev("ITEM_DESTROYED", 132_500, 2055), ev("ITEM_PURCHASED", 192_700, 1036), ev("ITEM_PURCHASED", 300_000, 3044)];
    const changes: InvChange[] = [
      { t: 193_500, window: 2000, champion: "Jax", kind: "item+", item: 1036 },
      { t: 50_000, window: 2000, champion: "Mordekaiser", kind: "item+", item: 3044 }, // Live Client does list 3044
    ];
    const r = checkItems(changes, events, champOf, 400_000, 64_000);
    expect(r.n).toBe(2); // the 0:10 buy and the placed ward aren't judged
    expect(r.measured).toMatch(/50% matched \(1\/2\)/);
    expect(r.pass).toBe(false);
    expect(r.detail).toEqual({ missed: [{ t: 300_000, champion: "Jax", item: 3044 }], unlisted: [] });
  });

  it("fills an ally hidden under another icon, between two reads", () => {
    const champs = [0, 1000, 2000, 3000].map((t) => ({ t, fog: "team" as const, at: [{ id: 2, x: 9000 + t / 10, y: 1000 }, ...(t === 0 || t === 3000 ? [{ id: 1, x: 9000 + t / 10, y: 1050 }] : [])] }));
    expect(fillOcclusions(champs, [1, 2], () => true)).toBe(2);
    expect(champs[1].at.find((a) => a.id === 1)).toEqual({ id: 1, x: 9100, y: 1050, inferred: true });
    // Dead in between: not filled.
    const c2 = [0, 1000, 3000].map((t) => ({ t, fog: "team" as const, at: [{ id: 2, x: 9000, y: 1000 }, ...(t !== 1000 ? [{ id: 1, x: 9000, y: 1000 }] : [])] }));
    expect(fillOcclusions(c2, [1, 2], (id, t) => !(id === 1 && t === 1000))).toBe(0);
  });
});

describe("second look at unmatched rings", () => {
  it("names a ring from this replay's own icons only with a clear margin", () => {
    const g = (v: number) => Array.from({ length: 192 }, (_, i) => ((i * 37 + v * 11) % 97) * 2);
    const learned = new Map([
      [9, { team: 200 as const, grids: [g(1)] }],
      [10, { team: 200 as const, grids: [g(2)] }],
    ]);
    const ids = rematch(
      [
        { grid: g(1).map((x) => x + 3), team: 200, taken: new Set<number>() },
        { grid: g(1), team: 200, taken: new Set([9]) },
        { grid: g(1), team: 100, taken: new Set<number>() },
      ],
      learned,
    );
    expect(ids[0]).toBe(9);
    expect(ids[1]).toBe(0); // 9 already in the frame; 10 doesn't fit
    expect(ids[2]).toBe(0); // wrong team
  });
});

describe("champion names across sources", () => {
  it("joins Live Client display names to match ids", async () => {
    const { champKey, parseLive } = await import("../src/core/telemetry");
    expect(champKey("Master Yi")).toBe(champKey("MasterYi"));
    expect(champKey("Aurelion Sol")).toBe(champKey("AurelionSol"));
    expect(champKey("Kai'Sa")).toBe(champKey("Kaisa"));
    const poll = parseLive({
      gameData: { gameTime: 10 },
      allPlayers: [
        { championName: "Wukong", rawChampionName: "game_character_displayname_MonkeyKing", team: "ORDER", level: 1 },
        { championName: "Master Yi", team: "ORDER", level: 1 },
      ],
    });
    expect(poll!.players[0].championName).toBe(champKey("MonkeyKing"));
    expect(poll!.players[1].championName).toBe(champKey("MasterYi"));
  });
});

describe("item stacks, undone buys and the fog-off pass", () => {
  it("lists each copy of a stacked item, so a second potion is a change", async () => {
    const { parseLive, invChanges } = await import("../src/core/telemetry");
    const at = (t: number, count: number) =>
      parseLive({ gameData: { gameTime: t }, allPlayers: [{ championName: "Yone", team: "CHAOS", level: 9, items: [{ itemID: 2003, count }, { itemID: 3006, count: 1 }] }] })!;
    expect(at(1, 2).players[0].items).toEqual([2003, 2003, 3006]);
    const ch = invChanges([at(568, 1), at(569, 3)]);
    expect(ch.filter((c) => c.kind === "item+" && c.item === 2003)).toHaveLength(2);
  });

  it("does not judge a buy that was undone in the shop", () => {
    const events = [
      { type: "ITEM_PURCHASED", timestamp: 271_325, participantId: 1, itemId: 2003 },
      { type: "ITEM_UNDO", timestamp: 274_900, participantId: 1, beforeId: 2003, afterId: 0 },
    ] as TimelineEvent[];
    const changes: InvChange[] = [{ t: 100_000, window: 1000, champion: "jax", kind: "item+", item: 2003 }];
    const r = checkItems(changes, events, champOf, 400_000, 64_000);
    expect(r.n).toBe(0);
    expect(r.measured).toMatch(/1 consumed, undone or rebought/);
  });

  it("fails a fog-off pass that only showed one team", async () => {
    const { checkFogOff } = await import("../src/core/telemetry");
    const lane = (b: number, r: number) => ({ b: Array(b).fill(0.5), r: Array(r).fill(0.5) });
    const track = (b: number, r: number) => ({ samples: [{ t: 0, lanes: { TOP: lane(b, r), MIDDLE: lane(b, r), BOTTOM: lane(b, r) } }] }) as never;
    expect(checkFogOff(track(6, 5)).pass).toBe(true);
    const one = checkFogOff(track(6, 1));
    expect(one.pass).toBe(false);
    expect(one.measured).toMatch(/red is hidden/);
  });
});
