import { app, desktopCapturer, nativeImage, net, screen } from "electron";
import { bgraToRgba, crop, detectChampions, detectDots, backgroundFrame, findMinimap, findRings, Frame, iconGrid, PortraitRef, Rect } from "../core/minimap";
import { cameraLookingAt } from "../core/camera";
import { dropJumps, nameRings } from "../core/vision";
import { ChampSample, sampleFromDots, WaveSample, WaveTrack } from "../core/waves";
import { gameIdOf, LeagueClient } from "./league";
import { parseLive, type LivePoll } from "../core/telemetry";
import { promises as fsp } from "fs";
import pathMod from "path";

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


/** Writes a minimap crop (RGBA) as PNG, with what was read from it, for checking by eye. */
async function dumpFrame(dir: string, name: string, f: Frame, info: unknown) {
  const bgra = new Uint8ClampedArray(f.data);
  bgraToRgba(bgra); // the swap is its own inverse
  const img = nativeImage.createFromBitmap(Buffer.from(bgra.buffer), { width: f.w, height: f.h });
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(pathMod.join(dir, `${name}.png`), img.toPNG());
  await fsp.writeFile(pathMod.join(dir, `${name}.json`), JSON.stringify(info));
}

/** A fixed free camera over mid river, so the minimap's camera box never moves. */
const SCAN_CAMERA = { cameraMode: "fps", cameraAttached: false, ...cameraLookingAt({ x: 7400, y: 7400 }, 2400, 56, 0), fieldOfView: 40 };

function imageToFrame(img: Electron.NativeImage): Frame {
  const { width, height } = img.getSize();
  const data = new Uint8ClampedArray(img.toBitmap());
  bgraToRgba(data);
  return { w: width, h: height, data };
}

/** The minimap rect, scaled from the calibration capture's size to a frame of another size. */
function scaleRect(r: Rect, from: { w: number; h: number }, to: { w: number; h: number }): Rect {
  if (from.w === to.w && from.h === to.h) return r;
  const sx = to.w / from.w;
  const sy = to.h / from.h;
  return { x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) };
}

/** Called with each frame's minimap crop and its game time (ms). */
const toRectangle = (r: Rect) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

type OnFrame = (minimap: Frame, t: number) => Promise<void> | void;
/** Where the minimap is in a frame of the given size. */
type RectFor = (size: { w: number; h: number }) => Rect;

/**
 * One pass with Riot's recorder: it renders [from, to] frame by frame and writes PNGs at
 * exact game times (frame k = from + k / fps), much faster than screen capture and
 * independent of what's on screen. Each frame is read, then deleted. Null when the
 * recorder isn't available.
 */
async function recorderPass(lc: LeagueClient, from: number, to: number, fps: number, rectFor: RectFor, onFrame: OnFrame, isCancelled: () => boolean, onTime: (t: number) => void): Promise<{ frames: number; wallMs: number; maxBacklog: number } | null> {
  const base = pathMod.join(app.getPath("temp"), "league-coach-frames", String(Date.now()));
  await lc.setPlayback({ time: from, paused: true });
  await sleep(1200);
  if (!(await lc.startFrameRecording(base, from, to, fps))) return null;
  const t0 = Date.now();
  await lc.setPlayback({ time: from, paused: false, speed: 8 });
  let next = 0;
  let lastProgress = Date.now();
  let dir: string | null = null;
  // Reading can fall behind the recorder (each frame is ~2 MB on disk): hold the replay
  // when too many frames wait, so disk use stays bounded on any PC.
  let held = false;
  let maxBacklog = 0;
  try {
    while (true) {
      if (isCancelled()) {
        await lc.stopRecording();
        break;
      }
      if (!dir) {
        const subs = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
        const d = subs.find((e) => e.isDirectory());
        dir = d ? pathMod.join(base, d.name) : null;
      }
      const st = await lc.recordingState();
      const done = !st || !st.recording;
      if (dir) {
        const files = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => /^\d+\.png$/i.test(f)).sort();
        const have = new Set(files.map((f) => parseInt(f, 10)));
        const backlog = files.length;
        if (backlog > maxBacklog) maxBacklog = backlog;
        if (!held && backlog > 24) {
          held = true;
          await lc.setPaused(true);
        } else if (held && backlog < 6) {
          held = false;
          await lc.setPaused(false);
        }
        for (const f of files) {
          const k = parseInt(f, 10);
          if (k < next) continue;
          // A file is complete once the next one exists, or the recorder has stopped.
          if (!done && !have.has(k + 1)) break;
          const file = pathMod.join(dir, f);
          const img = nativeImage.createFromPath(file);
          if (img.isEmpty()) {
            if (!done) break;
          } else {
            const sz = img.getSize();
            // Crop before converting: only the minimap's pixels get copied.
            await onFrame(imageToFrame(img.crop(toRectangle(rectFor({ w: sz.width, h: sz.height })))), Math.round((from + k / fps) * 1000));
          }
          await fsp.unlink(file).catch(() => undefined);
          next = k + 1;
          lastProgress = Date.now();
          onTime(from + k / fps);
        }
      }
      if (done) break;
      // The recorder only advances while the replay plays.
      if (!held) {
        const pb = await lc.playback();
        if (pb?.paused) await lc.setPaused(false);
      }
      if (Date.now() - lastProgress > 25_000) {
        await lc.stopRecording();
        if (next === 0) return null;
        break;
      }
      await sleep(150);
    }
  } finally {
    await lc.setPaused(true);
    await fsp.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  return { frames: next, wallMs: Date.now() - t0, maxBacklog };
}

/**
 * The fallback: desktop screenshots while the replay plays (~0.6 s per capture on a
 * typical PC, so the replay runs at 1-2x). Times are the midpoint of the playback
 * clock read before and after each capture.
 */
async function screenshotPass(lc: LeagueClient, from: number, to: number, rectFor: RectFor, onFrame: OnFrame, isCancelled: () => boolean, onTime: (t: number) => void, captureMs: number[]): Promise<{ frames: number; wallMs: number }> {
  const t0 = Date.now();
  let speed = 2;
  await lc.seek(from, false, speed);
  let frames = 0;
  let lastT = from;
  let atEnd = 0;
  const gaps: number[] = [];
  let last = Date.now();
  while (!isCancelled()) {
    const before = await lc.playback();
    if (!before) throw new Error("The replay closed while reading.");
    // Something else moved the replay (a seek backwards): put it back where we were.
    if (before.time < lastT - 3) {
      await lc.seek(lastT, false, speed);
      await sleep(500);
      continue;
    }
    if (before.time >= to) {
      if (++atEnd >= 3) break;
      await sleep(200);
      continue;
    }
    atEnd = 0;
    if (before.paused) {
      await lc.setPaused(false);
      await sleep(300);
      continue;
    }
    const c0 = Date.now();
    const full = await captureScreen();
    captureMs.push(Date.now() - c0);
    const after = await lc.playback();
    const t = Math.round(((before.time + (after?.time ?? before.time)) / 2) * 1000);
    lastT = before.time;
    await onFrame(crop(full, rectFor(full)), t);
    frames++;
    onTime(before.time);
    const now = Date.now();
    gaps.push(now - last);
    last = now;
    if (gaps.length === 8) {
      const avg = gaps.reduce((s, x) => s + x, 0) / gaps.length;
      const next = Math.max(1, Math.min(4, Math.floor(1500 / Math.max(avg, 1))));
      if (next !== speed) {
        speed = next;
        await lc.setSpeed(speed);
      }
      gaps.length = 0;
    }
  }
  await lc.setPaused(true);
  return { frames, wallMs: Date.now() - t0 };
}

export async function scanReplay(
  lc: LeagueClient,
  matchId: string,
  onProgress: (p: ScanProgress) => void,
  isCancelled: () => boolean,
  players: ScanPlayer[],
  me: ScanPlayer,
  untilSec = 16 * 60,
  debugDir?: string,
  opts: { method?: "recorder" | "screenshot" } = {},
): Promise<WaveTrack> {
  if ((await lc.gameflowPhase()) === "InProgress") throw new Error("You're in a game. Replay reading only runs after the game.");

  // 1. Get this game's replay open.
  onProgress({ phase: "opening", label: "Opening the replay", done: 0, total: 1 });
  const pb = await openReplay(lc, matchId, (label) => onProgress({ phase: "opening", label, done: 0, total: 1 }), isCancelled);
  const end = Math.min(pb.length - 1, untilSec);

  const original = await lc.getRender();
  const refs = await portraitRefs(players).catch(() => [] as PortraitRef[]);
  try {
    // 2. Find the minimap: capture with it on and off while paused. Your champion is
    // selected (so team fog is your team's), and the camera is parked over mid river
    // for the whole pass, so the camera box on the minimap stays put.
    onProgress({ phase: "calibrating", label: "Finding the minimap", done: 0, total: 1 });
    await lc.seek(20, true);
    await lc.setRender({ fogOfWar: false, interfaceMinimap: true, selectionName: me.champion });
    await sleep(300);
    await lc.setRender(SCAN_CAMERA);
    let rect: Rect | null = null;
    let screenSize = { w: 0, h: 0 };
    for (let tries = 0; tries < 3 && !rect && !isCancelled(); tries++) {
      await sleep(900);
      const on = await captureScreen();
      await lc.setRender({ interfaceMinimap: false });
      await sleep(900);
      const off = await captureScreen();
      await lc.setRender({ interfaceMinimap: true });
      rect = findMinimap(on, off);
      screenSize = { w: on.w, h: on.h };
    }
    if (!rect)
      throw new Error("Couldn't find the minimap on screen. Keep the replay on your main monitor, in Borderless or Windowed mode, and don't cover it while it reads.");
    const minimap = rect;

    // 3. The empty map: frames before minions spawn, median removes the champions.
    const bgFrames: Frame[] = [];
    for (const t of [12, 22, 32, 42, 52, 60, 64]) {
      if (isCancelled()) break;
      await lc.seek(t, true);
      await sleep(700);
      bgFrames.push(crop(await captureScreen(), minimap));
    }
    // Champions can sit in the fountains early on: there, use frames from later in the game.
    const lateFrames: Frame[] = [];
    for (const t of [150, 300, 450, 600, 750, 870].filter((t) => t < end)) {
      if (isCancelled()) break;
      await lc.seek(t, true);
      await sleep(700);
      lateFrames.push(crop(await captureScreen(), minimap));
    }
    const bg = backgroundFrame(bgFrames, lateFrames);

    const samples: WaveSample[] = [];
    const champs: ChampSample[] = [];
    const captureMs: number[] = [];
    const passes: NonNullable<NonNullable<WaveTrack["scanInfo"]>["passes"]> = [];
    let dumped = 0;
    const rectFor: RectFor = (size) => scaleRect(minimap, screenSize, size);
    const reader = (fog: ChampSample["fog"]): OnFrame => async (frame, t) => {
      // Minimap scale differs from the background's? (recorder at another resolution)
      const okBg = frame.w === bg.w && frame.h === bg.h;
      const rings = findRings(frame, okBg ? bg : undefined);
      const dots = fog === "off" && okBg ? detectDots(frame, bg, { exclude: rings }) : [];
      if (fog === "off") samples.push(sampleFromDots(t, dots));
      if (refs.length) {
        const found = detectChampions(frame, refs, 38, rings);
        const at = found.filter((c) => c.id > 0).map(({ id, x, y }) => ({ id, x, y }));
        const unk = found.filter((c) => c.id === 0).map(({ team, x, y }) => ({ team, x, y }));
        champs.push({ t, fog, at, ...(unk.length ? { unk } : {}) });
        if (debugDir && dumped++ % 12 === 0) await dumpFrame(debugDir, `${String(t).padStart(7, "0")}-${fog}`, frame, { t, fog, dots, rings, champs: found });
      }
    };

    // Live Client Data, polled as fast as it answers through both passes. The state is a
    // function of game time, so polls from the two passes interleave into one finer stream.
    const live: LivePoll[] = [];
    let polling = true;
    const pollLoop = (async () => {
      while (polling && !isCancelled()) {
        const p = parseLive(await lc.liveData());
        if (p && p.t >= 0) live.push(p);
        await sleep(30);
      }
    })();

    // 4. Two passes over 1:05 to the end: fog off (minions, true positions) at 2 frames
    // per game second, then your team's fog (what you could see) at 1.
    const from = 65;
    let method = opts.method ?? "recorder";
    const runPass = async (fog: ChampSample["fog"], fps: number) => {
      await lc.setRender({ fogOfWar: fog === "team" });
      await sleep(300);
      const label = (t: number) =>
        onProgress({ phase: "reading", label: `Reading the ${fog === "off" ? "map" : "fog of war"} at ${fmt(t)} of ${fmt(end)}`, done: Math.round((fog === "off" ? 0 : end) + t), total: Math.round(end * 2) });
      if (method === "recorder") {
        const r = await recorderPass(lc, from, end, fps, rectFor, reader(fog), isCancelled, label);
        if (r) {
          passes.push({ fog, method, frames: r.frames, fps, wallMs: r.wallMs, maxBacklog: r.maxBacklog });
          return;
        }
        method = "screenshot";
      }
      const r = await screenshotPass(lc, from, end, rectFor, reader(fog), isCancelled, label, captureMs);
      passes.push({ fog, method: "screenshot", frames: r.frames, fps: r.frames / Math.max(1, end - from), wallMs: r.wallMs });
    };
    await runPass("off", 2);
    if (!isCancelled()) await runPass("team", 1);
    polling = false;
    await pollLoop;
    live.sort((a, b) => a.t - b.t);
    if (isCancelled()) throw new Error("Stopped.");
    champs.sort((a, b) => a.t - b.t);
    const teamOf = (id: number) => players.find((p) => p.id === id)?.teamId ?? 0;
    const dropped = dropJumps(champs);
    // Who's alive when, from Live Client's isDead (polls are sorted by game time).
    const aliveAt = (id: number, t: number) => {
      const name = players.find((p) => p.id === id)?.champion;
      let lo = 0;
      let hi = live.length - 1;
      let at = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (live[m].t <= t) {
          at = m;
          lo = m + 1;
        } else hi = m - 1;
      }
      const lp = at >= 0 ? live[at].players.find((x) => x.championName === name) : undefined;
      return lp ? !lp.isDead : true;
    };
    const named = nameRings(champs, teamOf, { aliveAt, ids: players.map((p) => p.id), myTeam: me.teamId });
    samples.sort((a, b) => a.t - b.t);
    onProgress({ phase: "done", label: "Done", done: 1, total: 1 });
    if (debugDir) await dumpFrame(debugDir, "background", bg, { rect: minimap });
    // Whose fog did "team" show? Allies are always on your own minimap.
    const team = champs.filter((c) => c.fog === "team");
    const avg = (tid: number) => team.reduce((s, c) => s + c.at.filter((a) => players.find((p) => p.id === a.id)?.teamId === tid).length, 0) / Math.max(1, team.length);
    const viewTeam = team.length ? (avg(100) >= avg(200) ? 100 : 200) : undefined;
    const sorted = [...captureMs].sort((a, b) => a - b);
    const lastFrame = champs.length ? champs[champs.length - 1].t : samples.length ? samples[samples.length - 1].t : 0;
    const scanInfo = {
      method: passes.every((p) => p.method === "recorder") ? ("recorder" as const) : ("screenshot" as const),
      captureMsMedian: sorted[Math.floor(sorted.length / 2)] ?? 0,
      captureMsP90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
      samples: samples.length,
      polls: live.length,
      minimap,
      screen: screenSize,
      until: end * 1000,
      lastFrame,
      passes,
      tracking: { dropped, named },
    };
    return { version: 2, source: "replay-minimap", samples, champs, viewTeam, live, scanInfo };
  } finally {
    await lc.setPaused(true);
    if (original) {
      await lc.setRender(original);
      // Position doesn't stick when the mode changes in the same call: set it again.
      if (original.cameraPosition) await lc.setRender({ cameraPosition: original.cameraPosition, cameraRotation: original.cameraRotation });
    }
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
