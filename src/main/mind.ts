import { BrowserWindow, globalShortcut, screen } from "electron";
import { promises as fs } from "fs";
import https from "https";
import path from "path";
import { coachPlan } from "../core/coach";
import { AllGameData, findMe, isPlayableGame } from "../core/live";
import {
  baselineFrom,
  challengeDefs,
  ChallengeId,
  Debrief,
  GamePlan,
  ISSUE_CHALLENGE,
  LiveRecord,
  LiveTracker,
  LiveView,
  matchupRead,
  queueCheck,
  resultOf,
  suggestMental,
  tiltProfile,
} from "../core/mind";
import { IN_GAME_PHASES } from "../core/postgame";
import type { GameReport, Position } from "../core/types";
import type { LeagueClient } from "./league";
import type { JsonStore, Settings } from "./store";

/**
 * The mental-game loop around each game:
 *   champ select -> a small draft card to pick one skill goal and one mental goal,
 *   in game      -> a click-through overlay that tracks both from the Live Client Data API,
 *   after        -> the debrief opens in the main window.
 *
 * The overlay only draws your own goal and stats over League. It reads nothing the game
 * doesn't already show you, never reads game memory, and never sends input to League.
 */

const local = new https.Agent({ rejectUnauthorized: false });

function getJson<T>(url: string, timeoutMs = 900): Promise<T | null> {
  return new Promise((resolve) => {
    const req = https.get(url, { agent: local, timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? (JSON.parse(raw) as T) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export interface MindData {
  plans: GamePlan[];
  records: LiveRecord[];
  debriefs: Debrief[];
  /** Game ids whose debrief hasn't been done or skipped yet, newest first. */
  pending: string[];
}

export const EMPTY_MIND: MindData = { plans: [], records: [], debriefs: [], pending: [] };

export interface DraftOption {
  id: ChallengeId;
  title: string;
  rule: string;
  why: string;
  pass: string;
  reason: string;
}

export interface DraftInfo {
  phase: "champ-select" | "locked";
  champion: string | null;
  championName: string | null;
  role: Position;
  enemy: string | null;
  enemyName: string | null;
  read: ReturnType<typeof matchupRead> | null;
  skillOptions: DraftOption[];
  mentalOptions: DraftOption[];
  recommendedSkill: ChallengeId;
  recommendedMental: ChallengeId;
  queue: ReturnType<typeof queueCheck>;
  plan: GamePlan | null;
  lastIntention: string | null;
}

interface ChampSelectSession {
  localPlayerCellId?: number;
  myTeam?: { cellId: number; championId: number; championPickIntent?: number; assignedPosition?: string }[];
  theirTeam?: { cellId: number; championId: number; assignedPosition?: string }[];
}

const POS: Record<string, Position> = { top: "TOP", jungle: "JUNGLE", middle: "MIDDLE", mid: "MIDDLE", bottom: "BOTTOM", utility: "UTILITY", support: "UTILITY" };

export interface MindDeps {
  store: JsonStore;
  league(): Promise<LeagueClient>;
  settings(): Promise<Settings>;
  reports(): GameReport[];
  /** Sends to the main window. */
  send(channel: string, payload: unknown): void;
  focusMain(): void;
  rendererUrl(hash: string): { url?: string; file?: string; hash: string };
  preload: string;
}

export class MindService {
  data: MindData = EMPTY_MIND;
  private overlay: BrowserWindow | null = null;
  private draft: BrowserWindow | null = null;
  private tracker: LiveTracker | null = null;
  private trackerGameId: string | null = null;
  private lastData: AllGameData | null = null;
  private polling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private champs: Map<number, { name: string; alias: string }> | null = null;
  private draftInfo: DraftInfo | null = null;
  private draftPlan: GamePlan | null = null;
  private lastPhase: string | null = null;
  private hidden = false;
  private editing = false;
  private demo: NodeJS.Timeout | null = null;
  private checkInKeys = false;

  constructor(private deps: MindDeps) {}

  async load() {
    this.data = { ...EMPTY_MIND, ...(await this.deps.store.readJson<MindData>("mind.json", EMPTY_MIND)) };
  }

  private async save() {
    await this.deps.store.writeJson("mind.json", this.data);
  }

  // ------------------------------------------------------------ phase handling

  /** Called by the game watcher on every poll (every 2s while the client is open). */
  async onPhase(phase: string | null) {
    const s = await this.deps.settings();
    const prev = this.lastPhase;
    this.lastPhase = phase;
    if (phase === "ChampSelect") {
      if (s.draftCompanion !== false) await this.updateDraft();
    } else if (prev === "ChampSelect" && phase !== "GameStart" && phase !== "InProgress") {
      // Dodge or lobby: forget the half-made plan.
      this.closeDraft();
      this.draftPlan = null;
    }
    if (phase && IN_GAME_PHASES.includes(phase)) {
      this.closeDraft();
      if (!this.polling) this.startLive();
    } else if (this.polling && phase !== null) {
      await this.endLive();
    }
  }

  // ------------------------------------------------------------ champ select

  private async champions(lc: LeagueClient) {
    if (this.champs?.size) return this.champs;
    const list = await lc.lcuGet<{ id: number; name: string; alias: string }[]>("/lol-game-data/assets/v1/champion-summaries.json");
    this.champs = new Map((list ?? []).filter((c) => c.id > 0).map((c) => [c.id, { name: c.name, alias: c.alias }]));
    return this.champs;
  }

  private async updateDraft() {
    const lc = await this.deps.league();
    const sess = await lc.lcuGet<ChampSelectSession>("/lol-champ-select/v1/session");
    if (!sess) return;
    const champs = await this.champions(lc);
    const me = sess.myTeam?.find((p) => p.cellId === sess.localPlayerCellId);
    const myId = me?.championId || me?.championPickIntent || 0;
    const role = POS[(me?.assignedPosition ?? "").toLowerCase()] ?? "";
    const enemyCell = role ? sess.theirTeam?.find((p) => POS[(p.assignedPosition ?? "").toLowerCase()] === role && p.championId) : undefined;
    const info = this.buildDraft(champs.get(myId)?.alias ?? null, champs.get(myId)?.name ?? null, role, enemyCell ? champs.get(enemyCell.championId)?.alias ?? null : null, enemyCell ? champs.get(enemyCell.championId)?.name ?? null : null);
    this.draftInfo = info;
    this.showDraft();
    this.draft?.webContents.send("mind:draft", info);
  }

  buildDraft(champion: string | null, championName: string | null, role: Position, enemy: string | null, enemyName: string | null): DraftInfo {
    const reports = this.deps.reports();
    const baseline = baselineFrom(reports, role || undefined);
    const defs = challengeDefs(baseline);
    const plan = coachPlan(reports);
    const opt = (id: ChallengeId, reason: string): DraftOption => ({ id, title: defs[id].title, rule: defs[id].rule, why: defs[id].why, pass: defs[id].pass, reason });
    const skill: DraftOption[] = [];
    const add = (id: ChallengeId, reason: string) => !skill.some((s) => s.id === id) && skill.push(opt(id, reason));
    if (plan.current) add(ISSUE_CHALLENGE[plan.current.id], plan.current.evidence);
    for (const i of plan.upNext) add(ISSUE_CHALLENGE[i.id], i.evidence);
    for (const id of ["deaths14", "cs10", "vision"] as ChallengeId[]) if (skill.length < 3) add(id, "A solid default while the coach learns your games.");
    if (role === "UTILITY") {
      const i = skill.findIndex((s) => s.id === "cs10");
      if (i >= 0) skill.splice(i, 1, opt("vision", "Supports win games with vision more than with farm."));
    }
    const mentalPick = suggestMental(reports, this.data.records);
    const mental = (["reset_after_death", "steady_after_death", "check_ins"] as ChallengeId[]).map((id) => opt(id, id === mentalPick.id ? mentalPick.reason : defs[id].why));
    const lastDb = this.data.debriefs[0];
    return {
      phase: this.draftPlan ? "locked" : "champ-select",
      champion,
      championName,
      role,
      enemy,
      enemyName,
      read: champion ? matchupRead(reports, champion, enemy) : null,
      skillOptions: skill.slice(0, 3),
      mentalOptions: mental,
      recommendedSkill: skill[0]?.id ?? "deaths14",
      recommendedMental: mentalPick.id,
      queue: queueCheck(tiltProfile(reports), this.data.debriefs),
      plan: this.draftPlan,
      lastIntention: lastDb?.nextIntention || null,
    };
  }

  /** From the draft card (or the Mind tab): lock the goals for the next game. */
  async lockPlan(p: { skill: ChallengeId; mental: ChallengeId; intention: string; champion?: string; role?: Position }) {
    const info = this.draftInfo;
    const role = (p.role ?? info?.role ?? "") as Position;
    const plan: GamePlan = {
      createdAt: Date.now(),
      champion: p.champion ?? info?.champion ?? "",
      role,
      skill: p.skill,
      mental: p.mental,
      intention: p.intention.trim(),
      baseline: baselineFrom(this.deps.reports(), role || undefined),
    };
    this.draftPlan = plan;
    if (this.draftInfo) {
      this.draftInfo = { ...this.draftInfo, phase: "locked", plan };
      this.draft?.webContents.send("mind:draft", this.draftInfo);
    }
    this.deps.send("mind:plan", plan);
    return plan;
  }

  get nextPlan() {
    return this.draftPlan;
  }

  private rendererLoad(win: BrowserWindow, hash: string) {
    const r = this.deps.rendererUrl(hash);
    if (r.url) win.loadURL(`${r.url}#${r.hash}`);
    else win.loadFile(r.file!, { hash: r.hash });
  }

  private showDraft() {
    if (this.draft && !this.draft.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const w = 392;
    const h = Math.min(680, wa.height - 80);
    this.draft = new BrowserWindow({
      x: wa.x + wa.width - w - 24,
      y: wa.y + 60,
      width: w,
      height: h,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: "League Coach draft",
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false },
    });
    this.draft.setAlwaysOnTop(true, "floating");
    this.rendererLoad(this.draft, "draft");
    this.draft.once("ready-to-show", () => {
      this.draft?.showInactive();
      if (this.draftInfo) this.draft?.webContents.send("mind:draft", this.draftInfo);
    });
    this.draft.on("closed", () => (this.draft = null));
  }

  closeDraft() {
    if (this.draft && !this.draft.isDestroyed()) this.draft.close();
    this.draft = null;
  }

  get currentDraft() {
    return this.draftInfo;
  }

  // ------------------------------------------------------------ live game

  private startLive() {
    this.polling = true;
    this.tracker = null;
    this.trackerGameId = null;
    const tick = async () => {
      if (!this.polling) return;
      try {
        await this.poll();
      } catch {
        /* keep polling */
      }
      if (this.polling) this.pollTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  private async poll() {
    const d = await getJson<AllGameData>("https://127.0.0.1:2999/liveclientdata/allgamedata");
    if (!isPlayableGame(d)) return;
    const s = await this.deps.settings();
    if (!this.tracker) {
      const lc = await this.deps.league();
      this.trackerGameId = (await lc.currentGameId()) ?? `local-${Date.now()}`;
      // No goal locked in champ select (card closed, or draft companion off): use the recommended pair.
      const me = findMe(d);
      const auto = this.buildDraft(null, null, (me?.position as Position) || "", null, null);
      const base = this.draftPlan ?? { createdAt: Date.now(), champion: "", role: auto.role, skill: auto.recommendedSkill, mental: auto.recommendedMental, intention: "", baseline: baselineFrom(this.deps.reports(), auto.role || undefined) };
      const plan: GamePlan = { ...base, gameId: this.trackerGameId };
      this.tracker = new LiveTracker(plan, plan.baseline);
      this.data.plans = [plan, ...this.data.plans].slice(0, 200);
      this.draftPlan = null;
      if (s.overlay !== false) this.showOverlay();
      this.registerKeys();
    }
    this.lastData = d;
    this.tracker.update(d);
    const view = this.tracker.view();
    this.pushView(view, s);
    this.setCheckInKeys(view.isDead);
  }

  private pushView(view: LiveView, s?: Settings) {
    const payload = { view, hidden: this.hidden, editing: this.editing, pos: s?.overlayPos ?? null, nudges: s?.overlayNudges !== false, intention: this.tracker?.plan?.intention ?? "", rules: this.rulesFor() };
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.webContents.send("mind:live", payload);
    this.deps.send("mind:live", payload);
  }

  private rulesFor() {
    const t = this.tracker;
    if (!t) return null;
    return { skill: t.defs[t.skillId].rule, mental: t.defs[t.mentalId].rule, skillId: t.skillId, mentalId: t.mentalId };
  }

  private async endLive() {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.closeOverlay();
    this.unregisterKeys();
    const t = this.tracker;
    const gameId = this.trackerGameId;
    this.tracker = null;
    if (!t || !gameId || t.gameTime < 300) return; // remakes and crashes before 5:00 aren't worth a debrief
    const rec = t.finish(gameId, resultOf(this.lastData));
    this.data.records = [rec, ...this.data.records.filter((r) => r.gameId !== gameId)].slice(0, 300);
    this.data.pending = [gameId, ...this.data.pending.filter((g) => g !== gameId)].slice(0, 10);
    await this.save();
    const s = await this.deps.settings();
    if (s.autoDebrief !== false) {
      this.deps.send("mind:debrief", gameId);
      this.deps.focusMain();
    }
  }

  checkIn(rating: number) {
    if (!this.tracker) return;
    this.tracker.checkIn(rating);
    this.deps.settings().then((s) => this.tracker && this.pushView(this.tracker.view(), s));
  }

  // ------------------------------------------------------------ overlay window

  private showOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) return;
    const b = screen.getPrimaryDisplay().bounds;
    this.overlay = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: "League Coach overlay",
      webPreferences: { preload: this.deps.preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    // "screen-saver" sits above borderless-fullscreen games on Windows.
    this.overlay.setAlwaysOnTop(true, "screen-saver");
    this.overlay.setIgnoreMouseEvents(true);
    this.overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.rendererLoad(this.overlay, "live-overlay");
    this.overlay.once("ready-to-show", () => this.overlay?.showInactive());
    this.overlay.on("closed", () => (this.overlay = null));
  }

  private closeOverlay() {
    if (this.demo) clearInterval(this.demo);
    this.demo = null;
    this.editing = false;
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.close();
    this.overlay = null;
  }

  toggleHidden() {
    this.hidden = !this.hidden;
    this.refresh();
  }

  /** Edit mode: the overlay takes the mouse so the cards can be dragged. */
  setEditing(on: boolean) {
    this.editing = on;
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.setIgnoreMouseEvents(!on);
      this.overlay.setFocusable(on);
      if (on) this.overlay.focus();
    }
    this.refresh();
  }

  private refresh() {
    this.deps.settings().then((s) => {
      if (this.tracker) this.pushView(this.tracker.view(), s);
      else if (this.demo && this.overlay) this.overlay.webContents.send("mind:live", { ...demoPayload(), hidden: this.hidden, editing: this.editing, pos: s.overlayPos ?? null, nudges: s.overlayNudges !== false });
    });
  }

  /** Shows the overlay with sample data so it can be placed and previewed outside a game. */
  async preview() {
    if (this.tracker) return;
    this.showOverlay();
    this.registerKeys();
    this.setEditing(true);
    if (this.demo) clearInterval(this.demo);
    this.demo = setInterval(() => this.refresh(), 1000);
    this.overlay?.webContents.once("did-finish-load", () => this.refresh());
  }

  endPreview() {
    if (this.tracker) return this.setEditing(false);
    this.closeOverlay();
    this.unregisterKeys();
  }

  // ------------------------------------------------------------ hotkeys

  private registerKeys() {
    const reg = (acc: string, fn: () => void) => {
      try {
        if (!globalShortcut.isRegistered(acc)) globalShortcut.register(acc, fn);
      } catch {
        /* taken by another app */
      }
    };
    reg("CommandOrControl+Shift+H", () => this.toggleHidden());
    reg("CommandOrControl+Shift+E", () => (this.demo ? this.endPreview() : this.setEditing(!this.editing)));
  }

  /** Number hotkeys only exist while you're dead, so they never shadow a binding mid-fight. */
  private setCheckInKeys(on: boolean) {
    if (on === this.checkInKeys) return;
    this.checkInKeys = on;
    for (let n = 1; n <= 5; n++) {
      const acc = `CommandOrControl+Shift+${n}`;
      try {
        if (on) globalShortcut.register(acc, () => this.checkIn(n));
        else globalShortcut.unregister(acc);
      } catch {
        /* ignore */
      }
    }
  }

  private unregisterKeys() {
    this.setCheckInKeys(false);
    for (const acc of ["CommandOrControl+Shift+H", "CommandOrControl+Shift+E"]) {
      try {
        globalShortcut.unregister(acc);
      } catch {
        /* ignore */
      }
    }
  }

  // ------------------------------------------------------------ debriefs

  async saveDebrief(db: Debrief) {
    this.data.debriefs = [db, ...this.data.debriefs.filter((d) => d.gameId !== db.gameId)].slice(0, 300);
    this.data.pending = this.data.pending.filter((g) => g !== db.gameId);
    await this.save();
    return this.data;
  }

  async skipDebrief(gameId: string) {
    this.data.pending = this.data.pending.filter((g) => g !== gameId);
    await this.save();
    return this.data;
  }

  /** Overlay needs League in borderless or windowed mode; exclusive fullscreen draws over it. */
  async windowMode(leagueDir: string): Promise<"fullscreen" | "windowed" | "borderless" | "unknown"> {
    const names = { "0": "fullscreen", "1": "windowed", "2": "borderless" } as const;
    try {
      const raw = await fs.readFile(path.join(leagueDir, "Config", "PersistedSettings.json"), "utf8");
      const j = JSON.parse(raw) as { files?: { sections?: { settings?: { name: string; value: string }[] }[] }[] };
      for (const f of j.files ?? []) for (const sct of f.sections ?? []) for (const st of sct.settings ?? []) if (st.name === "WindowMode") return names[st.value as "0"] ?? "unknown";
    } catch {
      /* fall through */
    }
    try {
      const cfg = await fs.readFile(path.join(leagueDir, "Config", "game.cfg"), "utf8");
      const m = cfg.match(/^\s*WindowMode\s*=\s*(\d)/im);
      if (m) return names[m[1] as "0"] ?? "unknown";
    } catch {
      /* ignore */
    }
    return "unknown";
  }

  stop() {
    this.polling = false;
    this.unregisterKeys();
    this.closeOverlay();
    this.closeDraft();
  }
}

/** Sample overlay state for the placement preview. */
function demoPayload() {
  const now = Date.now() / 1000;
  const dead = Math.floor(now / 12) % 3 === 2;
  const t = 612 + (now % 600);
  const view: LiveView = {
    gameTime: t,
    champion: "Ahri",
    role: "MIDDLE",
    isDead: dead,
    respawnIn: dead ? 12 - Math.floor(now % 12) : 0,
    gold: 1240,
    kda: [3, 2, 4],
    cs: 74,
    focus: 72,
    skill: { id: "cs10", kind: "skill", title: "70 CS by 10:00", status: "passed", progress: 1, value: "74 / 70", detail: "Hit at 10:00" },
    mental: { id: "reset_after_death", kind: "mental", title: "Reset after every death", status: dead ? "at-risk" : "on-track", progress: dead ? 0 : 0.6, value: dead ? "Dead" : "36s", detail: dead ? "Breathe. Plan the next 90s." : "Farm and ward, no trades" },
    deaths: [],
    lastDeath: dead ? { t: t - 4, gold: 1240, killer: "Preview", killerChamp: "LeeSin", helpers: 1, jungler: true, streak: 0, chain: false, respawnAt: t + 12, beforeObjective: null, csBefore: 7.2, csAfter: null, checkIn: null } : null,
    nudges: Math.floor(now / 9) % 2 === 0 ? [{ key: "demo", at: t, tone: "info", text: "Dragon in 58s. Reset now if you need to, then group. No solo side lane." }] : [],
    nextObjective: { name: "Dragon", inSec: 58 },
  };
  return { view, intention: "Play for the long game", rules: { skill: "Last hit first, trade second. Never miss a cannon.", mental: "First 90s after you respawn: farm, ward, no trades.", skillId: "cs10", mentalId: "reset_after_death" }, preview: true };
}
