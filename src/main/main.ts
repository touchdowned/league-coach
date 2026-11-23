import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { buildReport } from "../core/analysis";
import { applyEvent, EMPTY_PROGRESS, ProgressEvent, ProgressState } from "../core/progress";
import { parseRiotId, RiotClient, SR_QUEUES } from "../core/riot";
import type { GameReport } from "../core/types";
import { gameIdOf, LeagueClient } from "./league";
import { PostGameWatcher } from "./postgame";
import { scanReplay } from "./scan";
import type { WaveTrack } from "../core/waves";
import { JsonStore, Settings } from "./store";
import { listVods, matchVod } from "./vod";

let win: BrowserWindow | null = null;
let store: JsonStore;
let reports: GameReport[] = [];
let progressState: ProgressState = EMPTY_PROGRESS;
let recordingCancelled = false;
let scanCancelled = false;
const wavesFile = (matchId: string) => `waves-${matchId.replace(/[^A-Za-z0-9_]/g, "")}.json`;
let watcher: PostGameWatcher | null = null;
// Started at Windows sign-in: stay hidden until a review is ready.
const startHidden = process.argv.includes("--hidden");

// One copy only, so a second launch (or launch at sign-in plus a manual open) doesn't
// run two game watchers.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => focusWindow());

// Local media (recorded clips, linked VODs) is served through lcmedia://file/<encoded path>
// so the sandboxed page never gets general file access.
protocol.registerSchemesAsPrivileged([{ scheme: "lcmedia", privileges: { stream: true, supportFetchAPI: true, standard: true, secure: true } }]);
const allowedMedia = new Set<string>();
const mediaUrl = (p: string) => {
  allowedMedia.add(path.resolve(p));
  return `lcmedia://file/${encodeURIComponent(p)}`;
};

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0a0d13",
    title: "League Coach",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../../build/icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => !startHidden && win?.show());
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // Windows may refuse to move focus from another app; flash the taskbar button instead.
  if (!win.isFocused()) win.flashFrame(true);
}

function applyLoginItem(s: Settings) {
  if (process.platform !== "win32" && process.platform !== "darwin") return;
  app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin, args: ["--hidden"] });
}

let syncing: Promise<GameReport[]> | null = null;
/** Shared so a manual sync and the post-game sync never run at the same time. */
function sync(): Promise<GameReport[]> {
  syncing ??= runSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function matchPublished(gameId: string): Promise<boolean> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings so games can sync.");
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());
  const ids = await riot.getMatchIds(await riot.getPuuid(gameName, tagLine), 5);
  return ids.some((id) => gameIdOf(id) === gameId);
}

async function runSync(): Promise<GameReport[]> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings first.");
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());

  send("sync:progress", { done: 0, total: 1, label: "Finding your account" });
  const puuid = await riot.getPuuid(gameName, tagLine);
  const ids = await riot.getMatchIds(puuid, s.matchCount);

  const out: GameReport[] = [];
  for (let i = 0; i < ids.length; i++) {
    send("sync:progress", { done: i, total: ids.length, label: `Analyzing game ${i + 1} of ${ids.length}` });
    const match = await riot.getMatch(ids[i]);
    if (!SR_QUEUES.includes(match.info.queueId) || match.info.gameDuration < 600) continue; // skip ARAM, remakes
    const timeline = await riot.getTimeline(ids[i]);
    const waves = await store.readJson<WaveTrack | null>(wavesFile(ids[i]), null);
    out.push(buildReport(match, timeline, puuid, waves ?? undefined));
  }
  send("sync:progress", { done: ids.length, total: ids.length, label: "Done" });
  reports = out.sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation);
  await store.writeReports(reports);
  return reports;
}

async function league() {
  return new LeagueClient((await store.readSettings()).leagueDir);
}

const clipDir = (matchId: string) => path.join(app.getPath("userData"), "clips", matchId);

async function listClips(matchId: string): Promise<Record<string, string>> {
  const dir = clipDir(matchId);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Record<string, string> = {};
  for (const f of files) {
    const m = f.match(/^(\d+)\.webm$/);
    if (m) out[m[1]] = mediaUrl(path.join(dir, f));
  }
  return out;
}

/** Records a short clip around each moment from the open replay, one after another. */
async function recordClips(matchId: string, moments: number[]): Promise<Record<string, string>> {
  const lc = await league();
  const pb = await lc.playback();
  if (!pb) throw new Error("Open this game's replay first.");
  recordingCancelled = false;
  const dir = clipDir(matchId);
  const existing = await listClips(matchId);
  const todo = moments.filter((t) => !existing[String(t)]);
  for (let i = 0; i < todo.length && !recordingCancelled; i++) {
    const t = todo[i] / 1000;
    send("clips:progress", { done: i, total: todo.length, label: `Recording clip ${i + 1} of ${todo.length}` });
    const file = await lc.recordClip(Math.max(0, t - 15), Math.min(pb.length, t + 4), dir, () => recordingCancelled);
    if (file) await fs.rename(file, path.join(dir, `${todo[i]}.webm`)).catch(() => undefined);
  }
  send("clips:progress", { done: todo.length, total: todo.length, label: "Done" });
  return listClips(matchId);
}

/** Plays this game's replay, reads minions off the minimap, and re-reads the game with them. */
async function readReplay(matchId: string): Promise<GameReport> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings first.");
  scanCancelled = false;
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());
  const puuid = await riot.getPuuid(gameName, tagLine);
  const match = await riot.getMatch(matchId);
  const players = match.info.participants.map((p) => ({ id: p.participantId, champion: p.championName, teamId: p.teamId }));
  const meP = match.info.participants.find((p) => p.puuid === puuid);
  if (!meP) throw new Error("You're not in this game.");
  const me = { id: meP.participantId, champion: meP.championName, teamId: meP.teamId };
  const waves = await scanReplay(await league(), matchId, (p) => send("scan:progress", p), () => scanCancelled, players, me);
  if (waves.samples.length < 20) throw new Error("Couldn't read enough of the minimap. Keep the replay visible on your main monitor while it reads.");
  await store.writeJson(wavesFile(matchId), waves);
  const report = buildReport(match, await riot.getTimeline(matchId), puuid, waves);
  reports = reports.map((r) => (r.metrics.matchId === matchId ? report : r));
  await store.writeReports(reports);
  focusWindow();
  return report;
}

function handle<T>(channel: string, fn: (...args: any[]) => Promise<T> | T) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

app.whenReady().then(async () => {
  store = new JsonStore(app.getPath("userData"));
  // Reports saved by an older version may lack newer fields; drop those so the UI never sees them.
  reports = (await store.readReports<GameReport>()).filter((r) => Array.isArray(r.series) && r.mistakes.every((m) => "context" in m));
  progressState = await store.readJson("progress.json", EMPTY_PROGRESS);

  protocol.handle("lcmedia", (req) => {
    const p = path.resolve(decodeURIComponent(new URL(req.url).pathname.replace(/^\//, "")));
    if (!allowedMedia.has(p)) return new Response("Not allowed", { status: 403 });
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
  });

  ipcMain.handle("settings:get", () => store.readSettings());
  ipcMain.handle("settings:set", async (_e, s: Settings) => {
    await store.writeSettings(s);
    applyLoginItem(s);
  });
  ipcMain.handle("games:sync", async () => {
    try {
      return { ok: true, reports: await sync() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("games:list", () => reports);

  // Progress / feedback loop
  ipcMain.handle("progress:get", () => progressState);
  ipcMain.handle("progress:event", async (_e, ev: ProgressEvent) => {
    const r = applyEvent(progressState, ev);
    progressState = r.state;
    await store.writeJson("progress.json", progressState);
    return r;
  });

  // League client replays
  handle("replay:state", async (matchId: string) => (await league()).state(matchId));
  handle("replay:download", async (matchId: string) => (await league()).download(matchId));
  handle("replay:watch", async (matchId: string) => (await league()).watch(matchId));
  handle("replay:seek", async (sec: number, paused: boolean) => (await league()).seek(sec, paused));
  handle("replay:follow", async (champ: string) => (await league()).follow(champ));
  handle("replay:enableApi", async () => (await league()).enableReplayApi());
  handle("replay:read", (matchId: string) => readReplay(matchId));
  handle("replay:readCancel", () => {
    scanCancelled = true;
  });
  handle("clips:list", (matchId: string) => listClips(matchId));
  handle("clips:record", (matchId: string, moments: number[]) => recordClips(matchId, moments));
  handle("clips:cancel", () => {
    recordingCancelled = true;
  });

  // Recorded VODs (mp4 etc.)
  handle("vod:find", async (matchId: string) => {
    const s = await store.readSettings();
    const links = await store.readJson<Record<string, string>>("vod-links.json", {});
    if (links[matchId]) return { url: mediaUrl(links[matchId]), name: path.basename(links[matchId]) };
    if (!s.vodDir) return null;
    const r = reports.find((x) => x.metrics.matchId === matchId);
    if (!r) return null;
    const f = matchVod(await listVods(s.vodDir), matchId, r.metrics.gameCreation, r.metrics.durationMin * 60);
    return f ? { url: mediaUrl(f.path), name: f.name } : null;
  });
  handle("vod:pick", async (matchId: string) => {
    const res = await dialog.showOpenDialog(win!, { title: "Pick the recording of this game", filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov"] }], properties: ["openFile"] });
    if (res.canceled || !res.filePaths[0]) return null;
    const links = await store.readJson<Record<string, string>>("vod-links.json", {});
    links[matchId] = res.filePaths[0];
    await store.writeJson("vod-links.json", links);
    return { url: mediaUrl(res.filePaths[0]), name: path.basename(res.filePaths[0]) };
  });
  handle("folder:pick", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });

  // After each ranked game: sync, open the review, download the replay.
  watcher = new PostGameWatcher({
    settings: () => store.readSettings(),
    league,
    matchPublished,
    sync,
    status: (st) => send("postgame:status", st),
    openReview: (matchId) => {
      send("postgame:open", matchId);
      focusWindow();
      if (Notification.isSupported() && !win?.isFocused()) {
        const n = new Notification({ title: "Your review is ready", body: "League Coach opened the review for the game you just played." });
        n.on("click", focusWindow);
        n.show();
      }
    },
  });
  handle("postgame:status", () => watcher?.status);
  applyLoginItem(await store.readSettings());

  Menu.setApplicationMenu(null);
  createWindow();
  watcher.start();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("before-quit", () => watcher?.stop());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
