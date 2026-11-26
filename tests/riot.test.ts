import { describe, expect, it, vi } from "vitest";
import { parseRiotId, RiotClient } from "../src/core/riot";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("RiotClient", () => {
  it("uses the americas cluster for NA and sends the key", async () => {
    const f = vi.fn(async () => ok({ puuid: "abc" }));
    const c = new RiotClient("KEY", "NA", undefined, f as any);
    expect(await c.getPuuid("Some Player", "NA1")).toBe("abc");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Some%20Player/NA1");
    expect((init.headers as Record<string, string>)["X-Riot-Token"]).toBe("KEY");
  });

  it("retries after a 429", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(ok(["NA1_1"]));
    const sleep = vi.fn(async () => {});
    const c = new RiotClient("KEY", "NA", undefined, f as any, sleep);
    expect(await c.getMatchIds("p", 20)).toEqual(["NA1_1"]);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("explains an expired key", async () => {
    const f = vi.fn(async () => new Response("", { status: 403 }));
    const c = new RiotClient("KEY", "NA", undefined, f as any);
    await expect(c.getMatchIds("p", 20)).rejects.toThrow(/expired/);
  });

  it("serves matches from the cache", async () => {
    const store = new Map<string, unknown>([["match-NA1_9", { cached: true }]]);
    const f = vi.fn();
    const c = new RiotClient("KEY", "NA", { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) }, f as any);
    expect(await c.getMatch("NA1_9")).toEqual({ cached: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("parseRiotId", () => {
  it("accepts spaces around the tag", () => {
    expect(parseRiotId("SomePlayer #NA1")).toEqual({ gameName: "SomePlayer", tagLine: "NA1" });
    expect(() => parseRiotId("nohash")).toThrow();
  });
});
