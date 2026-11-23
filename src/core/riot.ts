import type { MatchDto, TimelineDto } from "./types";

// Platform region -> regional routing cluster used by account-v1 and match-v5.
export const REGIONS: Record<string, { platform: string; cluster: string }> = {
  NA: { platform: "na1", cluster: "americas" },
  BR: { platform: "br1", cluster: "americas" },
  LAN: { platform: "la1", cluster: "americas" },
  LAS: { platform: "la2", cluster: "americas" },
  EUW: { platform: "euw1", cluster: "europe" },
  EUNE: { platform: "eun1", cluster: "europe" },
  TR: { platform: "tr1", cluster: "europe" },
  RU: { platform: "ru", cluster: "europe" },
  KR: { platform: "kr", cluster: "asia" },
  JP: { platform: "jp1", cluster: "asia" },
  OCE: { platform: "oc1", cluster: "sea" },
};

// Summoner's Rift queues: normal draft, ranked solo, ranked flex.
export const SR_QUEUES = [400, 420, 440];

export interface Cache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class RiotApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

/**
 * Minimal Riot API client. Spaces requests out to stay under the development key
 * limits (20 per second, 100 per 2 minutes) and retries on 429.
 */
export class RiotClient {
  private recent: number[] = [];

  constructor(
    private apiKey: string,
    private region: string,
    private cache?: Cache,
    private fetchImpl: Fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!REGIONS[region]) throw new Error(`Unknown region ${region}`);
  }

  private get cluster() {
    return REGIONS[this.region].cluster;
  }

  private async throttle() {
    for (;;) {
      const now = Date.now();
      this.recent = this.recent.filter((t) => now - t < 120_000);
      const lastSecond = this.recent.filter((t) => now - t < 1000).length;
      if (this.recent.length < 95 && lastSecond < 18) break;
      const wait = this.recent.length >= 95 ? 120_000 - (now - this.recent[0]) : 1000;
      await this.sleep(Math.max(wait, 50));
    }
    this.recent.push(Date.now());
  }

  async get<T>(url: string, attempt = 0): Promise<T> {
    await this.throttle();
    const res = await this.fetchImpl(url, { headers: { "X-Riot-Token": this.apiKey } });
    if (res.status === 429 && attempt < 3) {
      const retry = Number(res.headers.get("Retry-After") ?? "5");
      await this.sleep(retry * 1000);
      return this.get<T>(url, attempt + 1);
    }
    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? "Your Riot API key is missing, wrong or expired. Development keys expire every 24 hours."
          : res.status === 404
            ? "Not found. Check your Riot ID and region."
            : `Riot API error ${res.status}.`;
      throw new RiotApiError(res.status, hint);
    }
    return (await res.json()) as T;
  }

  private async cached<T>(key: string, url: string): Promise<T> {
    const hit = await this.cache?.get(key);
    if (hit !== undefined) return hit as T;
    const value = await this.get<T>(url);
    await this.cache?.set(key, value);
    return value;
  }

  async getPuuid(gameName: string, tagLine: string): Promise<string> {
    const url = `https://${this.cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const acc = await this.get<{ puuid: string }>(url);
    return acc.puuid;
  }

  async getMatchIds(puuid: string, count: number, queue?: number): Promise<string[]> {
    const q = new URLSearchParams({ start: "0", count: String(Math.min(count, 100)) });
    if (queue) q.set("queue", String(queue));
    return this.get<string[]>(`https://${this.cluster}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?${q}`);
  }

  getMatch(id: string): Promise<MatchDto> {
    return this.cached(`match-${id}`, `https://${this.cluster}.api.riotgames.com/lol/match/v5/matches/${id}`);
  }

  getTimeline(id: string): Promise<TimelineDto> {
    return this.cached(`timeline-${id}`, `https://${this.cluster}.api.riotgames.com/lol/match/v5/matches/${id}/timeline`);
  }
}

/** Accepts "Name#TAG" or "Name #TAG". */
export function parseRiotId(input: string): { gameName: string; tagLine: string } {
  const [name, tag] = input.split("#").map((s) => s.trim());
  if (!name || !tag) throw new Error('Riot ID should look like "Name#TAG".');
  return { gameName: name, tagLine: tag };
}
