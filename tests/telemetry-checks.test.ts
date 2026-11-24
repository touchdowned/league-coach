import { describe, expect, it } from "vitest";
import { checkCs, checkItems, type InvChange, type LivePoll } from "../src/core/telemetry";
import type { TimelineDto, TimelineEvent } from "../src/core/types";

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
    const changes: InvChange[] = [{ t: 193_500, window: 2000, champion: "Jax", kind: "item+", item: 1036 }];
    const r = checkItems(changes, events, champOf, 400_000, 64_000);
    expect(r.n).toBe(2); // the 1:05 buy and the placed ward aren't judged
    expect(r.measured).toMatch(/50% matched \(1\/2\)/);
    expect(r.pass).toBe(false);
    expect(r.detail).toEqual([{ t: 300_000, champion: "Jax", item: 3044 }]);
  });
});
