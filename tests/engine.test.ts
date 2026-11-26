import { describe, expect, it } from "vitest";
import { findOpponent, findPlayer } from "../src/core/analysis";
import { leverTotals, readGame } from "../src/core/engine";
import { buildTrack } from "../src/core/track";
import type { TimelineEvent } from "../src/core/types";
import { death, makeGame, ME } from "./fixtures";

// Me: Ahri mid, participant 3 (blue). Lane opponent: participant 8. Enemy jungler: 7.
function read(events: TimelineEvent[], tweak?: (g: ReturnType<typeof makeGame>) => void) {
  const g = makeGame({ events });
  tweak?.(g);
  const me = findPlayer(g.match, ME);
  return readGame(g.match, g.timeline, buildTrack(g.match, g.timeline), me, findOpponent(g.match, me));
}
const buy = (t: number): TimelineEvent => ({ type: "ITEM_PURCHASED", timestamp: t, participantId: 3, itemId: 1036 });

describe("replay-reading engine", () => {
  it("grades a recall that cost farm and plates, with no death involved", () => {
    const g = (x: ReturnType<typeof makeGame>) => {
      // Opponent keeps farming 6/min; I lose 8 CS around the 8:00 recall.
      for (const f of x.timeline.info.frames) {
        const m = f.timestamp / 60000;
        if (m >= 8) f.participantFrames["3"].minionsKilled -= 8;
        f.participantFrames["3"].position = { x: 7400, y: 7400 };
        f.participantFrames["8"].minionsKilled = Math.round(7 * m);
      }
    };
    const leaks = read([buy(8 * 60000 + 20000), { type: "TURRET_PLATE_DESTROYED", timestamp: 8 * 60000 + 15000, teamId: 100, laneType: "MID_LANE" }], g);
    const r = leaks.find((l) => l.kind === "recall")!;
    expect(r).toBeTruthy();
    expect(r.costParts.some((p) => /plate/.test(p.label))).toBe(true);
    expect(r.nextTime).toMatch(/Shove the wave/);
    expect(r.cost).toBeGreaterThan(200);
  });

  it("does not count a shop after dying as a recall", () => {
    const leaks = read([death(8 * 60000, 3, 8), buy(8 * 60000 + 40000)]);
    expect(leaks.some((l) => l.kind === "recall")).toBe(false);
  });

  it("turns a 3-man collapse into a trade call instead of 'play safe'", () => {
    const leaks = read([death(22 * 60000, 3, 8, { assistingParticipantIds: [6, 7], position: { x: 3000, y: 12500 } })]);
    const d = leaks.find((l) => l.kind === "death")!;
    expect(d.nextTime).toMatch(/3 of them came for you/);
    expect(d.nextTime).toMatch(/dragon was up|towers/);
    expect(d.nextTime).not.toMatch(/play safe/i);
  });

  it("uses where the jungler was for laning-phase ganks", () => {
    const leaks = read([death(6 * 60000 + 30000, 3, 7, { assistingParticipantIds: [8] })], (x) => {
      for (const f of x.timeline.info.frames) f.participantFrames["7"].position = { x: 10500, y: 6000 };
    });
    const d = leaks.find((l) => l.kind === "death")!;
    expect(d.nextTime).toMatch(/Champ6 was in .* at 5:45/);
  });

  it("flags lane farm gaps as their own leak and ranks everything by cost", () => {
    const leaks = read([], (x) => {
      for (const f of x.timeline.info.frames) {
        const m = f.timestamp / 60000;
        if (m >= 5) f.participantFrames["3"].minionsKilled = Math.round(7 * 5 + 3 * (m - 5)); // drop to 3 CS/min
        f.participantFrames["8"].minionsKilled = Math.round(7 * m);
      }
    });
    expect(leaks.some((l) => l.kind === "farm")).toBe(true);
    for (let i = 1; i < leaks.length; i++) expect(leaks[i - 1].cost).toBeGreaterThanOrEqual(leaks[i].cost);
    const totals = leverTotals([{ leaks }]);
    expect(totals[0].kind).toBe("farm");
  });
});
