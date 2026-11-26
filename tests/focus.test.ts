import { describe, expect, it } from "vitest";
import { ReadQueue, RETRY_MS, SETTLE_MS } from "../src/core/autoread";
import { computeFocus, FOCUS_DEFS, targetFor, type FocusState } from "../src/core/focus";
import type { Finding } from "../src/core/synth";
import type { GameReport } from "../src/core/types";

const finding = (kind: Finding["kind"], score: number, i = 0): Finding => ({ id: `${kind}-${i}`, kind, t: 60_000 * (i + 3), time: `${i + 3}:00`, title: `${kind} ${i}`, proof: [], cost: "", gold: score, xp: 0, minions: 2, fix: "", jump: { t: 0, follow: "Smolder" }, score });
const game = (n: number, findings?: Finding[]): GameReport => ({ metrics: { matchId: `NA1_${n}`, gameCreation: n * 1000, champion: "Smolder", win: n % 2 === 0 } as GameReport["metrics"], findings }) as GameReport;

describe("the one focus", () => {
  it("is nothing until a replay has been read", () => {
    expect(computeFocus([game(1), game(2)], null).focus).toBeNull();
  });

  it("picks the kind that cost the most across the read games, with its own counts", () => {
    const games = [game(1, [finding("recall", 300), finding("recall", 250, 1), finding("fight", 400)]), game(2, [finding("recall", 200), finding("recall", 100, 1)]), game(3)];
    const { focus, state } = computeFocus(games, null);
    expect(focus!.key).toBe("recall");
    expect(focus!.why).toContain("4 recalls");
    expect(focus!.why).toContain("2 of your last 2 read games (2 a game)");
    expect(state).toMatchObject({ key: "recall", since: 2000, baseline: 2, target: 1 });
    expect(focus!.pass).toMatch(/^At most 1 recall /);
    expect(focus!.worst).toMatchObject({ matchId: "NA1_1", findingId: "recall-0" });
    expect(focus!.graded).toEqual([]);
  });

  it("halves the usual count for the pass line", () => {
    expect([0.4, 1, 1.9, 2, 3.5, 6].map(targetFor)).toEqual([0, 0, 0, 1, 1, 3]);
  });

  it("grades only games played after it was set and stays until 3 of the last 4 hold", () => {
    const st: FocusState = { key: "recall", since: 2000, baseline: 2, target: 1, mastered: [] };
    const base = [game(1, [finding("recall", 300), finding("recall", 250, 1)]), game(2, [finding("recall", 200), finding("recall", 100, 1), finding("fight", 90)])];
    const two = [...base, game(3, [finding("recall", 100)]), game(4, [finding("recall", 1), finding("recall", 1, 1)]), game(5, [])];
    const a = computeFocus(two, st);
    expect(a.focus!.key).toBe("recall");
    expect(a.focus!.graded.map((g) => [g.matchId, g.count, g.held])).toEqual([["NA1_5", 0, true], ["NA1_4", 2, false], ["NA1_3", 1, true]]);
    expect(a.focus!.needed).toBe(1);
    expect(a.moved).toBeNull();
    // An unread game in between changes nothing; one more held game moves the focus on.
    const b = computeFocus([...two, game(6), game(7, [finding("fight", 50)])], st);
    expect(b.moved).toBe("recall");
    expect(b.focus!.key).toBe("fight");
    expect(b.state!.mastered).toEqual([{ key: "recall", at: 7000 }]);
    expect(b.state!.since).toBe(7000);
  });

  it("keeps the rules free of stock advice and full of numbers", () => {
    const banned = [/ward more/i, /play(ing)? saf/i, /focus on farm/i, /watch (the|your) (mini)?map/i, /map awareness/i, /be (more )?careful/i, /try to/i];
    for (const d of Object.values(FOCUS_DEFS)) {
      for (const b of banned) expect(`${d.rule} ${d.cue}`).not.toMatch(b);
      expect(d.cue).toMatch(/ask: .+\?$/);
    }
  });
});

describe("reading replays by itself", () => {
  it("waits for the client to settle outside a queue, newest game first", () => {
    const q = new ReadQueue();
    q.add("A", 0);
    q.add("B", 0);
    expect(q.next("ChampSelect", 0)).toBeNull();
    expect(q.next("EndOfGame", 1000)).toBeNull();
    expect(q.next("Lobby", 1000 + SETTLE_MS - 1)).toBeNull();
    expect(q.next("Lobby", 1000 + SETTLE_MS)).toBe("B");
    expect(q.next("Lobby", 1000 + SETTLE_MS + 5000)).toBeNull(); // one at a time
  });

  it("never starts with the client closed or a replay already on screen", () => {
    const q = new ReadQueue();
    q.add("A", 0);
    expect(q.next(null, SETTLE_MS * 2)).toBeNull();
    expect(q.next("WatchInProgress", SETTLE_MS * 4)).toBeNull();
  });

  it("calls a running read off when a queue starts and tries it again later without using a try", () => {
    const q = new ReadQueue();
    q.add("A", 0);
    q.next("None", 0);
    expect(q.next("None", SETTLE_MS)).toBe("A");
    expect(q.mustCancel("None")).toBe(false);
    expect(q.mustCancel("Matchmaking")).toBe(true);
    q.finish("A", "later", 30_000);
    expect(q.pending).toEqual([{ matchId: "A", tries: 0, after: 30_000 + RETRY_MS }]);
    q.next("Lobby", 40_000);
    expect(q.next("Lobby", 40_000 + SETTLE_MS)).toBeNull(); // not before the retry time
    expect(q.next("Lobby", 30_000 + RETRY_MS)).toBe("A");
  });

  it("gives up after three failed reads and forgets a finished one", () => {
    const q = new ReadQueue();
    q.add("A", 0);
    for (let i = 0; i < 3; i++) {
      q.running = "A";
      q.finish("A", "retry", 0);
    }
    expect(q.pending).toEqual([]);
    q.add("B", 0);
    q.running = "B";
    q.finish("B", "done", 0);
    expect(q.pending).toEqual([]);
    expect(q.running).toBeNull();
  });
});
