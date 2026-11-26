import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, Notification, protocol, screen, globalShortcut } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { buildReport } from "../core/analysis";
import { applyEvent, EMPTY_PROGRESS, ProgressEvent, ProgressState } from "../core/progress";
import { parseRiotId, participantByRiotId, RiotApiError, RiotClient, SR_QUEUES } from "../core/riot";
import type { GameReport, MatchDto } from "../core/types";
import { gameIdOf, LeagueClient } from "./league";
import { PostGameWatcher } from "./postgame";
import { openReplay, scanReplay, trackChampions } from "./scan";
import { champKey, checkAllies, checkCs, checkFogOff, checkItems, checkLevels, checkPositions, invChanges } from "../core/telemetry";
import { checkGold, itemTable, type ItemTable } from "../core/gold";
import { checkWards, placeWards } from "../core/wards";
import { checkFlash, checkHud } from "../core/hud";
import { growBench, readBench } from "./bench";
import { champPosAt, type ChampSample, type WaveTrack } from "../core/waves";
import { cameraLookingAt } from "../core/camera";
import { JsonStore, Settings } from "./store";
import { ReadQueue, shortRead, WATCH_PHASE, type PendingRead } from "../core/autoread";
import { computeFocus, FOCUS_DEFS, type Focus, type FocusState } from "../core/focus";
import { listVods, matchVod } from "./vod";
import { startAutoUpdates } from "./updater";
import { MindService } from "./mind";

// Keep settings, the API key and saved games in %APPDATA%\league-coach no matter how the app
// was installed (dev run, old packaged copy, or the auto-updating installer).
app.setPath("userData", path.join(app.getPath("appData"), "league-coach"));

let win: BrowserWindow | null = null;
let store: JsonStore;
let reports: GameReport[] = [];
let progressState: ProgressState = EMPTY_PROGRESS;
let recordingCancelled = false;
let scanCancelled = false;
const wavesFile = (matchId: string) => `waves-${matchId.replace(/[^A-Za-z0-9_]/g, "")}.json`;
let watcher: PostGameWatcher | null = null;
let mind: MindService | null = null;
// Started at Windows sign-in: stay hidden until a review is ready.
const startHidden = process.argv.includes("--hidden");

// One copy only, so a second launch (or launch at sign-in plus a manual open) doesn't
// run two game watchers.
// (A verification run is a separate tool and may run next to the app.)
if (!process.argv.includes("--verify-scan") && !app.requestSingleInstanceLock()) app.quit();
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
    backgroundColor: "#fbfaf7",
    title: "League Coach",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../../build/icon.png"),
    // No system title bar: the app draws its own top edge and Windows draws only its three buttons over it.
    ...(process.platform === "win32" ? { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#fbfaf7", symbolColor: "#4a473f", height: 34 } } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => !startHidden && win?.show());
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

// ---- Coaching overlay: a transparent, click-through window over the League replay ----
let overlay: BrowserWindow | null = null;
let overlayMatch: string | null = null;
let overlayRender: Record<string, unknown> | null = null;
let overlayRects: { x: number; y: number; w: number; h: number }[] = [];
let overlayHit: ReturnType<typeof setInterval> | null = null;
let overlayModalOn = false;
/** Whether the overlay takes the mouse now, as last set by the cursor poll; null makes the poll set it again. */
let overlayTaking: boolean | null = null;
let overlayKeys: string[] = [];
/** A question is waiting: the overlay takes the whole mouse, and these keys from anywhere. */
function setOverlayModal(on: boolean, keys: string[]) {
  for (const k of overlayKeys) globalShortcut.unregister(k);
  overlayModalOn = on && !!overlay;
  overlayKeys = overlayModalOn ? keys.filter((k) => /^([1-4]|Return)$/.test(k)) : [];
  for (const k of overlayKeys) globalShortcut.register(k, () => overlay?.webContents.send("overlay:key", k));
}

/**
 * A replay runs a few seconds longer than the game it shows (1900.98 s for a 1895 s game), so the
 * open replay is this game's when the two lengths are within SAME_GAME_SEC. The client's
 * gameflow session doesn't name the game while a replay plays.
 */
const SAME_GAME_SEC = 20;
function sameGame(matchId: string, replayLength: number): boolean {
  const r = reports.find((x) => x.metrics.matchId === matchId);
  return !r || Math.abs(r.metrics.durationMin * 60 - replayLength) <= SAME_GAME_SEC;
}

let overlayWatch: ReturnType<typeof setInterval> | null = null;

async function openOverlay(matchId: string, route = `overlay/${encodeURIComponent(matchId)}`) {
  overlayRender = await (await league()).getRender();
  overlay?.destroy();
  overlayMatch = matchId;
  // League runs borderless on the primary display; cover it edge to edge.
  const d = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    ...d.bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    title: "League Coach overlay",
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true, { forward: true });
  // Take the mouse only over our own panels (or everywhere while a question waits). The cursor
  // is polled: with the League window active under an ignored window, no mouse-enter arrives.
  overlayRects = [];
  setOverlayModal(false, []);
  overlayTaking = false;
  if (overlayHit) clearInterval(overlayHit);
  overlayHit = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = overlay.getBounds();
    const [x, y] = [c.x - b.x, c.y - b.y];
    const want = overlayModalOn || overlayRects.some((r) => x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4);
    if (want === overlayTaking) return;
    overlayTaking = want;
    if (want) overlay.setIgnoreMouseEvents(false);
    else overlay.setIgnoreMouseEvents(true, { forward: true });
  }, 40);
  overlay.setVisibleOnAllWorkspaces(true);
  const dev = process.env.VITE_DEV_SERVER_URL;
  const hash = route;
  if (dev) overlay.loadURL(`${dev}#${hash}`);
  else overlay.loadFile(path.join(__dirname, "../../dist-renderer/index.html"), { hash });
  overlay.once("ready-to-show", () => overlay?.showInactive());
  const self = overlay;
  overlay.on("closed", () => {
    // However it closed (closeOverlay, a crash, a newer overlay replacing it): no poll and no
    // answer keys left behind, or 1-4 would stay taken from every other app.
    if (overlay !== self) return;
    overlay = null;
    if (overlayHit) clearInterval(overlayHit);
    overlayHit = null;
    overlayRects = [];
    setOverlayModal(false, []);
  });
  win?.minimize();
  // The overlay sits over the replay window: when the replay closes (or another game's replay
  // takes its place) there is nothing under it, so it closes itself and the app comes back.
  if (overlayWatch) clearInterval(overlayWatch);
  let misses = 0;
  overlayWatch = setInterval(async () => {
    if (!overlay || overlayMatch !== matchId) return;
    const pb = await (await league()).playback().catch(() => null);
    misses = pb && sameGame(matchId, pb.length) ? 0 : misses + 1;
    // Three misses in a row (6 s): a seek or a loading hitch answers again well within that.
    if (misses >= 3) {
      void closeOverlay(false, true);
    }
  }, 2000);
}

/**
 * The open replay's game (by length, see SAME_GAME_SEC) and champion `champ` in it: that game's
 * scanned champion reads and the champion's participant id. Null when no synced game fits or it
 * has no scan.
 */
async function followTrack(replayLength: number, champ: string): Promise<{ champs: ChampSample[]; pid: number } | null> {
  let id: string | null = null;
  let best = Infinity;
  for (const r of reports) {
    const d = Math.abs(r.metrics.durationMin * 60 - replayLength);
    if (d <= SAME_GAME_SEC && d < best) {
      best = d;
      id = r.metrics.matchId;
    }
  }
  if (!id) return null;
  const waves = await store.readJson<WaveTrack | null>(wavesFile(id), null);
  const match = (await store.cache().get(`match-${id}`)) as MatchDto | null | undefined;
  const pid = match?.info.participants.find((p) => champKey(p.championName) === champKey(champ))?.participantId;
  return waves?.champs && pid ? { champs: waves.champs, pid } : null;
}

/**
 * Keeps the camera on a champion while the replay plays. An attached camera loses its selection
 * a few seconds into play (League's directed camera takes over: on NA1_5686025956 from 3:09 the
 * selection cleared after ~4 s and the camera went to other lanes), so every FOLLOW_MS the free
 * camera is put on the champion's scanned position at the replay's time (interpolated between
 * reads, see champPosAt). With no read within 3 s (not scanned, dead, in base) the attached top
 * camera is selected on them again once a second instead. Paused: nothing moves. Stops on
 * stopFollow (the card or walkthrough closes, the overlay closes) or when the replay is lost.
 */
const FOLLOW_MS = 250;
const FOLLOW_TOP_MS = 1000;
let followLoop: ReturnType<typeof setInterval> | null = null;
function stopFollow() {
  if (followLoop) clearInterval(followLoop);
  followLoop = null;
}
async function startFollow(champ: string): Promise<void> {
  stopFollow();
  const lc = await league();
  const first = await lc.playback();
  if (!first) return;
  const track = await followTrack(first.length, champ);
  let mode: "free" | "top" | null = null;
  let lastTop = 0;
  let misses = 0;
  let busy = false;
  const step = async (force: boolean) => {
    const pb = await lc.playback();
    // Lost: 3 s without an answer, or another game's replay took its place.
    if (!pb || Math.abs(pb.length - first.length) > SAME_GAME_SEC) {
      if (++misses * FOLLOW_MS >= 3000) stopFollow();
      return;
    }
    misses = 0;
    if (pb.paused && !force) return;
    const at = track ? champPosAt(track.champs, track.pid, pb.time * 1000) : undefined;
    if (at) {
      if (mode !== "free") await lc.setRender({ cameraMode: "fps", cameraAttached: false });
      mode = "free";
      await lc.setRender({ ...cameraLookingAt(at, 2200, 56, 0), selectionName: champ });
    } else if (mode !== "top" || Date.now() - lastTop >= FOLLOW_TOP_MS) {
      mode = "top";
      lastTop = Date.now();
      await lc.setRender({ cameraMode: "top", cameraAttached: true, selectionName: champ });
    }
  };
  const id = setInterval(async () => {
    if (busy || followLoop !== id) return;
    busy = true;
    try {
      await step(false);
    } finally {
      busy = false;
    }
  }, FOLLOW_MS);
  followLoop = id;
  await step(true);
}

async function closeOverlay(finished: boolean, lost = false) {
  const matchId = overlayMatch;
  if (overlayHit) clearInterval(overlayHit);
  overlayHit = null;
  setOverlayModal(false, []);
  stopFollow();
  if (overlayWatch) clearInterval(overlayWatch);
  overlayWatch = null;
  // Put League's camera, fog and HUD back the way they were.
  const lc = await league();
  await lc.setPaused(true);
  if (overlayRender) await lc.setRender(overlayRender);
  overlayRender = null;
  overlay?.destroy();
  overlay = null;
  overlayMatch = null;
  if (matchId) send("overlay:closed", { matchId, finished, lost });
  // A walkthrough watched to the end is done with the replay.
  if (finished && !lost) await lc.closeReplay().catch(() => false);
  focusWindow();
}

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
  syncing.then(() => void growBenchInBackground()).catch(() => undefined);
  return syncing;
}

let growing = false;
/** After each sync, add a few Master+ games for your roles to the benchmark set. */
async function growBenchInBackground() {
  if (growing) return;
  growing = true;
  try {
    const s = await store.readSettings();
    if (!s.apiKey) return;
    const counts = new Map<string, number>();
    for (const r of reports.slice(0, 20)) counts.set(r.metrics.role, (counts.get(r.metrics.role) ?? 0) + 1);
    const roles = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r) as GameReport["metrics"]["role"][];
    // No cache: high-elo timelines are only needed once, then reduced to a few numbers.
    const added = await growBench(store, new RiotClient(s.apiKey.trim(), s.region), roles, 8);
    if (added) send("bench:updated", added);
  } catch {
    /* benchmarks are optional; try again next sync */
  } finally {
    growing = false;
  }
}

async function matchPublished(gameId: string): Promise<boolean> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings so games can sync.");
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());
  const ids = await riot.getMatchIds(await riot.getPuuid(gameName, tagLine), 5);
  return ids.some((id) => gameIdOf(id) === gameId);
}

/** Set by the last sync when it could only use what was on disk. */
let syncWarning: string | null = null;

/**
 * Reports for every game whose match and timeline are in the disk cache and that the player
 * (by Riot ID name) took part in. Needs no network: used when the API key no longer works.
 */
async function offlineReports(gameName: string): Promise<GameReport[]> {
  const cache = store.cache();
  const keys = await store.cacheKeys();
  const ids = keys.filter((k) => k.startsWith("match-") && keys.includes(`timeline-${k.slice(6)}`)).map((k) => k.slice(6));
  const name = gameName.trim().toLowerCase();
  const out: GameReport[] = [];
  for (let i = 0; i < ids.length; i++) {
    send("sync:progress", { done: i, total: ids.length, label: `Reading saved game ${i + 1} of ${ids.length}` });
    const match = (await cache.get(`match-${ids[i]}`)) as import("../core/types").MatchDto | undefined;
    const timeline = (await cache.get(`timeline-${ids[i]}`)) as import("../core/types").TimelineDto | undefined;
    if (!match?.info?.participants || !timeline?.info?.frames) continue;
    if (!SR_QUEUES.includes(match.info.queueId) || match.info.gameDuration < 600) continue;
    const me = match.info.participants.find((p) => (p.riotIdGameName ?? "").trim().toLowerCase() === name);
    if (!me) continue;
    const waves = await savedWaves(ids[i]);
    // Item prices come from the per-patch cache; a patch never fetched leaves the item lines out.
    const items = waves ? await itemsFor(match.info.gameVersion).catch(() => undefined) : undefined;
    out.push(buildReport(match, timeline, me.puuid, waves ?? undefined, items));
  }
  return out.sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation);
}

async function runSync(): Promise<GameReport[]> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings first.");
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());

  send("sync:progress", { done: 0, total: 1, label: "Finding your account" });
  syncWarning = null;
  let puuid: string;
  let ids: string[];
  try {
    puuid = await riot.getPuuid(gameName, tagLine);
    ids = await riot.getMatchIds(puuid, s.matchCount);
  } catch (err) {
    // An expired key can't list games, but every game already downloaded is still on disk.
    if (!(err instanceof RiotApiError) || (err.status !== 401 && err.status !== 403)) throw err;
    const offline = await offlineReports(gameName);
    if (!offline.length) throw err;
    syncWarning = `Your Riot API key has expired, so no new games were fetched. Showing the ${offline.length} game${offline.length > 1 ? "s" : ""} already on this PC. Paste a fresh key in Settings to fetch new ones.`;
    send("sync:progress", { done: 1, total: 1, label: "Done" });
    reports = offline;
    await store.writeReports(reports);
    return reports;
  }

  const out: GameReport[] = [];
  for (let i = 0; i < ids.length; i++) {
    send("sync:progress", { done: i, total: ids.length, label: `Analyzing game ${i + 1} of ${ids.length}` });
    const match = await riot.getMatch(ids[i]);
    if (!SR_QUEUES.includes(match.info.queueId) || match.info.gameDuration < 600) continue; // skip ARAM, remakes
    const timeline = await riot.getTimeline(ids[i]);
    const waves = await savedWaves(ids[i]);
    out.push(buildReport(match, timeline, puuid, waves ?? undefined, waves ? await itemsFor(match.info.gameVersion) : undefined));
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
/** A game's saved replay read. One that stopped early doesn't count: the game shows as unread and is read again. */
async function savedWaves(id: string): Promise<WaveTrack | null> {
  const waves = await store.readJson<WaveTrack | null>(wavesFile(id), null);
  return waves && !shortRead(waves.scanInfo) ? waves : null;
}

async function readReplay(matchId: string, focus = true): Promise<GameReport> {
  const s = await store.readSettings();
  scanCancelled = false;
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());
  // Match and timeline come from the cache after a sync, so an expired key doesn't stop a read.
  // You're found by Riot ID in the match; the key is only needed if that fails.
  const match = await riot.getMatch(matchId);
  const players = match.info.participants.map((p) => ({ id: p.participantId, champion: p.championName, teamId: p.teamId }));
  let meP = participantByRiotId(match.info.participants as (MatchDto["info"]["participants"][number] & { riotIdTagline?: string })[], gameName, tagLine);
  let puuid = meP?.puuid;
  if (!meP) {
    if (!s.apiKey) throw new Error("Add your Riot API key in Settings first.");
    puuid = await riot.getPuuid(gameName, tagLine);
    meP = match.info.participants.find((p) => p.puuid === puuid);
  }
  if (!meP || !puuid) throw new Error("You're not in this game.");
  const me = { id: meP.participantId, champion: meP.championName, teamId: meP.teamId };
  const waves = await scanReplay(await league(), matchId, (p) => send("scan:progress", p), () => scanCancelled, players, me);
  if (waves.samples.length < 20) throw new Error("Couldn't read enough of the minimap. Keep the replay visible on your main monitor while it reads.");
  const short = shortRead(waves.scanInfo);
  if (short) throw new Error(`The replay read stopped early (${short}), so it wasn't saved. Keep League in front while it reads; it will be tried again.`);
  await store.writeJson(wavesFile(matchId), waves);
  const report = buildReport(match, await riot.getTimeline(matchId), puuid, waves, await itemsFor(match.info.gameVersion));
  reports = reports.map((r) => (r.metrics.matchId === matchId ? report : r));
  await store.writeReports(reports);
  if (focus) focusWindow();
  return report;
}

// ---- Reading replays by itself, and the one focus that comes out of them ----
const readQueue = new ReadQueue();
let autoReading: string | null = null;
const autoStatus = (matchId: string, stage: "reading" | "done" | "waiting" | "failed", label: string) => send("autoread:status", { matchId, stage, label });

/** Called with every observed client phase. Starts the next waiting read, or calls one off. */
async function autoReadTick(phase: string | null) {
  if (readQueue.mustCancel(phase) && autoReading) {
    scanCancelled = true;
    return;
  }
  if (!readQueue.pending.length) return;
  if (!(await store.readSettings()).autoRead) return;
  // The client reports phase "None" while a replay is open, so the replay itself is asked.
  const replayOpen = !!(await (await league()).playback());
  const matchId = readQueue.next(replayOpen ? WATCH_PHASE : phase, Date.now());
  if (matchId) void runAutoRead(matchId);
}

async function runAutoRead(matchId: string) {
  let outcome: "done" | "later" | "retry" | "drop" = "later";
  let opened = false;
  try {
    const r = reports.find((x) => x.metrics.matchId === matchId);
    if (!r) return void (outcome = "drop");
    if (Array.isArray(r.findings)) return void (outcome = "done");
    const lc = await league();
    const st = await lc.state(matchId);
    // A replay the player opened is theirs: wait for it to close.
    if (st.kind === "open" || st.kind === "client-closed") return;
    if (st.kind === "unavailable" || st.kind === "api-disabled") {
      outcome = "drop";
      return void autoStatus(matchId, "failed", st.kind === "unavailable" ? st.reason : "Turn on replay control in Settings so replays can be read by themselves.");
    }
    autoReading = matchId;
    opened = true;
    outcome = "retry";
    autoStatus(matchId, "reading", "Reading your replay. It closes by itself when it's done.");
    // League has to be in front while it reads: step aside and say so outside the app.
    win?.minimize();
    if (Notification.isSupported()) new Notification({ title: "Reading your replay", body: "League plays it by itself for a few minutes, then closes it. Queue up any time and it stops." }).show();
    const report = await readReplay(matchId, false);
    outcome = "done";
    await currentFocus().catch(() => undefined);
    send("games:updated", report);
    autoStatus(matchId, "done", report.findings?.length ? `Replay read: ${report.findings.length} moments measured.` : "Replay read.");
  } catch (err) {
    const off = scanCancelled;
    if (off) outcome = "later";
    autoStatus(matchId, off ? "waiting" : "failed", off ? "Replay reading paused while you play. It picks up again after." : (err as Error).message);
  } finally {
    autoReading = null;
    if (opened) await (await league()).closeReplay().catch(() => false);
    readQueue.finish(matchId, outcome, Date.now());
    await store.writeJson("pending-reads.json", readQueue.pending);
  }
}

/** The focus as last computed, for the champ select card. */
let lastFocus: Focus | null = null;
async function currentFocus() {
  const saved = await store.readJson<FocusState | null>("focus.json", null);
  const res = computeFocus(reports, saved);
  if (JSON.stringify(res.state) !== JSON.stringify(saved)) await store.writeJson("focus.json", res.state);
  lastFocus = res.focus;
  return { focus: res.focus, moved: res.moved ? FOCUS_DEFS[res.moved].title : null };
}

/**
 * Module 1 verification run: `League Coach --verify-scan <matchId> [--until <sec>] [--out <dir>]`.
 * Opens the replay, does a full read with frame dumps, checks every stream against
 * Riot's exact events, writes verify-<matchId>.json, and quits.
 */
async function verifyScan(matchId: string, untilSec: number, outDir: string, reuse = false) {
  const s = await store.readSettings();
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());
  // Match and timeline come from the cache when they're there, so a re-run needs no live
  // API key. You're found by Riot ID in the match; the key is only asked for if that fails.
  const match = await riot.getMatch(matchId);
  const timeline = await riot.getTimeline(matchId);
  const players = match.info.participants.map((p) => ({ id: p.participantId, champion: p.championName, teamId: p.teamId }));
  const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  let meP = match.info.participants.find((p) => same(p.riotIdGameName, gameName) && same((p as { riotIdTagline?: string }).riotIdTagline, tagLine));
  if (!meP) {
    const puuid = await riot.getPuuid(gameName, tagLine);
    meP = match.info.participants.find((p) => p.puuid === puuid);
  }
  if (!meP) throw new Error("You're not in this match.");
  const me = { id: meP.participantId, champion: meP.championName, teamId: meP.teamId };
  const t0 = Date.now();
  // --reuse: re-run the checks on the last scan's file, no replay needed.
  let waves = reuse ? await store.readJson<WaveTrack | null>(wavesFile(matchId), null) : null;
  if (!waves) {
    const lc = await league();
    await openReplay(lc, matchId, (l) => console.log(l));
    const debugDir = path.join(outDir, `frames-${matchId}`);
    waves = await scanReplay(lc, matchId, (p) => console.log(p.label), () => false, players, me, untilSec, debugDir);
    await store.writeJson(wavesFile(matchId), waves);
  }
  // --reuse --offstep N: keep only every Nth fog-off frame (what a 2/N fps pass would have read).
  // --reuse --reprocess: re-run champion tracking on the stored raw reads (with --offstep, always).
  const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
  const offStep = Number(arg("--offstep") ?? 1);
  if (reuse && waves.champsRaw && (process.argv.includes("--reprocess") || offStep > 1)) {
    const firstOff = waves.samples[0]?.t ?? 0;
    const offMs = 1000 / (waves.scanInfo?.passes?.find((p) => p.fog === "off")?.fps ?? 2);
    const keep = (t: number) => Math.round((t - firstOff) / offMs) % offStep === 0;
    const champs = (JSON.parse(JSON.stringify(waves.champsRaw)) as ChampSample[]).filter((c) => c.fog !== "off" || keep(c.t));
    const tracking = trackChampions(champs, players, me, (waves.live ?? []).filter((_, i) => i % offStep === 0));
    // A pass at 1/N the frame rate runs N times faster in game time, so Live Client gets 1/N the polls per game second.
    const live = (waves.live ?? []).filter((_, i) => i % offStep === 0);
    waves = { ...waves, champs, live, samples: waves.samples.filter((s) => keep(s.t)), hud: (waves.hud ?? []).filter((h) => keep(h.t)) };
    console.log(`reprocessed: off step ${offStep}, ${JSON.stringify(tracking)}`);
  }
  const wallSec = Math.round((Date.now() - t0) / 1000);
  // Item prices and recipes for the gold estimate, from the Data Dragon version of this patch.
  const items = (await itemsFor(match.info.gameVersion))!;
  // Only judge what was actually read: a pass that stopped early shouldn't fail on frames it never saw.
  const until = Math.min(untilSec * 1000, waves.scanInfo?.lastFrame || untilSec * 1000);
  const events = timeline.info.frames.flatMap((f) => f.events ?? []);
  const champOf = (id: number) => players.find((p) => p.id === id)?.champion ?? "";
  const polls = waves.live ?? [];
  const changes = invChanges(polls);
  const allies = players.filter((p) => p.teamId === me.teamId).map((p) => p.id);
  const aliveAt = (id: number, t: number) => {
    let best = null as (typeof polls)[number] | null;
    for (const p of polls) if (p.t <= t && (!best || p.t > best.t)) best = p;
    const lp = best?.players.find((x) => champKey(x.championName) === champKey(champOf(id)));
    return !lp?.isDead;
  };
  // Frame times are from + k / fps: they're only right if each pass gave the frames its span implies.
  const framesCheck = {
    name: "scan: frames per pass vs game time covered",
    measured: (waves.scanInfo?.passes ?? []).map((p) => `${p.fog}: ${p.frames}/${p.expectedFrames ?? "?"} in ${p.segments ?? 1} recording(s), ${Math.round(p.wallMs / 1000)} s`).join("; "),
    bar: "every pass within 0.5% of expected",
    pass: (waves.scanInfo?.passes ?? []).every((p) => p.method !== "recorder" || (p.expectedFrames && Math.abs(p.frames - p.expectedFrames) <= p.expectedFrames * 0.005)),
    n: waves.scanInfo?.passes?.length ?? 0,
  };
  // The Fog of War view each pass ran under (clicked and read back), and whose allies the
  // team pass actually kept on the minimap.
  const views = waves.scanInfo?.views ?? [];
  const wantTeam = me.teamId === 100 ? "Blue" : "Red";
  const viewCheck = {
    name: "scan: fog view per pass (All, then your team)",
    measured: `${views.map((v) => `${v.fog}: ${v.read ?? "?"}`).join(", ") || "not recorded"}; team pass kept team ${waves.viewTeam ?? "?"} on the minimap (you: ${me.teamId})`,
    bar: `off pass All, team pass ${wantTeam}, and the team pass showing your team`,
    pass: views.some((v) => v.fog === "off" && v.read === "All") && views.some((v) => v.fog === "team" && v.read === wantTeam) && waves.viewTeam === me.teamId,
    n: views.length,
  };
  const checks = [
    checkPositions(waves, events, until),
    checkAllies(waves, allies, aliveAt),
    checkItems(changes, events, champOf, until, polls[0]?.t ?? 0),
    checkLevels(changes, events, champOf, until),
    checkCs(polls, timeline, champOf, until),
    checkGold(timeline, items, until),
    checkWards(placeWards(waves.samples, waves.champs ?? [], events, (id) => players.find((p) => p.id === id)?.teamId ?? 0, until)),
  ];
  // HP reads against deaths and respawns seen by Live Client (participants are 1-5 blue, 6-10 red, in frame order).
  const idOf = (champion: string) => players.find((p) => champKey(p.champion) === champKey(champion))?.id ?? 0;
  const lifeEvents = (kind: "death" | "respawn") => changes.filter((c) => c.kind === kind && c.t <= until).map((c) => ({ id: idOf(c.champion), t: c.t })).filter((e) => e.id > 0);
  const hudCheck = (({ detail, ...c }) => ({ c, detail }))(checkHud(waves.hud ?? [], lifeEvents("death"), lifeEvents("respawn")));
  const flashCheck = (({ detail, ...c }) => ({ c, detail }))(checkFlash(waves.hud ?? []));
  const report = {
    matchId,
    me,
    until: untilSec,
    checkedUntil: until,
    wallSec,
    viewTeam: waves.viewTeam,
    scanInfo: waves.scanInfo,
    samples: waves.samples.length,
    champSamples: waves.champs?.length ?? 0,
    checks: [framesCheck, viewCheck, checkFogOff(waves), ...checks.map(({ detail, ...c }) => c), hudCheck.c, flashCheck.c],
    hudWrong: hudCheck.detail,
    flashWrong: flashCheck.detail,
    positionErrors: checks[0].detail,
    missedBuys: checks[2].detail,
    csDetail: checks[4].detail,
    itemsVersion: match.info.gameVersion.split(".").slice(0, 2).join("."),
    unplacedWards: checks[6].detail,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `verify-${matchId}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

/**
 * Item prices and recipes from the Data Dragon version of a game's patch, kept on disk so a
 * review works offline after the first time. Undefined only when it was never fetched and
 * the network is down.
 */
const itemTables = new Map<string, ItemTable>();
async function itemsFor(gameVersion: string): Promise<ItemTable | undefined> {
  const patch = gameVersion.split(".").slice(0, 2).join(".");
  const hit = itemTables.get(patch);
  if (hit) return hit;
  const file = `items-${patch}.json`;
  let table = await store.readJson<ItemTable | null>(file, null);
  if (!table) {
    try {
      const versions = (await (await net.fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[];
      const ddv = versions.find((v) => v.startsWith(patch + ".")) ?? versions[0];
      table = itemTable(await (await net.fetch(`https://ddragon.leagueoflegends.com/cdn/${ddv}/data/en_US/item.json`)).json());
      await store.writeJson(file, table);
    } catch {
      return undefined;
    }
  }
  itemTables.set(patch, table);
  return table;
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

// Windows groups the taskbar button and notifications under this id, in a test run too.
if (process.platform === "win32") app.setAppUserModelId("com.touchdowned.leaguecoach");

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
      const reports = await sync();
      return { ok: true, reports, ...(syncWarning ? { warning: syncWarning } : {}) };
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
  handle("replay:state", async (matchId: string) => {
    const st = await (await league()).state(matchId);
    // Any open replay reads as "open". If it is another game's, this game's review must not drive it.
    if (st.kind === "open" && !sameGame(matchId, st.length)) return { kind: "unavailable", reason: "A different game's replay is open in League. Close it, then open this game's replay from here." } as const;
    return st;
  });
  // Which synced game the open replay is, by its length; null when no replay is open or none fits.
  handle("replay:openMatch", async () => {
    const pb = await (await league()).playback();
    if (!pb) return null;
    let best: { id: string; d: number } | null = null;
    for (const r of reports) {
      const d = Math.abs(r.metrics.durationMin * 60 - pb.length);
      if (d <= SAME_GAME_SEC && (!best || d < best.d)) best = { id: r.metrics.matchId, d };
    }
    return best?.id ?? null;
  });
  handle("replay:download", async (matchId: string) => (await league()).download(matchId));
  handle("replay:watch", async (matchId: string) => (await league()).watch(matchId));
  handle("replay:seek", async (sec: number, paused: boolean) => (await league()).seek(sec, paused));
  handle("replay:follow", async (champ: string) => {
    const lc = await league();
    const pb = await lc.playback();
    const track = pb ? await followTrack(pb.length, champ) : null;
    return lc.follow(champ, pb && track ? champPosAt(track.champs, track.pid, pb.time * 1000) : undefined);
  });
  handle("replay:followStart", (champ: string) => startFollow(champ));
  handle("replay:followStop", () => stopFollow());
  handle("replay:enableApi", async () => (await league()).enableReplayApi());
  handle("bench:get", () => readBench(store));

  // Guided walkthrough: the League replay window is streamed into the app and driven
  // through the Replay API (camera, fog, playback). No game memory, no file decoding.
  handle("stage:open", async (matchId: string) => {
    const dur = reports.find((x) => x.metrics.matchId === matchId)?.metrics.durationMin;
    const pb = await openReplay(await league(), matchId, (label) => send("stage:progress", label), () => false, dur ? dur * 60 : undefined);
    focusWindow();
    return pb;
  });
  handle("stage:source", async () => {
    const srcs = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
    const s = srcs.find((x) => /League of Legends \(TM\) Client/i.test(x.name)) ?? srcs.find((x) => /^League of Legends/i.test(x.name) && !/Coach/i.test(x.name));
    return s ? { id: s.id, name: s.name } : null;
  });
  handle("stage:playback", async (body?: { time?: number; paused?: boolean; speed?: number }) => {
    const lc = await league();
    return body ? lc.setPlayback(body) : lc.playback();
  });
  handle("stage:render", async (body?: Record<string, unknown>) => {
    const lc = await league();
    if (body) await lc.setRender(body);
    return lc.getRender();
  });
  handle("stage:sequence", async (body: Record<string, unknown>) => (await league()).setSequence(body));
  // Smooth free-camera move to a target (works while paused, unlike sequences).
  let glideId = 0;
  handle("stage:glide", async (target: { cameraPosition: { x: number; y: number; z: number }; cameraRotation: { x: number; y: number; z: number }; fieldOfView?: number }, ms = 900) => {
    const lc = await league();
    const id = ++glideId;
    const cur = await lc.getRender();
    const from = cur?.cameraPosition as typeof target.cameraPosition | undefined;
    const rot = cur?.cameraRotation as typeof target.cameraRotation | undefined;
    await lc.setRender({ cameraAttached: false, cameraMode: "fps" });
    if (!from || !rot) return lc.setRender(target);
    const t0 = Date.now();
    const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
    const mix = (a: number, b: number, k: number) => a + (b - a) * k;
    // Shortest way round for yaw.
    const dyaw = ((((target.cameraRotation.x - rot.x) % 360) + 540) % 360) - 180;
    while (id === glideId) {
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = ease(k);
      await lc.setRender({
        cameraPosition: { x: mix(from.x, target.cameraPosition.x, e), y: mix(from.y, target.cameraPosition.y, e), z: mix(from.z, target.cameraPosition.z, e) },
        cameraRotation: { x: rot.x + dyaw * e, y: mix(rot.y, target.cameraRotation.y, e), z: 0 },
        ...(k >= 1 && target.fieldOfView ? { fieldOfView: target.fieldOfView } : {}),
      });
      if (k >= 1) break;
      await new Promise((r) => setTimeout(r, 12));
    }
    return true;
  });
  handle("stage:focus", () => focusWindow());
  handle("overlay:open", (matchId: string) => openOverlay(matchId));
  // One finding shown as a card over the replay, after Jump has put the replay on its moment.
  handle("overlay:finding", (matchId: string, findingId: string) => openOverlay(matchId, `finding/${encodeURIComponent(matchId)}/${encodeURIComponent(findingId)}`));
  handle("overlay:close", (finished: boolean) => closeOverlay(!!finished));
  handle("overlay:interactive", (on: boolean) => {
    overlay?.setIgnoreMouseEvents(!on, { forward: true });
    overlayTaking = null;
  });
  handle("overlay:rects", (rects: { x: number; y: number; w: number; h: number }[]) => {
    overlayRects = Array.isArray(rects) ? rects.slice(0, 20) : [];
  });
  handle("overlay:modal", (on: boolean, keys: string[]) => setOverlayModal(!!on, Array.isArray(keys) ? keys : []));
  handle("overlay:focus", () => {
    if (!overlay) return;
    // Focus only: whether it takes the mouse is the cursor poll's to decide. Setting it here
    // left the window click-through while the poll thought it was taking the mouse.
    overlay.focus();
    overlayTaking = null;
  });
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
    onPhase: (phase) => {
      void mind?.onPhase(phase).catch(() => undefined);
      void autoReadTick(phase).catch(() => undefined);
    },
    queueRead: (matchId) => {
      readQueue.add(matchId, Date.now());
      void store.writeJson("pending-reads.json", readQueue.pending);
    },
    openReview: (matchId) => {
      send("postgame:open", matchId);
      focusWindow();
      if (Notification.isSupported() && !win?.isFocused()) {
        // The focus as of this game (the sync just added it).
        void currentFocus()
          .catch(() => ({ focus: lastFocus }))
          .then(({ focus: f }) => {
            const n = new Notification({ title: "Your review is ready", body: f ? `Next game, one focus: ${f.title}. ${f.rule}` : "League Coach opened the review for the game you just played." });
            n.on("click", focusWindow);
            n.show();
          });
      }
    },
  });
  handle("postgame:status", () => watcher?.status);
  readQueue.pending = (await store.readJson<PendingRead[]>("pending-reads.json", [])).filter((p) => reports.some((r) => r.metrics.matchId === p.matchId && !Array.isArray(r.findings)));
  handle("focus:get", () => currentFocus());
  await currentFocus().catch(() => undefined);
  handle("replay:close", async () => (await league()).closeReplay());

  // Mental game: draft card, live overlay, debriefs.
  mind = new MindService({
    store,
    league,
    settings: () => store.readSettings(),
    reports: () => reports,
    focus: () => lastFocus,
    send,
    focusMain: focusWindow,
    preload: path.join(__dirname, "preload.js"),
    rendererUrl: (hash) => (process.env.VITE_DEV_SERVER_URL ? { url: process.env.VITE_DEV_SERVER_URL, hash } : { file: path.join(__dirname, "../../dist-renderer/index.html"), hash }),
  });
  await mind.load();
  handle("mind:get", () => mind!.data);
  handle("mind:draftInfo", () => mind!.currentDraft ?? mind!.buildDraft(null, null, "", null, null));
  handle("mind:lockPlan", (p) => mind!.lockPlan(p));
  handle("mind:nextPlan", () => mind!.nextPlan);
  handle("mind:closeDraft", () => mind!.closeDraft());
  handle("mind:saveDebrief", (db) => mind!.saveDebrief(db));
  handle("mind:skipDebrief", (gameId: string) => mind!.skipDebrief(gameId));
  handle("mind:checkIn", (n: number) => mind!.checkIn(n));
  handle("mind:preview", () => mind!.preview());
  handle("mind:endPreview", () => mind!.endPreview());
  handle("mind:windowMode", async () => mind!.windowMode((await store.readSettings()).leagueDir));
  handle("mind:setOverlayPos", async (pos: { x: number; y: number }) => {
    const s = await store.readSettings();
    await store.writeSettings({ ...s, overlayPos: pos });
  });
  applyLoginItem(await store.readSettings());

  const vi = process.argv.indexOf("--verify-scan");
  if (vi >= 0) {
    const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
    try {
      await verifyScan(process.argv[vi + 1], Number(arg("--until") ?? 900), arg("--out") ?? path.join(app.getPath("userData"), "verify"), process.argv.includes("--reuse"));
    } catch (e) {
      console.error("verify failed:", (e as Error).message);
    }
    app.exit(0);
    return;
  }

  Menu.setApplicationMenu(null);
  createWindow();
  watcher.start();
  startAutoUpdates();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("before-quit", () => {
  watcher?.stop();
  mind?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
