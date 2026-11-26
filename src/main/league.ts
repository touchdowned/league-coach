import { execFile } from "child_process";
import { promises as fs } from "fs";
import https from "https";
import path from "path";
import { cameraLookingAt } from "../core/camera";

/**
 * Talks to the League client on this PC (post-game only):
 *  - LCU API (the client's local API, found via its lockfile) to download a match's
 *    replay and open it.
 *  - Replay API (port 2999, available while a replay is open) to seek and pause.
 * Both are local HTTPS endpoints with a self-signed Riot certificate, so this agent
 * skips certificate checks for 127.0.0.1 only.
 */

const local = new https.Agent({ rejectUnauthorized: false });

export const DEFAULT_LEAGUE_DIR = "C:\\Riot Games\\League of Legends";

function request<T>(url: string, opts: { method?: string; auth?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; data: T | null }> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = https.request(
      url,
      {
        method: opts.method ?? "GET",
        agent: local,
        timeout: opts.timeoutMs ?? 4000,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
          ...(opts.auth ? { Authorization: `Basic ${Buffer.from(`riot:${opts.auth}`).toString("base64")}` } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let data: T | null = null;
          try {
            data = raw ? (JSON.parse(raw) as T) : null;
          } catch {
            data = null;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

interface Lockfile {
  port: number;
  password: string;
}

async function readLockfile(leagueDir: string): Promise<Lockfile | null> {
  try {
    const raw = await fs.readFile(path.join(leagueDir, "lockfile"), "utf8");
    const [, , port, password] = raw.trim().split(":");
    return { port: Number(port), password };
  } catch {
    return null;
  }
}

/** "NA1_5123456789" -> 5123456789 */
export function gameIdOf(matchId: string): string {
  return matchId.split("_").pop() ?? matchId;
}

export type ReplayState =
  | { kind: "client-closed" }
  | { kind: "api-disabled" }
  | { kind: "unavailable"; reason: string } // expired, wrong patch, etc
  | { kind: "can-download" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" } // downloaded, can be opened
  | { kind: "open"; time: number; length: number; paused: boolean };

export class LeagueClient {
  constructor(private leagueDir: string) {}

  async replayApiEnabled(): Promise<boolean> {
    try {
      const cfg = await fs.readFile(path.join(this.leagueDir, "Config", "game.cfg"), "utf8");
      return /^\s*EnableReplayApi\s*=\s*1/im.test(cfg);
    } catch {
      return false;
    }
  }

  /** Turns on the Replay API in game.cfg (keeps a backup). Takes effect next time a replay opens. */
  async enableReplayApi(): Promise<void> {
    const file = path.join(this.leagueDir, "Config", "game.cfg");
    const cfg = await fs.readFile(file, "utf8");
    await fs.writeFile(`${file}.league-coach.bak`, cfg);
    let next: string;
    if (/^\s*EnableReplayApi\s*=/im.test(cfg)) next = cfg.replace(/^\s*EnableReplayApi\s*=.*$/im, "EnableReplayApi=1");
    else if (/^\[General\]\s*$/im.test(cfg)) next = cfg.replace(/^\[General\]\s*$/im, (m) => `${m}\r\nEnableReplayApi=1`);
    else next = `[General]\r\nEnableReplayApi=1\r\n${cfg}`;
    await fs.writeFile(file, next);
  }

  /** Where the open replay is, if one is open. */
  async playback(): Promise<{ time: number; length: number; paused: boolean } | null> {
    try {
      const r = await request<{ time: number; length: number; paused: boolean }>("https://127.0.0.1:2999/replay/playback", { timeoutMs: 800 });
      return r.status === 200 && r.data ? r.data : null;
    } catch {
      return null;
    }
  }

  async state(matchId: string): Promise<ReplayState> {
    const open = await this.playback();
    if (open) return { kind: "open", ...open };
    const lock = await readLockfile(this.leagueDir);
    if (!lock) return { kind: "client-closed" };
    const enabled = await this.replayApiEnabled();
    try {
      const r = await request<{ state: string; downloadProgress?: number }>(
        `https://127.0.0.1:${lock.port}/lol-replays/v1/metadata/${gameIdOf(matchId)}`,
        { auth: lock.password },
      );
      const s = r.data?.state ?? "";
      if (s === "downloading") return { kind: "downloading", progress: r.data?.downloadProgress ?? 0 };
      if (s === "watch") return enabled ? { kind: "ready" } : { kind: "api-disabled" };
      if (s === "download") return { kind: "can-download" };
      if (s === "incompatible") return { kind: "unavailable", reason: "This replay is from an older patch, so League can't play it anymore." };
      if (s === "missingOrExpired") return { kind: "unavailable", reason: "Riot no longer has this replay." };
      return { kind: "unavailable", reason: s ? `League says: ${s}` : "League didn't report this replay." };
    } catch {
      return { kind: "client-closed" };
    }
  }

  /** GET a League client route. Null when the client is closed or the route fails. */
  async lcuGet<T>(route: string): Promise<T | null> {
    const lock = await readLockfile(this.leagueDir);
    if (!lock) return null;
    try {
      const r = await request<T>(`https://127.0.0.1:${lock.port}${route}`, { auth: lock.password, timeoutMs: 2500 });
      return r.status === 200 ? r.data : null;
    } catch {
      return null;
    }
  }

  /** Current gameflow phase ("InProgress", "EndOfGame", ...), or null when the client is closed. */
  async gameflowPhase(): Promise<string | null> {
    const lock = await readLockfile(this.leagueDir);
    if (!lock) return null;
    try {
      const r = await request<string>(`https://127.0.0.1:${lock.port}/lol-gameflow/v1/gameflow-phase`, { auth: lock.password, timeoutMs: 2500 });
      return r.status === 200 && typeof r.data === "string" ? r.data : null;
    } catch {
      return null;
    }
  }

  /** Raw replay state for a game id: "download", "downloading", "watch", "checking", "lost", ... */
  async replayMeta(gameId: string): Promise<{ state: string; downloadProgress?: number } | null> {
    return this.lcuGet(`/lol-replays/v1/metadata/${gameId}`);
  }

  private async lcu(method: string, route: string, body?: unknown) {
    const lock = await readLockfile(this.leagueDir);
    if (!lock) throw new Error("Open the League client first.");
    const r = await request(`https://127.0.0.1:${lock.port}${route}`, { method, auth: lock.password, body });
    if (r.status >= 400) throw new Error(`League client refused (${r.status}).`);
  }

  download(matchId: string) {
    return this.lcu("POST", `/lol-replays/v1/rofls/${gameIdOf(matchId)}/download`, { componentType: "league-coach" });
  }

  watch(matchId: string) {
    return this.lcu("POST", `/lol-replays/v1/rofls/${gameIdOf(matchId)}/watch`, { componentType: "league-coach" });
  }

  /** Seek the open replay (seconds) and play/pause it. */
  async seek(seconds: number, paused = false, speed = 1): Promise<boolean> {
    try {
      const r = await request("https://127.0.0.1:2999/replay/playback", { method: "POST", body: { time: Math.max(0, seconds), paused, speed } });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  /** Change replay speed without seeking. */
  async setSpeed(speed: number): Promise<void> {
    await request("https://127.0.0.1:2999/replay/playback", { method: "POST", body: { speed } }).catch(() => null);
  }

  async setPaused(paused: boolean): Promise<void> {
    await request("https://127.0.0.1:2999/replay/playback", { method: "POST", body: { paused } }).catch(() => null);
  }

  /** The replay's render settings (fog, interface toggles, ...), or null. */
  async getRender(): Promise<Record<string, unknown> | null> {
    const r = await request<Record<string, unknown>>("https://127.0.0.1:2999/replay/render", { timeoutMs: 1500 }).catch(() => null);
    return r?.status === 200 ? r.data : null;
  }

  async setRender(body: Record<string, unknown>): Promise<boolean> {
    const r = await request("https://127.0.0.1:2999/replay/render", { method: "POST", body, timeoutMs: 1500 }).catch(() => null);
    return !!r && r.status < 400;
  }

  /** POST /replay/playback with any of time, paused, speed. */
  async setPlayback(body: { time?: number; paused?: boolean; speed?: number }): Promise<{ time: number; length: number; paused: boolean; speed?: number } | null> {
    const r = await request<{ time: number; length: number; paused: boolean; speed?: number }>("https://127.0.0.1:2999/replay/playback", { method: "POST", body, timeoutMs: 1500 }).catch(() => null);
    return r?.status === 200 ? r.data : null;
  }

  /** Keyframed camera/playback sequence (smooth camera moves). An empty object clears it. */
  async setSequence(body: Record<string, unknown>): Promise<boolean> {
    const r = await request("https://127.0.0.1:2999/replay/sequence", { method: "POST", body, timeoutMs: 1500 }).catch(() => null);
    return !!r && r.status < 400;
  }

  /** /liveclientdata/allgamedata: answers during replays too, at the replay's current time. */
  /**
   * Closes the open replay window. Only ever a replay: the Replay API has to answer (it has no
   * playback in a live game) and the client must not report a game being played. League has no
   * route for leaving a replay, so the game process is asked to close, then ended if it is
   * still up 4 s later. Returns true when a replay was open and is gone.
   */
  async closeReplay(): Promise<boolean> {
    if (process.platform !== "win32") return false;
    if (!(await this.playback())) return false;
    const phase = await this.gameflowPhase();
    if (phase === "InProgress" || phase === "GameStart" || phase === "Reconnect") return false;
    const kill = (force: boolean) =>
      new Promise<void>((resolve) => execFile("taskkill", [...(force ? ["/F"] : []), "/IM", "League of Legends.exe"], { windowsHide: true }, () => resolve()));
    await kill(false);
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await this.playback())) return true;
    }
    await kill(true);
    await new Promise((r) => setTimeout(r, 1000));
    return !(await this.playback());
  }

  async liveData(): Promise<unknown | null> {
    const r = await request<unknown>("https://127.0.0.1:2999/liveclientdata/allgamedata", { timeoutMs: 1500 }).catch(() => null);
    return r?.status === 200 ? r.data : null;
  }

  /** The game id of whatever the client is running right now (a replay or a live game). */
  async currentGameId(): Promise<string | null> {
    const s = await this.lcuGet<{ gameData?: { gameId?: number } }>("/lol-gameflow/v1/session");
    return s?.gameData?.gameId ? String(s.gameData.gameId) : null;
  }

/**
   * Select a player by champion name and put the camera on them. Selecting and attaching alone
   * leaves a paused replay's camera where it was (checked on NA1_5686025956: after a seek to
   * 3:09 the attached top camera stayed on top lane, Smolder in bot); and the top camera ignores a
   * cameraPosition. So when the champion's map position `at` is known (from the scan), the
   * camera switches to the free camera framed on that point, the way the scan frames the map.
   * Best effort: ignored if unsupported.
   */
  async follow(championName: string, at?: { x: number; y: number }): Promise<void> {
    try {
      if (at) {
        await request("https://127.0.0.1:2999/replay/render", { method: "POST", body: { cameraMode: "fps", cameraAttached: false } });
        await request("https://127.0.0.1:2999/replay/render", { method: "POST", body: { ...cameraLookingAt(at, 2200, 56, 0), selectionName: championName, interfaceScoreboard: true } });
      } else await request("https://127.0.0.1:2999/replay/render", { method: "POST", body: { cameraAttached: true, selectionName: championName, interfaceScoreboard: true } });
    } catch {
      /* not critical */
    }
  }

  /**
   * Starts Riot's recorder writing PNG frames of [startSec, endSec] at `fps`, one file per
   * game frame step (frame k is game time startSec + k / fps). Riot puts the frames in a new
   * subfolder of `dir`. The caller drives playback. True when the recorder accepted it.
   */
  async startFrameRecording(dir: string, startSec: number, endSec: number, fps: number): Promise<boolean> {
    await fs.mkdir(dir, { recursive: true });
    const r = await request("https://127.0.0.1:2999/replay/recording", {
      method: "POST",
      body: { recording: true, path: dir, codec: "png", startTime: startSec, endTime: endSec, currentTime: startSec, framesPerSecond: fps, enforceFrameRate: true, lossless: true, replaySpeed: 1 },
      timeoutMs: 3000,
    }).catch(() => null);
    return !!r && r.status < 400;
  }

  async stopRecording(): Promise<void> {
    await request("https://127.0.0.1:2999/replay/recording", { method: "POST", body: { recording: false }, timeoutMs: 3000 }).catch(() => null);
  }

  /** The recorder's state, or null when the Replay API doesn't answer. */
  async recordingState(): Promise<{ recording: boolean; currentTime?: number; path?: string; width?: number; height?: number } | null> {
    const r = await request<{ recording: boolean; currentTime?: number; path?: string; width?: number; height?: number }>("https://127.0.0.1:2999/replay/recording", { timeoutMs: 1500 }).catch(() => null);
    return r?.status === 200 ? r.data : null;
  }

  /**
   * Records [startSec, endSec] of the open replay to a .webm in `dir` using the
   * Replay API's built-in recorder. Resolves with the new file's path, or null.
   */
  async recordClip(startSec: number, endSec: number, dir: string, isCancelled: () => boolean = () => false): Promise<string | null> {
    await fs.mkdir(dir, { recursive: true });
    const before = new Set(await fs.readdir(dir).catch(() => [] as string[]));
    await this.seek(startSec, true);
    const r = await request("https://127.0.0.1:2999/replay/recording", {
      method: "POST",
      body: {
        recording: true,
        path: dir,
        codec: "webm",
        startTime: startSec,
        endTime: endSec,
        currentTime: startSec,
        framesPerSecond: 30,
        enforceFrameRate: true,
        lossless: false,
        replaySpeed: 1,
      },
    }).catch(() => null);
    if (!r || r.status >= 400) return null;
    await this.seek(startSec, false);
    // Wait for the recorder to finish (real time, plus some slack).
    const deadline = Date.now() + (endSec - startSec + 30) * 1000;
    while (Date.now() < deadline && !isCancelled()) {
      await new Promise((res) => setTimeout(res, 1000));
      const st = await request<{ recording: boolean }>("https://127.0.0.1:2999/replay/recording").catch(() => null);
      if (st?.data && st.data.recording === false) break;
    }
    const after = await fs.readdir(dir).catch(() => [] as string[]);
    const fresh = after.filter((f) => !before.has(f) && /\.webm$/i.test(f));
    return fresh.length ? path.join(dir, fresh[fresh.length - 1]) : null;
  }
}
