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
  /** After a ranked game: sync it and open its review. */
  autoReview: boolean;
  /** Also open the replay in League once it has downloaded. */
  autoLaunchReplay: boolean;
  /** Start hidden at Windows sign-in so games are caught without opening the app. */
  launchAtLogin: boolean;
  /** Draw the goal overlay over League while you play. */
  overlay: boolean;
  /** Short contextual reminders on the overlay (objective spawns, gold, pace). */
  overlayNudges: boolean;
  /** Where the overlay's goal panel sits, as fractions of the screen. */
  overlayPos: { x: number; y: number } | null;
  /** Show the goal card during champ select. */
  draftCompanion: boolean;
  /** Open the mental debrief when a game ends. */
  autoDebrief: boolean;
}

export const DEFAULT_SETTINGS: Settings = { apiKey: "", riotId: "", region: "NA", matchCount: 40, leagueDir: "C:\\Riot Games\\League of Legends", vodDir: "", autoAdvanceSec: 14, autoReview: true, autoLaunchReplay: false, launchAtLogin: false, overlay: true, overlayNudges: true, overlayPos: null, draftCompanion: true, autoDebrief: true };

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
