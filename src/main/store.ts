import { promises as fs } from "fs";
import path from "path";
import type { Cache } from "../core/riot";

export interface Settings {
  apiKey: string;
  riotId: string;
  region: string;
  matchCount: number;
  leagueDir: string;
  vodDir: string;
  autoAdvanceSec: number;
}

export const DEFAULT_SETTINGS: Settings = { apiKey: "", riotId: "", region: "NA", matchCount: 40, leagueDir: "C:\\Riot Games\\League of Legends", vodDir: "", autoAdvanceSec: 14 };

export class JsonStore {
  constructor(private dir: string) {}

  private file(name: string) {
    return path.join(this.dir, name);
  }

  async readSettings(): Promise<Settings> {
    try {
      const raw = await fs.readFile(this.file("settings.json"), "utf8");
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async writeSettings(s: Settings): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file("settings.json"), JSON.stringify(s, null, 2));
  }

  async readReports<T>(): Promise<T[]> {
    try {
      return JSON.parse(await fs.readFile(this.file("reports.json"), "utf8"));
    } catch {
      return [];
    }
  }

  async writeReports(reports: unknown[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file("reports.json"), JSON.stringify(reports));
  }

  async readJson<T>(name: string, fallback: T): Promise<T> {
    try {
      return { ...fallback, ...JSON.parse(await fs.readFile(this.file(name), "utf8")) };
    } catch {
      return fallback;
    }
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(name), JSON.stringify(value));
  }

  /** Disk cache for match and timeline JSON. Matches never change, so no expiry. */
  cache(): Cache {
    const dir = path.join(this.dir, "cache");
    return {
      get: async (key) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), "utf8"));
        } catch {
          return undefined;
        }
      },
      set: async (key, value) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value));
      },
    };
  }
}
