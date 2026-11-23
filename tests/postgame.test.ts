import { describe, expect, it, vi } from "vitest";
import { GameEndDetector, gameFromEog, gameFromSession, isRanked } from "../src/core/postgame";
import { PostGameWatcher } from "../src/main/postgame";

const ranked = { gameId: "5123", queueId: 420 };

describe("GameEndDetector", () => {
  it("reports a game once when it leaves the in-game phases", () => {
    const d = new GameEndDetector();
    expect(d.update("ChampSelect")).toBeNull();
    expect(d.update("InProgress", ranked)).toBeNull();
    expect(d.update("Reconnect", ranked)).toBeNull();
    expect(d.update("WaitingForStats")).toEqual(ranked);
    expect(d.update("PreEndOfGame", ranked)).toBeNull();
    expect(d.update("EndOfGame", ranked)).toBeNull();
    expect(d.update("Lobby")).toBeNull();
  });

  it("still reports the game if the client closes and comes back to the lobby", () => {
    const d = new GameEndDetector();
    d.update("InProgress", ranked);
    expect(d.update(null)).toBeNull();
    expect(d.update("None")).toEqual(ranked);
  });

  it("catches a game first seen on the end-of-game screen (app opened late)", () => {
    const d = new GameEndDetector();
    expect(d.update("EndOfGame", ranked)).toEqual(ranked);
    expect(d.update("EndOfGame", ranked)).toBeNull();
  });

  it("ignores a dodge in champ select", () => {
    const d = new GameEndDetector();
    d.update("ChampSelect");
    expect(d.update("Lobby")).toBeNull();
  });

  it("reads game id and queue from the client", () => {
    expect(gameFromSession({ gameData: { gameId: 77, queue: { id: 440 } } })).toEqual({ gameId: "77", queueId: 440 });
    expect(gameFromSession({ gameData: { gameId: 0 } })).toBeNull();
    expect(gameFromEog({ gameId: 9, queueType: "RANKED_SOLO_5x5" })).toEqual({ gameId: "9", queueId: 420 });
    expect(isRanked(420)).toBe(true);
    expect(isRanked(450)).toBe(false);
  });
});

function fakeLeague(replayStates: string[], phase = "EndOfGame") {
  const states = [...replayStates];
  return {
    gameflowPhase: vi.fn(async () => phase),
    lcuGet: vi.fn(async () => null),
    replayMeta: vi.fn(async () => ({ state: states.length > 1 ? states.shift()! : states[0] })),
    download: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
  };
}

function setup(opts: { replay?: string[]; published?: boolean[]; autoLaunch?: boolean; phase?: string; reports?: string[] } = {}) {
  const lc = fakeLeague(opts.replay ?? ["download", "downloading", "watch"], opts.phase);
  const published = [...(opts.published ?? [false, true])];
  const deps = {
    settings: vi.fn(async () => ({ autoReview: true, autoLaunchReplay: opts.autoLaunch ?? false }) as any),
    league: vi.fn(async () => lc as any),
    matchPublished: vi.fn(async () => (published.length > 1 ? published.shift()! : published[0])),
    sync: vi.fn(async () => (opts.reports ?? ["NA1_5123"]).map((matchId) => ({ metrics: { matchId } }) as any)),
    status: vi.fn(),
    openReview: vi.fn(),
    sleep: vi.fn(async () => undefined),
  };
  return { lc, deps, watcher: new PostGameWatcher(deps) };
}

describe("PostGameWatcher", () => {
  it("waits for the match, syncs, opens the review and downloads the replay", async () => {
    const { lc, deps, watcher } = setup();
    await watcher.handle(ranked);
    expect(deps.matchPublished).toHaveBeenCalledTimes(2);
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.openReview).toHaveBeenCalledWith("NA1_5123");
    expect(lc.download).toHaveBeenCalledTimes(1);
    expect(lc.watch).not.toHaveBeenCalled();
    expect(watcher.status.stage).toBe("ready");
  });

  it("opens the replay in League only when asked and the client is idle", async () => {
    const a = setup({ autoLaunch: true });
    await a.watcher.handle(ranked);
    expect(a.lc.watch).toHaveBeenCalledWith("5123");

    const b = setup({ autoLaunch: true, phase: "ChampSelect" });
    await b.watcher.handle(ranked);
    expect(b.lc.watch).not.toHaveBeenCalled();
  });

  it("skips normal games", async () => {
    const { deps, watcher } = setup();
    await watcher.handle({ gameId: "1", queueId: 400 });
    expect(deps.matchPublished).not.toHaveBeenCalled();
  });

  it("says so when the game was a remake", async () => {
    const { deps, watcher } = setup({ reports: [] });
    await watcher.handle(ranked);
    expect(deps.openReview).not.toHaveBeenCalled();
    expect(watcher.status.stage).toBe("failed");
  });

  it("stops if the replay is gone", async () => {
    const { lc, watcher } = setup({ replay: ["missingOrExpired"] });
    await watcher.handle(ranked);
    expect(lc.download).not.toHaveBeenCalled();
  });

  it("detects the end of a game from the client", async () => {
    const { lc, watcher } = setup();
    const handle = vi.spyOn(watcher, "handle").mockResolvedValue();
    lc.gameflowPhase.mockResolvedValueOnce("InProgress");
    lc.lcuGet.mockResolvedValueOnce({ gameData: { gameId: 5123, queue: { id: 420 } } } as any);
    await watcher.tick();
    expect(handle).not.toHaveBeenCalled();
    lc.gameflowPhase.mockResolvedValueOnce("WaitingForStats");
    await watcher.tick();
    expect(handle).toHaveBeenCalledWith(ranked);
  });
});
