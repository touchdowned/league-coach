import { desktopCapturer, nativeImage, net, screen } from "electron";
import { bgraToRgba, crop, detectChampions, detectDots, findMinimap, Frame, iconGrid, medianFrame, PortraitRef, Rect } from "../core/minimap";
import { ChampSample, sampleFromDots, WaveSample, WaveTrack } from "../core/waves";
import { gameIdOf, LeagueClient } from "./league";

/**
 * Reads minion positions from a replay: plays your own replay through the official
 * Replay API, captures the screen, and reads the minimap's pixels. No game memory,
 * no replay-file decoding.
 */

export interface ScanProgress {
  phase: "opening" | "calibrating" | "reading" | "done";
  label: string;
  done: number;
  total: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function captureScreen(): Promise<Frame> {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
  if (!src) throw new Error("Couldn't capture the screen.");
  const img = src.thumbnail;
  const { width, height } = img.getSize();
  const data = new Uint8ClampedArray(img.toBitmap());
  bgraToRgba(data); // NativeImage bitmaps are BGRA
  return { w: width, h: height, data };
}

export interface ScanPlayer {
  id: number;
  champion: string;
  teamId: number;
}

/** Each champion's Data Dragon icon, reduced to the grid the minimap matcher compares. */
async function portraitRefs(players: ScanPlayer[]): Promise<PortraitRef[]> {
  const versions = (await (await net.fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()) as string[];
  const v = versions[0];
  const out: PortraitRef[] = [];
  for (const p of players) {
    try {
      const res = await net.fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${p.champion}.png`);
      const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer())).resize({ width: 48, height: 48 });
      const data = new Uint8ClampedArray(img.toBitmap());
      bgraToRgba(data);
      out.push({ id: p.id, team: p.teamId === 100 ? 100 : 200, grid: iconGrid({ w: 48, h: 48, data }) });
    } catch {
      /* that champion just won't be identified */
    }
  }
  return out;
}

async function waitFor<T>(fn: () => Promise<T | null>, ms: number, isCancelled: () => boolean): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end && !isCancelled()) {
    const v = await fn();
    if (v) return v;
    await sleep(1000);
  }
  return null;
}

/** Gets this game's replay open in League (downloading it first if needed). */
export async function openReplay(lc: LeagueClient, matchId: string, onLabel: (label: string) => void, isCancelled: () => boolean = () => false) {
  let pb = await lc.playback();
  if (pb) {
    const open = await lc.currentGameId();
    if (open && open !== gameIdOf(matchId)) throw new Error("A different replay is open. Close it and try again.");
    return pb;
  }
  const st = await lc.state(matchId);
  if (st.kind === "client-closed") throw new Error("Open the League client first.");
  if (st.kind === "api-disabled") throw new Error("Turn on replay control first (Settings, or the button on the replay card), then try again.");
  if (st.kind === "unavailable") throw new Error(st.reason);
  if (st.kind === "can-download") await lc.download(matchId);
  if (st.kind === "can-download" || st.kind === "downloading") {
    onLabel("Downloading the replay");
    const ok = await waitFor(async () => ((await lc.state(matchId)).kind === "ready" ? true : null), 180_000, isCancelled);
    if (!ok) throw new Error("The replay didn't finish downloading.");
  }
  await lc.watch(matchId);
  onLabel("Loading the replay");
  pb = await waitFor(() => lc.playback(), 150_000, isCancelled);
  if (!pb) throw new Error("The replay didn't open. Is replay control turned on?");
  await sleep(4000); // loading screen
  return pb;
}

export async function scanReplay(
  lc: LeagueClient,
  matchId: string,
  onProgress: (p: ScanProgress) => void,
  isCancelled: () => boolean,
  players: ScanPlayer[],
  me: ScanPlayer,
  untilSec = 16 * 60,
): Promise<WaveTrack> {
  if ((await lc.gameflowPhase()) === "InProgress") throw new Error("You're in a game. Replay reading only runs after the game.");

  // 1. Get this game's replay open.
  onProgress({ phase: "opening", label: "Opening the replay", done: 0, total: 1 });
  const pb = await openReplay(lc, matchId, (label) => onProgress({ phase: "opening", label, done: 0, total: 1 }), isCancelled);
  const end = Math.min(pb.length, untilSec);

  const original = await lc.getRender();
  const refs = await portraitRefs(players).catch(() => [] as PortraitRef[]);
  try {
    // 2. Find the minimap: capture with it on and off while paused.
    onProgress({ phase: "calibrating", label: "Finding the minimap", done: 0, total: 1 });
    await lc.seek(20, true);
    await lc.setRender({ fogOfWar: false, interfaceMinimap: true, selectionName: me.champion });
    let rect: Rect | null = null;
    for (let tries = 0; tries < 3 && !rect && !isCancelled(); tries++) {
      await sleep(900);
      const on = await captureScreen();
      await lc.setRender({ interfaceMinimap: false });
      await sleep(900);
      const off = await captureScreen();
      await lc.setRender({ interfaceMinimap: true });
      rect = findMinimap(on, off);
    }
    if (!rect)
      throw new Error("Couldn't find the minimap on screen. Keep the replay on your main monitor, in Borderless or Windowed mode, and don't cover it while it reads.");

    // 3. The empty map: frames before minions spawn, median removes the champions.
    const bgFrames: Frame[] = [];
    for (const t of [12, 22, 32, 42, 52, 60, 64]) {
      if (isCancelled()) break;
      await lc.seek(t, true);
      await sleep(700);
      bgFrames.push(crop(await captureScreen(), rect));
    }
    const bg = medianFrame(bgFrames);

    // 4. Play it fast. Alternate two views: fog off (minions, true positions) and your
    // team's fog (what you could see on your minimap).
    const samples: WaveSample[] = [];
    const champs: ChampSample[] = [];
    let n = 0;
    let speed = 4;
    await lc.seek(65, false, speed);
    const gaps: number[] = [];
    let last = Date.now();
    while (!isCancelled()) {
      const before = await lc.playback();
      if (!before) throw new Error("The replay closed while reading.");
      if (before.time >= end) break;
      if (before.paused) {
        await lc.setPaused(false);
        await sleep(300);
        continue;
      }
      const fog: ChampSample["fog"] = n++ % 2 === 0 ? "off" : "team";
      await lc.setRender({ fogOfWar: fog === "team" });
      await sleep(60);
      const frame = crop(await captureScreen(), rect);
      const after = await lc.playback();
      const t = Math.round(((before.time + (after?.time ?? before.time)) / 2) * 1000);
      if (fog === "off") samples.push(sampleFromDots(t, detectDots(frame, bg)));
      if (refs.length) champs.push({ t, fog, at: detectChampions(frame, refs).map(({ id, x, y }) => ({ id, x, y })) });
      const now = Date.now();
      gaps.push(now - last);
      last = now;
      // Aim for a read every ~1.5 game seconds, as fast as capture allows.
      if (gaps.length === 8) {
        const avg = gaps.reduce((s, x) => s + x, 0) / gaps.length;
        const next = Math.max(1, Math.min(8, Math.floor(1000 / Math.max(avg, 1))));
        if (next !== speed) {
          speed = next;
          await lc.setSpeed(speed);
        }
        gaps.length = 0;
      }
      onProgress({ phase: "reading", label: `Reading minions at ${fmt(before.time)} of ${fmt(end)} (${speed}x)`, done: Math.round(before.time), total: Math.round(end) });
    }
    if (isCancelled()) throw new Error("Stopped.");
    onProgress({ phase: "done", label: "Done", done: 1, total: 1 });
    // Whose fog did "team" show? Allies are always on your own minimap.
    const team = champs.filter((c) => c.fog === "team");
    const avg = (tid: number) => team.reduce((s, c) => s + c.at.filter((a) => players.find((p) => p.id === a.id)?.teamId === tid).length, 0) / Math.max(1, team.length);
    const viewTeam = team.length ? (avg(100) >= avg(200) ? 100 : 200) : undefined;
    return { version: 2, source: "replay-minimap", samples, champs, viewTeam };
  } finally {
    await lc.setPaused(true);
    if (original) await lc.setRender(original);
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
