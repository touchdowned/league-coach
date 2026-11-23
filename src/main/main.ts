import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { buildReport } from "../core/analysis";
import { parseRiotId, RiotClient, SR_QUEUES } from "../core/riot";
import { recommendRole } from "../core/roles";
import type { GameReport } from "../core/types";
import { JsonStore, Settings } from "./store";

let win: BrowserWindow | null = null;
let store: JsonStore;
let reports: GameReport[] = [];

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#0e1117",
    title: "League Coach",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  const dev = process.env.VITE_DEV_SERVER_URL;
  if (dev) win.loadURL(dev);
  else win.loadFile(path.join(__dirname, "../../dist-renderer/index.html"));
}

function progress(done: number, total: number, label: string) {
  win?.webContents.send("sync:progress", { done, total, label });
}

async function sync(): Promise<GameReport[]> {
  const s = await store.readSettings();
  if (!s.apiKey) throw new Error("Add your Riot API key in Settings first.");
  const { gameName, tagLine } = parseRiotId(s.riotId);
  const riot = new RiotClient(s.apiKey.trim(), s.region, store.cache());

  progress(0, 1, "Looking up your account");
  const puuid = await riot.getPuuid(gameName, tagLine);
  const ids = await riot.getMatchIds(puuid, s.matchCount);

  const out: GameReport[] = [];
  for (let i = 0; i < ids.length; i++) {
    progress(i, ids.length, `Loading game ${i + 1} of ${ids.length}`);
    const match = await riot.getMatch(ids[i]);
    if (!SR_QUEUES.includes(match.info.queueId) || match.info.gameDuration < 600) continue; // skip ARAM, remakes
    const timeline = await riot.getTimeline(ids[i]);
    out.push(buildReport(match, timeline, puuid));
  }
  progress(ids.length, ids.length, "Done");
  reports = out.sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation);
  return reports;
}

app.whenReady().then(() => {
  store = new JsonStore(app.getPath("userData"));

  ipcMain.handle("settings:get", () => store.readSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => store.writeSettings(s));
  ipcMain.handle("games:sync", async () => {
    try {
      return { ok: true, reports: await sync() };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.handle("games:list", () => reports);
  ipcMain.handle("role:get", () => recommendRole(reports.map((r) => r.metrics)));

  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
