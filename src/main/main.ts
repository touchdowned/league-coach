import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, net, Notification, protocol, screen } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { buildReport } from "../core/analysis";
import { applyEvent, EMPTY_PROGRESS, ProgressEvent, ProgressState } from "../core/progress";
import { parseRiotId, RiotClient, SR_QUEUES } from "../core/riot";
import type { GameReport } from "../core/types";
import { gameIdOf, LeagueClient } from "./league";
import { PostGameWatcher } from "./postgame";
import { openReplay, scanReplay } from "./scan";
import { champKey, checkAllies, checkCs, checkFogOff, checkItems, checkLevels, checkPositions, invChanges } from "../core/telemetry";
import { checkGold, itemTable } from "../core/gold";
import { checkWards, placeWards } from "../core/wards";
import { growBench, readBench } from "./bench";
import type { WaveTrack } from "../core/waves";
import { JsonStore, Settings } from "./store";
import { listVods, matchVod } from "./vod";
import { startAutoUpdates } from "./updater";

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

// ---- Coaching overlay: a transparent, click-through window over the League replay ----
let overlay: BrowserWindow | null = null;
let overlayMatch: string | null = null;
let overlayRender: Record<string, unknown> | null = null;

async function openOverlay(matchId: string) {
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
  overlay.setVisibleOnAllWorkspaces(true);
  const dev = process.env.VITE_DEV_SERVER_URL;
  const hash = `overlay/${encodeURIComponent(matchId)}`;
  if (dev) overlay.loadURL(`${dev}#${hash}`);
  else overlay.loadFile(path.join(__dirname, "../../dist-renderer/index.html"), { hash });
  overlay.once("ready-to-show", () => overlay?.showInactive());
  overlay.on("closed", () => {
    overlay = null;
  });
  win?.minimize();
}

async function closeOverlay(finished: boolean) {
  const matchId = overlayMatch;
  // Put League's camera, fog and HUD back the way they were.
  const lc = await league();
  await lc.setPaused(true);
  if (overlayRender) await lc.setRender(overlayRender);
  overlayRender = null;
  overlay?.destroy();
  overlay = null;
  overlayMatch = null;
  if (matchId) send("overlay:closed", { matchId, finished });
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
  const wallSec = Math.round((Date.now() - t0) / 1000);
  // Item prices and recipes for the gold estimate, from the Data Dragon version of this patch.
  const versions = (await (await net.fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[];
  const patch = match.info.gameVersion.split(".").slice(0, 2).join(".");
  const ddv = versions.find((v) => v.startsWith(patch + ".")) ?? versions[0];
  const items = itemTable(await (await net.fetch(`https://ddragon.leagueoflegends.com/cdn/${ddv}/data/en_US/item.json`)).json());
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
    checks: [framesCheck, viewCheck, checkFogOff(waves), ...checks.map(({ detail, ...c }) => c)],
    positionErrors: checks[0].detail,
    missedBuys: checks[2].detail,
    csDetail: checks[4].detail,
    itemsVersion: ddv,
    unplacedWards: checks[6].detail,
  };
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `verify-${matchId}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
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
  handle("bench:get", () => readBench(store));

  // Guided walkthrough: the League replay window is streamed into the app and driven
  // through the Replay API (camera, fog, playback). No game memory, no file decoding.
  handle("stage:open", async (matchId: string) => {
    const pb = await openReplay(await league(), matchId, (label) => send("stage:progress", label));
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
  handle("overlay:close", (finished: boolean) => closeOverlay(!!finished));
  handle("overlay:interactive", (on: boolean) => overlay?.setIgnoreMouseEvents(!on, { forward: true }));
  handle("overlay:focus", () => {
    if (!overlay) return;
    overlay.setIgnoreMouseEvents(false);
    overlay.focus();
    overlay.setIgnoreMouseEvents(true, { forward: true });
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

app.on("before-quit", () => watcher?.stop());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
