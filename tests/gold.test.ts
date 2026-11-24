import { describe, expect, it } from "vitest";
import { checkGold, goldModel, spendOf, type ItemTable } from "../src/core/gold";
import type { TimelineDto, TimelineEvent } from "../src/core/types";

const items: ItemTable = { 1036: { total: 350, sell: 245 }, 3133: { total: 1100, sell: 770, from: [1036, 1036] }, 2003: { total: 50, sell: 20 } };
const pf = (totalGold: number, currentGold: number) => ({ participantId: 1, totalGold, currentGold, xp: 0, level: 1, minionsKilled: 0, jungleMinionsKilled: 0, position: { x: 0, y: 0 } });

describe("gold between frames", () => {
  it("prices a recipe net of the components it uses up", () => {
    const ev: TimelineEvent[] = [
      { type: "ITEM_PURCHASED", timestamp: 1000, participantId: 1, itemId: 3133 },
      { type: "ITEM_DESTROYED", timestamp: 1000, participantId: 1, itemId: 1036 },
      { type: "ITEM_DESTROYED", timestamp: 1000, participantId: 1, itemId: 1036 },
      { type: "ITEM_DESTROYED", timestamp: 1000, participantId: 1, itemId: 2003 }, // not in the recipe, but used up at the same moment
    ];
    expect(spendOf(ev[0], ev, items)).toBe(350); // the potion goes too: a built item ate it
    // A plain buy never credits what else was destroyed.
    const ward: TimelineEvent[] = [{ type: "ITEM_PURCHASED", timestamp: 5, participantId: 1, itemId: 2003 }, { type: "ITEM_DESTROYED", timestamp: 5, participantId: 1, itemId: 1036 }];
    expect(spendOf(ward[0], ward, items)).toBe(50);
  });

  it("spreads income over the minute, puts bounties on the kill and takes off purchases", () => {
    const tl = {
      metadata: { matchId: "x" },
      info: {
        frameInterval: 60000,
        frames: [
          { timestamp: 0, participantFrames: { 1: pf(500, 500) }, events: [] },
          { timestamp: 60000, participantFrames: { 1: pf(1400, 1050) }, events: [
            { type: "CHAMPION_KILL", timestamp: 30000, killerId: 1, victimId: 6, bounty: 300 },
            { type: "ITEM_PURCHASED", timestamp: 45000, participantId: 1, itemId: 1036 },
          ] },
        ],
      },
    } as unknown as TimelineDto;
    const g = goldModel(tl, items);
    // 600 of income over the minute = 10 g/s; +300 at 0:30; -350 at 0:45.
    expect(g.at(1, 20000)).toBe(700);
    expect(g.at(1, 40000)).toBe(1200);
    expect(g.at(1, 50000)).toBe(950);
    expect(checkGold(tl, items, 60000).pass).toBe(true);
  });
});
