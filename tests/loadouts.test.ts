import { describe, expect, it } from "vitest";
import type { MatchDto, TimelineDto, TimelineEvent } from "../src/core/types";
import { freeBootsAt, loadouts } from "../src/core/vulnerability";

const items = { 2422: { total: 300, sell: 210 }, 3158: { total: 900, sell: 630, from: [2422] }, 1052: { total: 400, sell: 280 } };
const part = (participantId: number, perk?: number) => ({ participantId, teamId: participantId <= 5 ? 100 : 200, perks: perk ? { styles: [{ selections: [{ perk }] }] } : undefined });
const match = { info: { participants: [part(1, 8304), part(2), part(6, 8304)] } } as unknown as MatchDto;
const tl = (events: Partial<TimelineEvent>[]) => ({ info: { frames: [{ timestamp: 0, events, participantFrames: {} }] } }) as unknown as TimelineDto;
const kill = (timestamp: number, killerId: number, assists: number[] = []) => ({ type: "CHAMPION_KILL", timestamp, killerId, victimId: 7, assistingParticipantIds: assists });

describe("free boots from Magical Footwear", () => {
  it("arrive at 12:00, 45 s sooner per takedown, and only for players with the rune", () => {
    const ev = [kill(200_000, 1), kill(300_000, 2, [1]), kill(700_000, 1)] as TimelineEvent[];
    const at = freeBootsAt(match, ev);
    // Two takedowns before the grant: 12:00 - 90 s = 10:30. The third at 11:40 comes after it.
    expect(at.get(1)).toBe(630_000);
    expect(at.has(2)).toBe(false);
    expect(at.get(6)).toBe(720_000);
  });

  it("grants on the spot when a takedown moves the time into the past", () => {
    const ev = Array.from({ length: 16 }, (_, k) => kill(60_000 + k * 1000, 1)) as TimelineEvent[];
    // 16 takedowns by 1:15 would put the grant at 0:00: it lands at the takedown that crossed it.
    const due = freeBootsAt(match, ev).get(1)!;
    expect(due).toBeGreaterThanOrEqual(60_000);
    expect(due).toBeLessThanOrEqual(75_000);
  });

  it("is in the inventory from the grant until it is built into boots", () => {
    const ev = [
      { type: "ITEM_PURCHASED", timestamp: 100_000, participantId: 1, itemId: 1052 },
      { type: "ITEM_PURCHASED", timestamp: 800_000, participantId: 1, itemId: 3158 },
      { type: "ITEM_DESTROYED", timestamp: 800_000, participantId: 1, itemId: 2422 },
    ];
    const lo = loadouts(tl(ev), items, match);
    expect(lo.at(1, 700_000).items).toEqual([1052]);
    expect(lo.at(1, 730_000).items).toEqual([1052, 2422]);
    expect(lo.at(1, 730_000).itemGold).toBe(700);
    expect(lo.at(1, 810_000).items).toEqual([1052, 3158]);
    expect(loadouts(tl(ev), items).at(1, 730_000).items).toEqual([1052]);
  });
});
