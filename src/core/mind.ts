import { benchmarkFor } from "./benchmarks";
import type { IssueId } from "./coach";
import { AllGameData, champKey, enemyJungler, findMe, isPlayer, itemGold, laneOpponent, LivePlayer } from "./live";
import type { GameReport, Position } from "./types";
import { champName } from "./names";

/**
 * The mental game: one goal you pick before the game, live challenges that track it while
 * you play, a focus read built from what you do after deaths and how you rate your own head,
 * and a debrief afterwards.
 *
 * Everything here is pure so it can be replayed from recorded snapshots in tests.
 */

// ---------------------------------------------------------------- challenges

export type ChallengeId =
  | "cs10"
  | "deaths14"
  | "no_gank_deaths"
  | "gold_on_death"
  | "objective_safety"
  | "no_shutdown"
  | "lane_cs"
  | "item_lead"
  | "kill_participation"
  | "vision"
  | "full_backs"
  | "reset_after_death"
  | "steady_after_death"
  | "check_ins";

export type ChallengeKind = "skill" | "mental";

export interface ChallengeDef {
  id: ChallengeId;
  kind: ChallengeKind;
  /** Short name for the overlay. */
  title: string;
  /** The one thing to do, shown in champ select and on the death card. */
  rule: string;
  /** Why it is worth a game of focus. */
  why: string;
  /** Pass line, e.g. "70 CS at 10:00". */
  pass: string;
  target: number;
}

export type ChallengeStatus = "pending" | "on-track" | "at-risk" | "failed" | "passed";

export interface ChallengeState {
  id: ChallengeId;
  kind: ChallengeKind;
  title: string;
  status: ChallengeStatus;
  /** 0..1 for the bar. */
  progress: number;
  /** "47 / 62", "0 of 1 allowed", ... */
  value: string;
  /** One short line under the bar. */
  detail: string;
}

/** Personal numbers the targets are built from, from recent games. */
export interface Baseline {
  role: Position;
  games: number;
  cs10: number | null;
  deathsPre14: number | null;
  visionPerMin: number | null;
  killParticipation: number | null;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const fmtG = (n: number) => `${Math.round(n).toLocaleString("en-US")}g`;
export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function baselineFrom(reports: GameReport[], role?: Position): Baseline {
  const counts = new Map<Position, number>();
  for (const r of reports.slice(0, 20)) counts.set(r.metrics.role, (counts.get(r.metrics.role) ?? 0) + 1);
  const main = role || ([...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "MIDDLE");
  const rs = reports.filter((r) => r.metrics.role === main).slice(0, 15);
  const m = (f: (r: GameReport) => number) => (rs.length ? avg(rs.map(f)) : null);
  return {
    role: main,
    games: rs.length,
    cs10: m((r) => r.metrics.cs10),
    deathsPre14: m((r) => r.metrics.deathsPre14),
    visionPerMin: m((r) => r.metrics.visionPerMin),
    killParticipation: m((r) => r.metrics.killParticipation),
  };
}

/**
 * Targets are a stretch from where you are, not a fixed rank number: a little above your own
 * average, never below the rank benchmark, capped where it stops being realistic.
 */
export function challengeDefs(b: Baseline): Record<ChallengeId, ChallengeDef> {
  const bm = benchmarkFor(b.role);
  const support = b.role === "UTILITY";
  const jungle = b.role === "JUNGLE";
  const cs10 = Math.round(Math.min(jungle ? 72 : 86, Math.max(bm.cs10, (b.cs10 ?? bm.cs10) * 1.08 + 2)));
  const vis = Math.round(Math.max(bm.visionPerMin, (b.visionPerMin ?? bm.visionPerMin) * 1.15) * 10) / 10;
  const kp = Math.round(Math.min(0.75, Math.max(bm.killParticipation, (b.killParticipation ?? bm.killParticipation) + 0.05)) * 100);
  return {
    cs10: {
      id: "cs10", kind: "skill", title: `${cs10} CS by 10:00`, target: cs10,
      rule: jungle ? "Full clear into the scuttle, then path to the side with the next camp up." : "Last hit first, trade second. Never miss a cannon.",
      why: "10 CS is about a kill's worth of gold, and nobody can gank you for it.",
      pass: `${cs10}+ CS at 10:00`,
    },
    deaths14: {
      id: "deaths14", kind: "skill", title: "1 death max before 14:00", target: 1,
      rule: "Before every trade: is their main spell up? If yes, don't step up.",
      why: "Each early death is about 300g plus a wave and a level you never get back.",
      pass: "1 or fewer deaths before 14:00",
    },
    no_gank_deaths: {
      id: "no_gank_deaths", kind: "skill", title: "Don't die to their jungler", target: 0,
      rule: "Lost sight of their jungler for 30s? Stand behind your wave.",
      why: "Ganks are pure information. You can't outplay a 2v1, but you can not be there.",
      pass: "No deaths involving their jungler before 14:00",
    },
    gold_on_death: {
      id: "gold_on_death", kind: "skill", title: "Never die holding 1,300g", target: 1300,
      rule: "1,100g+ and the wave is crashing? Back now.",
      why: "Gold in your pocket doesn't fight. Dying with it wastes the item and the trip.",
      pass: "No death holding 1,300g or more",
    },
    objective_safety: {
      id: "objective_safety", kind: "skill", title: "Alive for every dragon and baron", target: 60,
      rule: "60s before dragon or baron: reset, group, no face-checks.",
      why: "A death right before an objective usually hands it over for free.",
      pass: "No death in the 60s before a dragon or baron spawns",
    },
    no_shutdown: {
      id: "no_shutdown", kind: "skill", title: "Don't give a shutdown", target: 0,
      rule: "On a 2+ kill streak: back, buy, and fight only with your team close.",
      why: "A shutdown pays them for the lead you built.",
      pass: "No death while on a 2+ kill streak",
    },
    lane_cs: {
      id: "lane_cs", kind: "skill", title: "Out-farm your lane opponent", target: 0,
      rule: "Don't take a trade that costs you a cannon or two casters.",
      why: "Every minion they get that you don't is gold they fight you with.",
      pass: "Even or ahead in CS against your lane opponent at 14:00",
    },
    item_lead: {
      id: "item_lead", kind: "skill", title: "Even or ahead on items at 15:00", target: 0,
      rule: "Behind? Stop fighting and farm. Even CS beats a second death.",
      why: "Being behind at 15 makes every fight after it harder.",
      pass: "Item gold even or ahead of your lane opponent at 15:00",
    },
    kill_participation: {
      id: "kill_participation", kind: "skill", title: `${kp}% kill participation`, target: kp,
      rule: "When a wave crashes, look at the map. Fight coming? Shove and walk.",
      why: "After laning the game is won in groups. Absent means 4v5.",
      pass: `${kp}%+ kill participation`,
    },
    vision: {
      id: "vision", kind: "skill", title: `${vis.toFixed(1)} vision per minute`, target: vis,
      rule: support ? "Trinket off cooldown? Use it. Control ward every back." : "Trinket off cooldown? Use it. One control ward every back.",
      why: "Most ganks and bad deaths happen where you had no ward.",
      pass: `${vis.toFixed(1)}+ vision score per minute`,
    },
    full_backs: {
      id: "full_backs", kind: "skill", title: "Back with a real item", target: 900,
      rule: "Back with 1,100g+ on a crashed wave, not with 400g on a fresh one.",
      why: "A small back costs the same walk as a big one.",
      pass: "No more than one back under 900g after 4:00",
    },
    reset_after_death: {
      id: "reset_after_death", kind: "mental", title: "Reset after every death", target: 90,
      rule: "First 90s after you respawn: farm, ward, no trades. Win the next minute, not the last one.",
      why: "The death right after a death is the tilt death. It's the one that loses games.",
      pass: "Never die again within 90s of respawning",
    },
    steady_after_death: {
      id: "steady_after_death", kind: "mental", title: "Keep farming after deaths", target: 0.8,
      rule: "Died? Your job is the next wave, not revenge.",
      why: "Tilt shows up in your farm before it shows up in your deaths.",
      pass: "CS rate after each death stays at 80%+ of before",
    },
    check_ins: {
      id: "check_ins", kind: "mental", title: "Check in on every death", target: 0.75,
      rule: "While dead: one slow breath, then rate your head with Ctrl+Shift+1 to 5.",
      why: "Naming how you feel takes the edge off it. It's the cheapest tilt fix there is.",
      pass: "Rate your focus on 3 of every 4 deaths",
    },
  };
}

/** The live challenge that best trains each coach issue. */
export const ISSUE_CHALLENGE: Record<IssueId, ChallengeId> = {
  early_deaths: "deaths14",
  ganks: "no_gank_deaths",
  overextending: "deaths14",
  unspent_gold: "gold_on_death",
  objective_deaths: "objective_safety",
  shutdowns: "no_shutdown",
  farming: "cs10",
  losing_lane: "item_lead",
  absent_from_fights: "kill_participation",
  vision: "vision",
  recall_timing: "full_backs",
  lane_farm: "lane_cs",
};

export const MENTAL_CHALLENGES: ChallengeId[] = ["reset_after_death", "steady_after_death", "check_ins"];

/** The game plan locked in during champ select. */
export interface GamePlan {
  createdAt: number;
  /** Filled in when the game starts. */
  gameId?: string;
  champion: string;
  role: Position;
  skill: ChallengeId;
  mental: ChallengeId;
  /** "Play for the long game", typed or picked. */
  intention: string;
  baseline: Baseline;
}

// ---------------------------------------------------------------- live tracker

export interface DeathRec {
  t: number;
  gold: number;
  killer: string;
  killerChamp: string | null;
  helpers: number;
  jungler: boolean;
  /** Kills since your last death, right before this one. */
  streak: number;
  /** Died again within 90s of respawning. */
  chain: boolean;
  respawnAt: number;
  /** Seconds until a dragon/baron spawn, when under 60. */
  beforeObjective: { name: string; inSec: number } | null;
  /** CS per minute in the 3 minutes before and after (after is filled in later). */
  csBefore: number | null;
  csAfter: number | null;
  checkIn: number | null;
}

export interface Nudge {
  key: string;
  at: number;
  tone: "info" | "warn" | "good";
  text: string;
}

export interface LiveView {
  gameTime: number;
  champion: string;
  role: Position;
  isDead: boolean;
  respawnIn: number;
  gold: number;
  kda: [number, number, number];
  cs: number;
  focus: number;
  skill: ChallengeState;
  mental: ChallengeState;
  deaths: DeathRec[];
  /** The death you are dead from right now. */
  lastDeath: DeathRec | null;
  nudges: Nudge[];
  nextObjective: { name: string; inSec: number } | null;
}

/** What gets saved when the game ends, and what the debrief reads. */
export interface LiveRecord {
  gameId: string;
  startedAt: number;
  durationSec: number;
  champion: string;
  role: Position;
  plan: GamePlan | null;
  skill: ChallengeState;
  mental: ChallengeState;
  focus: number;
  deaths: DeathRec[];
  checkIns: { t: number; rating: number }[];
  backs: { t: number; gold: number }[];
  csAt: { t: number; cs: number }[];
  win: boolean | null;
}

const ROLE_MAP: Record<string, Position> = { TOP: "TOP", JUNGLE: "JUNGLE", MIDDLE: "MIDDLE", BOTTOM: "BOTTOM", UTILITY: "UTILITY" };

export class LiveTracker {
  defs: Record<ChallengeId, ChallengeDef>;
  skillId: ChallengeId;
  mentalId: ChallengeId;
  private last: AllGameData | null = null;
  private me: LivePlayer | null = null;
  private wasDead = false;
  private aliveGold = 0;
  private aliveSince = 0;
  private richSince: number | null = null;
  private killsAtLastDeath = 0;
  private prevItemGold = 0;
  private prevGold = 0;
  deaths: DeathRec[] = [];
  backs: { t: number; gold: number }[] = [];
  csAt: { t: number; cs: number }[] = [];
  checkIns: { t: number; rating: number }[] = [];
  private nudges: Nudge[] = [];
  private nudged = new Set<string>();
  private csAt10: number | null = null;
  private csDiffAt14: number | null = null;
  private itemDiffAt15: number | null = null;
  private nextDragon = 300;
  private nextBaron = 1200;
  private seenEvents = new Set<number>();
  private teamKills = 0;
  readonly startedAt: number;

  constructor(public plan: GamePlan | null, baseline: Baseline, now = Date.now()) {
    this.defs = challengeDefs(plan?.baseline ?? baseline);
    this.skillId = plan?.skill ?? "deaths14";
    this.mentalId = plan?.mental ?? "reset_after_death";
    this.startedAt = now;
  }

  get gameTime() {
    return this.last?.gameData?.gameTime ?? 0;
  }

  get role(): Position {
    return ROLE_MAP[this.me?.position ?? ""] ?? this.plan?.role ?? "";
  }

  /** Feed one /allgamedata snapshot. */
  update(d: AllGameData) {
    const me = findMe(d);
    if (!me) return;
    const t = d.gameData?.gameTime ?? 0;
    const gold = d.activePlayer?.currentGold ?? 0;
    this.last = d;
    this.me = me;
    this.readEvents(d, me);

    // CS samples every ~10s, for pace and post-death farm.
    const lastCs = this.csAt[this.csAt.length - 1];
    if (!lastCs || t - lastCs.t >= 10) this.csAt.push({ t, cs: me.scores.creepScore });
    if (this.csAt10 === null && t >= 600) this.csAt10 = this.csAtTime(600);
    const opp = laneOpponent(d, me);
    if (this.csDiffAt14 === null && t >= 840 && opp) this.csDiffAt14 = me.scores.creepScore - opp.scores.creepScore;
    if (this.itemDiffAt15 === null && t >= 900 && opp) this.itemDiffAt15 = itemGold(me) - itemGold(opp);

    // Deaths.
    if (me.isDead && !this.wasDead) this.onDeath(d, me, t);
    if (!me.isDead && this.wasDead) this.aliveSince = t;
    this.wasDead = me.isDead;

    // Backs: gold dropped and items went up while alive (buying in fountain).
    const ig = itemGold(me);
    if (!me.isDead && t > 90 && this.prevGold - gold >= 250 && ig > this.prevItemGold) {
      const lastBack = this.backs[this.backs.length - 1];
      if (!lastBack || t - lastBack.t > 40) this.backs.push({ t, gold: this.prevGold });
    }
    this.prevItemGold = ig;
    this.prevGold = gold;
    if (!me.isDead) this.aliveGold = gold;

    // Fill in CS rate after deaths once 3 minutes have passed since the respawn.
    for (const dr of this.deaths) {
      if (dr.csAfter === null && t >= dr.respawnAt + 180) dr.csAfter = this.csRate(dr.respawnAt, dr.respawnAt + 180);
    }
    this.makeNudges(t, gold, me);
  }

  private readEvents(d: AllGameData, me: LivePlayer) {
    for (const e of d.events?.Events ?? []) {
      if (this.seenEvents.has(e.EventID)) continue;
      this.seenEvents.add(e.EventID);
      if (e.EventName === "DragonKill") this.nextDragon = e.DragonType === "Elder" ? e.EventTime + 360 : e.EventTime + 300;
      if (e.EventName === "BaronKill") this.nextBaron = e.EventTime + 360;
      if (e.EventName === "ChampionKill") {
        const killer = d.allPlayers?.find((p) => isPlayer(p, e.KillerName));
        if (killer && killer.team === me.team) this.teamKills++;
      }
    }
  }

  private onDeath(d: AllGameData, me: LivePlayer, t: number) {
    const kill = [...(d.events?.Events ?? [])].reverse().find((e) => e.EventName === "ChampionKill" && isPlayer(me, e.VictimName) && t - e.EventTime < 6);
    const killer = d.allPlayers?.find((p) => isPlayer(p, kill?.KillerName));
    const helpers = (kill?.Assisters ?? []).map((n) => d.allPlayers?.find((p) => isPlayer(p, n))).filter((p): p is LivePlayer => !!p);
    const jg = enemyJungler(d, me);
    const prev = this.deaths[this.deaths.length - 1];
    const obj = this.objectiveIn(t);
    this.deaths.push({
      t,
      gold: this.aliveGold,
      killer: killer?.riotIdGameName ?? kill?.KillerName ?? "Unknown",
      killerChamp: killer?.championName ?? (kill?.KillerName?.startsWith("Turret") ? "Tower" : null),
      helpers: helpers.length,
      jungler: !!jg && [killer, ...helpers].some((p) => p && isPlayer(jg, p.riotIdGameName ?? p.summonerName)),
      streak: me.scores.kills - this.killsAtLastDeath,
      chain: !!prev && t - prev.respawnAt <= 90,
      respawnAt: t + Math.max(me.respawnTimer, 6),
      beforeObjective: obj && obj.inSec <= 60 ? obj : null,
      csBefore: this.csRate(Math.max(90, t - 180), t),
      csAfter: null,
      checkIn: null,
    });
    this.killsAtLastDeath = me.scores.kills;
  }

  /** Focus rating from a hotkey (1-5). Attaches to the death you're dead from, if any. */
  checkIn(rating: number) {
    const t = this.gameTime;
    this.checkIns.push({ t, rating });
    const d = this.deaths[this.deaths.length - 1];
    if (d && d.checkIn === null && t <= d.respawnAt + 20) d.checkIn = rating;
  }

  private objectiveIn(t: number): { name: string; inSec: number } | null {
    const opts = [
      { name: "Dragon", inSec: this.nextDragon - t },
      { name: "Baron", inSec: this.nextBaron - t },
    ].filter((o) => o.inSec > 0);
    return opts.sort((a, b) => a.inSec - b.inSec)[0] ?? null;
  }

  private csAtTime(sec: number): number {
    let best = this.csAt[0]?.cs ?? 0;
    for (const s of this.csAt) if (s.t <= sec) best = s.cs;
    return best;
  }

  /** CS per minute between two game times. */
  csRate(from: number, to: number): number | null {
    if (to - from < 30) return null;
    return ((this.csAtTime(to) - this.csAtTime(from)) / (to - from)) * 60;
  }

  private nudge(key: string, t: number, tone: Nudge["tone"], text: string) {
    if (this.nudged.has(key)) return;
    this.nudged.add(key);
    this.nudges.push({ key, at: t, tone, text });
  }

  private makeNudges(t: number, gold: number, me: LivePlayer) {
    const goals = [this.skillId, this.mentalId];
    // Objectives: everyone sees these timers on the scoreboard; this only connects them to your goal.
    const obj = this.objectiveIn(t);
    if (obj && obj.inSec <= 60 && obj.inSec > 45) {
      this.nudge(`obj-${obj.name}-${Math.round(t + obj.inSec)}`, t, goals.includes("objective_safety") ? "warn" : "info", `${obj.name} in ${Math.round(obj.inSec)}s. Reset now if you need to, then group. No solo side lane.`);
    }
    // Rich and alive.
    if (!me.isDead && gold >= 1300 && t > 180) {
      this.richSince ??= t;
      if (t - this.richSince >= 40) this.nudge(`rich-${Math.floor(t / 240)}`, t, goals.includes("gold_on_death") || goals.includes("full_backs") ? "warn" : "info", `${fmtG(gold)} in your pocket. Back when this wave crashes.`);
    } else this.richSince = null;
    // CS pace.
    if (this.skillId === "cs10" && this.role !== "UTILITY") {
      const target = this.defs.cs10.target;
      for (const at of [300, 480]) {
        if (t >= at && t < at + 20) {
          const pace = Math.round((me.scores.creepScore / Math.max(t - 65, 1)) * (600 - 65));
          this.nudge(`pace-${at}`, t, pace >= target ? "good" : "warn", pace >= target ? `On pace for ${pace} CS at 10:00. Keep it.` : `On pace for ${pace} CS at 10:00, target ${target}. Next cannon is yours.`);
        }
      }
    }
    // Shutdown risk.
    const streak = me.scores.kills - this.killsAtLastDeath;
    if (streak >= 2 && !me.isDead) this.nudge(`streak-${me.scores.kills}`, t, goals.includes("no_shutdown") ? "warn" : "info", `You're worth a shutdown. Spend it: back, buy, then fight with your team close.`);
    // Back in game after a death.
    const d = this.deaths[this.deaths.length - 1];
    if (d && !me.isDead && t >= d.respawnAt - 2 && t < d.respawnAt + 15) {
      this.nudge(`respawn-${d.t}`, t, "info", this.mentalId === "reset_after_death" ? "Back in. Next 90s: farm and ward, no trades." : `Back in. ${this.defs[this.skillId].rule}`);
    }
    if (d && !me.isDead && t > d.respawnAt + 90 && t < d.respawnAt + 100 && this.mentalId === "reset_after_death") {
      this.nudge(`reset-ok-${d.t}`, t, "good", "90s alive after respawn. Reset done.");
    }
    this.nudges = this.nudges.filter((n) => t - n.at < 9);
  }

  /** State of one challenge right now (or final, when `final`). */
  evaluate(id: ChallengeId, final = false): ChallengeState {
    const def = this.defs[id];
    const t = this.gameTime;
    const me = this.me;
    const base = { id, kind: def.kind, title: def.title };
    const s = (status: ChallengeStatus, progress: number, value: string, detail: string): ChallengeState => ({ ...base, status, progress: clamp01(progress), value, detail });
    if (!me) return s("pending", 0, "", "Waiting for the game");
    const deaths = this.deaths;
    const opp = this.last ? laneOpponent(this.last, me) : null;
    switch (id) {
      case "cs10": {
        const cs = this.csAt10 ?? me.scores.creepScore;
        if (this.csAt10 !== null) return s(cs >= def.target ? "passed" : "failed", cs / def.target, `${cs} / ${def.target}`, cs >= def.target ? "Hit at 10:00" : `${def.target - cs} short at 10:00`);
        const pace = t > 90 ? Math.round((cs / (t - 65)) * (600 - 65)) : null;
        return s(pace === null ? "pending" : pace >= def.target ? "on-track" : "at-risk", cs / def.target, `${cs} / ${def.target}`, pace === null ? "Minions arrive at 1:05" : `On pace for ${pace}`);
      }
      case "deaths14": {
        const n = deaths.filter((d) => d.t < 840).length;
        const done = t >= 840 || final;
        if (n > 1) return s("failed", 1, `${n} deaths`, `Over the limit at ${mmss(deaths.filter((d) => d.t < 840)[1].t)}`);
        return s(done ? "passed" : n === 1 ? "at-risk" : "on-track", Math.min(t, 840) / 840, `${n} of 1`, done ? "Made it to 14:00" : `${mmss(Math.max(0, 840 - t))} to go${n ? ", no more" : ""}`);
      }
      case "no_gank_deaths": {
        const g = deaths.find((d) => d.t < 840 && d.jungler);
        if (g) return s("failed", 1, "Ganked", `Their jungler at ${mmss(g.t)}`);
        const done = t >= 840 || final;
        return s(done ? "passed" : "on-track", Math.min(t, 840) / 840, done ? "Clean" : mmss(Math.max(0, 840 - t)), done ? "No gank deaths in laning" : "Track their jungler");
      }
      case "gold_on_death": {
        const bad = deaths.find((d) => d.gold >= def.target);
        if (bad) return s("failed", 1, `Died with ${fmtG(bad.gold)}`, `At ${mmss(bad.t)}`);
        const g = this.last?.activePlayer?.currentGold ?? 0;
        return s(final ? "passed" : g >= 1100 ? "at-risk" : "on-track", final ? 1 : g / def.target, fmtG(g), final ? "Never died rich" : g >= 1100 ? "Back soon" : "Holding fine");
      }
      case "objective_safety": {
        const bad = deaths.find((d) => d.beforeObjective);
        if (bad) return s("failed", 1, `Died before ${bad.beforeObjective!.name}`, `${bad.beforeObjective!.inSec | 0}s before spawn`);
        const obj = this.objectiveIn(t);
        return s(final ? "passed" : obj && obj.inSec <= 60 ? "at-risk" : "on-track", final ? 1 : 0.5, obj ? `${obj.name} ${mmss(obj.inSec)}` : "Clean", final ? "Alive for every spawn" : obj && obj.inSec <= 60 ? "Spawn window: stay alive" : "Next spawn");
      }
      case "no_shutdown": {
        const bad = deaths.find((d) => d.streak >= 2);
        if (bad) return s("failed", 1, "Shutdown given", `At ${mmss(bad.t)}`);
        const streak = me.scores.kills - this.killsAtLastDeath;
        return s(final ? "passed" : streak >= 2 ? "at-risk" : "on-track", final ? 1 : streak / 3, streak >= 2 ? `${streak}-kill streak` : "Clean", final ? "No shutdowns" : streak >= 2 ? "Play for your team now" : "Keep it that way");
      }
      case "lane_cs": {
        if (!opp) return s("pending", 0, "", "Lane opponent unknown");
        const diff = this.csDiffAt14 ?? me.scores.creepScore - opp.scores.creepScore;
        const done = this.csDiffAt14 !== null;
        return s(done ? (diff >= 0 ? "passed" : "failed") : diff >= 0 ? "on-track" : "at-risk", 0.5 + diff / 40, `${diff >= 0 ? "+" : ""}${diff} CS`, `vs ${champName(opp.championName)}${done ? " at 14:00" : ""}`);
      }
      case "item_lead": {
        if (!opp) return s("pending", 0, "", "Lane opponent unknown");
        const diff = this.itemDiffAt15 ?? itemGold(me) - itemGold(opp);
        const done = this.itemDiffAt15 !== null;
        return s(done ? (diff >= 0 ? "passed" : "failed") : diff >= -300 ? "on-track" : "at-risk", 0.5 + diff / 3000, `${diff >= 0 ? "+" : "−"}${fmtG(Math.abs(diff))}`, `Items vs ${champName(opp.championName)}${done ? " at 15:00" : ""}`);
      }
      case "kill_participation": {
        const kp = this.teamKills ? Math.round(((me.scores.kills + me.scores.assists) / this.teamKills) * 100) : 0;
        const ok = kp >= def.target;
        if (final) return s(ok ? "passed" : "failed", kp / def.target, `${kp}%`, `Target ${def.target}%`);
        return s(this.teamKills < 3 ? "pending" : ok ? "on-track" : "at-risk", kp / def.target, `${kp}%`, `${me.scores.kills + me.scores.assists} of ${this.teamKills} team kills`);
      }
      case "vision": {
        const mins = Math.max(t / 60, 1);
        const rate = me.scores.wardScore / mins;
        const ok = rate >= def.target;
        if (final) return s(ok ? "passed" : "failed", rate / def.target, rate.toFixed(2), `Target ${def.target.toFixed(1)}/min`);
        return s(t < 240 ? "pending" : ok ? "on-track" : "at-risk", rate / def.target, `${rate.toFixed(1)}/min`, `Vision score ${Math.round(me.scores.wardScore)}`);
      }
      case "full_backs": {
        const small = this.backs.filter((b) => b.t > 240 && b.gold < def.target);
        if (small.length > 1) return s("failed", 1, `${small.length} small backs`, `Last with ${fmtG(small[small.length - 1].gold)}`);
        return s(final ? "passed" : small.length ? "at-risk" : "on-track", this.backs.length / 4, `${this.backs.length} backs`, small.length ? `One small back (${fmtG(small[0].gold)}). No more.` : "All full so far");
      }
      case "reset_after_death": {
        const chain = deaths.find((d) => d.chain);
        if (chain) return s("failed", 1, "Death chain", `Died again ${Math.round(chain.t - (deaths[deaths.indexOf(chain) - 1]?.respawnAt ?? chain.t))}s after respawning`);
        const last = deaths[deaths.length - 1];
        if (!last) return s(final ? "passed" : "on-track", 1, "No deaths", final ? "Nothing to reset from" : "Stay that way");
        const into = t - last.respawnAt;
        if (me.isDead) return s("at-risk", 0, "Dead", "Breathe. Plan the next 90s.");
        if (into < 90) return s("at-risk", into / 90, `${Math.round(90 - into)}s`, "Farm and ward, no trades");
        return s(final ? "passed" : "on-track", 1, `${deaths.length} reset${deaths.length > 1 ? "s" : ""}`, "Every death reset");
      }
      case "steady_after_death": {
        const rated = deaths.filter((d) => d.csBefore !== null && d.csAfter !== null && (d.csBefore ?? 0) > 2);
        const ratios = rated.map((d) => d.csAfter! / d.csBefore!);
        const worst = ratios.length ? Math.min(...ratios) : null;
        if (worst !== null && worst < def.target) return s(final ? "failed" : "at-risk", worst, `${Math.round(worst * 100)}%`, "Farm dropped after a death");
        if (worst === null) return s(final ? "passed" : deaths.length ? "pending" : "on-track", 1, deaths.length ? "Measuring" : "No deaths", deaths.length ? "3 minutes after respawn" : "Stay that way");
        return s(final ? "passed" : "on-track", worst, `${Math.round(worst * 100)}%`, "Farm held after deaths");
      }
      case "check_ins": {
        const due = deaths.filter((d) => t > d.respawnAt + 20 || final);
        const answered = due.filter((d) => d.checkIn !== null).length;
        const rate = due.length ? answered / due.length : 1;
        if (!deaths.length) return s(final ? "passed" : "on-track", 1, "No deaths", "Nothing to check in on");
        const last = deaths[deaths.length - 1];
        if (me.isDead && last.checkIn === null) return s("at-risk", rate, `${answered} of ${due.length}`, "Rate your head: Ctrl+Shift+1 to 5");
        return s(final ? (rate >= def.target ? "passed" : "failed") : rate >= def.target ? "on-track" : "at-risk", rate, `${answered} of ${due.length}`, "Check-ins on deaths");
      }
    }
  }

  /**
   * Focus, 0-100: how well you're holding your head, from what you do (death chains, farm after
   * deaths, the goal) and what you say (check-ins). Starts at 80; behaviour moves it.
   */
  focus(final = false): number {
    let score = 80;
    for (const d of this.deaths) {
      if (d.chain) score -= 18;
      if (d.csBefore && d.csAfter !== null && d.csAfter / d.csBefore < 0.7) score -= 8;
      if (d.beforeObjective) score -= 5;
    }
    const resets = this.deaths.filter((d, i) => !this.deaths[i + 1]?.chain && this.gameTime > d.respawnAt + 90).length;
    score += Math.min(12, resets * 4);
    const ratings = this.checkIns.map((c) => c.rating);
    if (ratings.length) score = score * 0.6 + ((avg(ratings) - 1) / 4) * 100 * 0.4;
    const goals = [this.evaluate(this.skillId, final), this.evaluate(this.mentalId, final)];
    for (const g of goals) score += g.status === "failed" ? -6 : g.status === "passed" ? 6 : 0;
    return Math.round(Math.max(0, Math.min(100, score)));
  }

  view(): LiveView {
    const me = this.me;
    const t = this.gameTime;
    const last = this.deaths[this.deaths.length - 1] ?? null;
    return {
      gameTime: t,
      champion: me ? champKey(me) : this.plan?.champion ?? "",
      role: this.role,
      isDead: !!me?.isDead,
      respawnIn: me?.isDead ? Math.max(0, Math.round(me.respawnTimer)) : 0,
      gold: Math.round(this.last?.activePlayer?.currentGold ?? 0),
      kda: [me?.scores.kills ?? 0, me?.scores.deaths ?? 0, me?.scores.assists ?? 0],
      cs: me?.scores.creepScore ?? 0,
      focus: this.focus(),
      skill: this.evaluate(this.skillId),
      mental: this.evaluate(this.mentalId),
      deaths: this.deaths,
      lastDeath: me?.isDead ? last : null,
      nudges: this.nudges,
      nextObjective: this.objectiveIn(t),
    };
  }

  finish(gameId: string, win: boolean | null): LiveRecord {
    return {
      gameId,
      startedAt: this.startedAt,
      durationSec: Math.round(this.gameTime),
      champion: this.me ? champKey(this.me) : this.plan?.champion ?? "",
      role: this.role,
      plan: this.plan,
      skill: this.evaluate(this.skillId, true),
      mental: this.evaluate(this.mentalId, true),
      focus: this.focus(true),
      deaths: this.deaths,
      checkIns: this.checkIns,
      backs: this.backs,
      csAt: this.csAt,
      win,
    };
  }
}

/** Win/loss from the GameEnd event, if the game got that far. */
export function resultOf(d: AllGameData | null): boolean | null {
  const end = d?.events?.Events?.find((e) => e.EventName === "GameEnd") as { Result?: string } | undefined;
  return end?.Result === "Win" ? true : end?.Result === "Lose" ? false : null;
}

/** Why you died, in one line, for the death card. Most specific cause first. */
export function deathLesson(d: DeathRec, defs: Record<ChallengeId, ChallengeDef>, skill: ChallengeId): { cause: string; fix: string } {
  if (d.chain) return { cause: "Second death in 90 seconds", fix: "This is the tilt window. Farm safe until your next item. No trades." };
  if (d.beforeObjective) return { cause: `${Math.round(d.beforeObjective.inSec)}s before ${d.beforeObjective.name}`, fix: `Your team fights ${d.beforeObjective.name} a player down. Give it if they're 5, take the next wave.` };
  if (d.streak >= 2) return { cause: "Shutdown given", fix: "You had the lead. Next time back and buy before the fight." };
  if (d.jungler && d.t < 840) return { cause: "Their jungler", fix: "When you lose sight of their jungler for 30s, stand behind your wave." };
  if (d.gold >= 1300) return { cause: `Held ${fmtG(d.gold)}`, fix: "That gold never fought. Back on the next crash, not the one after." };
  if (d.helpers >= 2) return { cause: `${d.helpers + 1} of them`, fix: "Count the enemies you can see before you commit. 2+ missing means don't." };
  return { cause: d.killerChamp ? `${champName(d.killerChamp)}` : "Killed", fix: defs[skill].rule };
}

// ---------------------------------------------------------------- debrief

export type Mood = "calm" | "focused" | "confident" | "hyped" | "frustrated" | "tilted" | "anxious" | "tired" | "autopilot" | "bored";

export const MOODS: { id: Mood; label: string; energy: "high" | "low"; tone: "good" | "bad" }[] = [
  { id: "hyped", label: "Hyped", energy: "high", tone: "good" },
  { id: "confident", label: "Confident", energy: "high", tone: "good" },
  { id: "focused", label: "Focused", energy: "high", tone: "good" },
  { id: "frustrated", label: "Frustrated", energy: "high", tone: "bad" },
  { id: "tilted", label: "Tilted", energy: "high", tone: "bad" },
  { id: "anxious", label: "Anxious", energy: "high", tone: "bad" },
  { id: "calm", label: "Calm", energy: "low", tone: "good" },
  { id: "bored", label: "Bored", energy: "low", tone: "bad" },
  { id: "autopilot", label: "Autopilot", energy: "low", tone: "bad" },
  { id: "tired", label: "Tired", energy: "low", tone: "bad" },
];

export const NEGATIVE_MOODS: Mood[] = ["frustrated", "tilted", "anxious", "tired", "autopilot", "bored"];

export interface DebriefQuestion {
  id: string;
  prompt: string;
  /** The evidence the question is about, from this game. */
  context?: string;
  options: { id: string; label: string }[];
  multi?: boolean;
}

export interface Debrief {
  gameId: string;
  matchId?: string;
  at: number;
  moods: Mood[];
  focus: number; // 1-5
  answers: Record<string, string[]>;
  note: string;
  nextIntention: string;
  win: boolean | null;
  champion: string;
}

/** Questions for this game, built from what happened in it. */
export function debriefQuestions(rec: LiveRecord | null, moods: Mood[], report?: GameReport | null): DebriefQuestion[] {
  const qs: DebriefQuestion[] = [];
  const neg = moods.some((m) => NEGATIVE_MOODS.includes(m));
  const chain = rec?.deaths.find((d) => d.chain);
  if (chain) {
    const prev = rec!.deaths[rec!.deaths.indexOf(chain) - 1];
    qs.push({
      id: "chain",
      prompt: "What was going through your head before the second death?",
      context: `You died at ${mmss(prev?.t ?? 0)}, then again at ${mmss(chain.t)}, ${Math.round(chain.t - (prev?.respawnAt ?? chain.t))}s after respawning.`,
      options: [
        { id: "revenge", label: "Wanted to get it back" },
        { id: "rushed", label: "Rushed back to lane" },
        { id: "blind", label: "Didn't see the danger" },
        { id: "team", label: "Followed my team in" },
        { id: "fine", label: "Honestly it was fine" },
      ],
    });
  }
  if (neg) {
    qs.push({
      id: "trigger",
      prompt: "What set it off?",
      options: [
        { id: "own", label: "My own mistake" },
        { id: "teammate", label: "A teammate" },
        { id: "chat", label: "Chat or pings" },
        { id: "lane", label: "Losing lane" },
        { id: "streak", label: "Losing streak" },
        { id: "life", label: "Outside the game" },
      ],
      multi: true,
    });
    qs.push({
      id: "response",
      prompt: "What did you do about it in the game?",
      options: [
        { id: "muted", label: "Muted / ignored it" },
        { id: "breathed", label: "Took a breath on a death" },
        { id: "typed", label: "Typed back" },
        { id: "forced", label: "Forced plays" },
        { id: "nothing", label: "Nothing, it stuck" },
      ],
      multi: true,
    });
  }
  if (rec) {
    const goals = [rec.skill, rec.mental];
    for (const g of goals) {
      if (g.status === "failed") {
        qs.push({
          id: `goal-${g.id}`,
          prompt: `"${g.title}" slipped. What got in the way?`,
          context: g.detail,
          options: [
            { id: "forgot", label: "Forgot about it" },
            { id: "pressure", label: "Lane pressure" },
            { id: "choice", label: "Chose to break it" },
            { id: "unclear", label: "Not sure how to do it" },
          ],
        });
      } else if (g.status === "passed") {
        qs.push({
          id: `goal-${g.id}`,
          prompt: `You kept "${g.title}". What made it work?`,
          options: [
            { id: "reminder", label: "The overlay reminder" },
            { id: "habit", label: "It's becoming habit" },
            { id: "easy", label: "Easy game for it" },
            { id: "effort", label: "Hard focus" },
          ],
        });
      }
    }
  }
  if (!rec && report?.mistakes.length) {
    const m = report.mistakes[0];
    qs.push({
      id: "worst",
      prompt: `Your costliest moment was at ${mmss(m.timeMs / 1000)}: ${m.title.toLowerCase()}. What were you trying to do?`,
      options: [
        { id: "play", label: "Make a play" },
        { id: "farm", label: "Just farming" },
        { id: "help", label: "Help a teammate" },
        { id: "unsure", label: "Don't remember" },
      ],
    });
  }
  qs.push({
    id: "energy",
    prompt: "Queue again?",
    options: [
      { id: "fresh", label: "Fresh, one more" },
      { id: "ok", label: "One more, then stop" },
      { id: "done", label: "Done for now" },
    ],
  });
  return qs;
}

export interface CoachingCard {
  tone: "good" | "warn" | "info";
  title: string;
  body: string;
  /** A concrete rule for next game, if the card has one. */
  rule?: string;
}

/** Turns the answers into the few things worth taking into the next game. */
export function debriefCoaching(db: Pick<Debrief, "moods" | "focus" | "answers">, rec: LiveRecord | null, profile: TiltProfile | null): CoachingCard[] {
  const out: CoachingCard[] = [];
  const a = (q: string) => db.answers[q] ?? [];
  if (a("chain").includes("revenge")) {
    out.push({ tone: "warn", title: "The revenge death", body: profile && profile.chainGames >= 5 && profile.chainWinRate < profile.noChainWinRate - 0.05 ? `Games where you die twice in a short window: you win ${pct(profile.chainWinRate)} of them (${profile.chainGames} games). Without: ${pct(profile.noChainWinRate)}.` : "The death after a death is the one that loses games: they get gold twice and you lose two waves.", rule: "After a death, your next fight starts after your next item. Not before." });
  } else if (a("chain").includes("rushed")) {
    out.push({ tone: "warn", title: "Walking back hot", body: "Respawning and walking straight back into the same lane state is how the same death happens twice.", rule: "On respawn, look at the map for 3 seconds before you leave base." });
  } else if (a("chain").includes("blind")) {
    out.push({ tone: "info", title: "You didn't see it coming", body: "That's information, not mechanics. The fix is a habit, not practice tool.", rule: "Every wave crash: look at the minimap and count enemies." });
  } else if (a("chain").includes("team")) {
    out.push({ tone: "info", title: "Following a bad call", body: "Following your team into a losing fight still costs you the death.", rule: "Down a player or two? Ping back and catch a wave instead." });
  }
  const trig = a("trigger");
  const resp = a("response");
  if (trig.includes("teammate") || trig.includes("chat")) {
    out.push({ tone: resp.includes("muted") ? "good" : "warn", title: resp.includes("muted") ? "Muting worked for you" : "Mute before it starts", body: resp.includes("typed") ? "Typing back costs you the next 20 seconds of attention, and it never changes their mind." : "Other players' tilt is contagious, and you can't fix it from your lane.", rule: "Type /muteall at the start of the next game. Unmute pings only if you want them." });
  }
  if (trig.includes("own")) out.push({ tone: "info", title: "Your own mistake set it off", body: "Good players make the same mistakes. The difference is the next 90 seconds.", rule: "Say what went wrong in five words, then let it go. The review is for later." });
  if (trig.includes("streak")) out.push({ tone: "warn", title: "Losing streak", body: profile && profile.afterTwoLosses.games >= 5 ? `After 2 losses in a row you win ${pct(profile.afterTwoLosses.winRate)} of your next games (${profile.afterTwoLosses.games} games). Your normal is ${pct(profile.winRate)}.` : "Streaks feed themselves: you queue tilted, so you lose, so you queue tilted.", rule: profile?.stopAfter ? `Stop after ${profile.stopAfter} losses in a row.` : "Two losses in a row: take a 15-minute break before the next queue." });
  if (trig.includes("life")) out.push({ tone: "info", title: "Something outside the game", body: "That counts. Ranked takes all of your attention, and it's fine to play a normal or stop." });
  if (resp.includes("forced")) out.push({ tone: "warn", title: "Forcing plays", body: "Forced plays come from wanting the game to feel better right now.", rule: "When you notice it, play the next 60 seconds for the wave only." });
  if (resp.includes("breathed")) out.push({ tone: "good", title: "You took a breath", body: "That's the skill. It gets faster every time you do it." });
  for (const g of [rec?.skill, rec?.mental]) {
    if (!g) continue;
    const ans = a(`goal-${g.id}`);
    if (ans.includes("forgot")) out.push({ tone: "info", title: `Keep "${g.title}" in front of you`, body: "Forgetting is normal for the first few games. The overlay will remind you at the moments it matters.", rule: "Say the rule out loud at 0:30." });
    if (ans.includes("unclear")) out.push({ tone: "info", title: `How to do "${g.title}"`, body: rec ? challengeDefs(rec.plan?.baseline ?? EMPTY_BASELINE)[g.id].rule : "", rule: rec ? challengeDefs(rec.plan?.baseline ?? EMPTY_BASELINE)[g.id].why : undefined });
    if (ans.includes("habit")) out.push({ tone: "good", title: `"${g.title}" is sticking`, body: "Keep it for two more games, then the coach moves you to the next one." });
  }
  if (a("energy").includes("done") || db.moods.includes("tired")) out.push({ tone: "good", title: "Good call to stop", body: "Stopping while you can still tell you're tired is the hardest mental skill in ranked." });
  else if (a("energy").includes("ok") && profile && profile.byGameInSession[3] && profile.byGameInSession[3].games >= 5 && profile.byGameInSession[3].winRate < profile.winRate - 0.05) {
    out.push({ tone: "warn", title: "Game 4+ is your weak spot", body: `Your 4th game and later in a session: ${pct(profile.byGameInSession[3].winRate)} win rate (${profile.byGameInSession[3].games} games). Game 1-3: ${pct(avg(profile.byGameInSession.slice(0, 3).map((b) => b.winRate)))}.` });
  }
  if (!out.length) out.push({ tone: "good", title: "Steady game", body: "Nothing in your answers needs fixing. Take the same plan into the next one." });
  return out.slice(0, 4);
}

const EMPTY_BASELINE: Baseline = { role: "MIDDLE", games: 0, cs10: null, deathsPre14: null, visionPerMin: null, killParticipation: null };
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- history (works with no live data)

export interface WinBucket {
  label: string;
  games: number;
  winRate: number;
}

export interface TiltProfile {
  games: number;
  winRate: number;
  /** Game 1, 2, 3, 4+ of a session (games less than 45 min apart). */
  byGameInSession: WinBucket[];
  afterWin: WinBucket;
  afterLoss: WinBucket;
  afterTwoLosses: WinBucket;
  byTimeOfDay: WinBucket[];
  /** Games with two of your deaths inside 2.5 minutes (a death chain). */
  chainGames: number;
  chainWinRate: number;
  noChainWinRate: number;
  /** Stop-loss: losses in a row after which your next game is clearly worse. Null if not clear. */
  stopAfter: number | null;
  /** Current session from the newest game back. */
  session: { games: number; wins: number; losses: number; lossStreak: number; startedAt: number | null };
}

const bucket = (label: string, rs: GameReport[]): WinBucket => ({ label, games: rs.length, winRate: rs.length ? avg(rs.map((r) => (r.metrics.win ? 1 : 0))) : 0 });

/** A death within 150s of the previous one (death timers are 10-50s early, so ~90s alive). */
export function hasDeathChain(r: GameReport): boolean {
  const ts = r.deathsAt.map((d) => d.timeMs).sort((a, b) => a - b);
  return ts.some((t, i) => i > 0 && t - ts[i - 1] < 150_000);
}

/** reports: newest first. */
export function tiltProfile(reports: GameReport[], now = Date.now()): TiltProfile | null {
  if (reports.length < 5) return null;
  const rs = [...reports].sort((a, b) => a.metrics.gameCreation - b.metrics.gameCreation); // oldest first
  const sessionIdx: number[] = [];
  for (let i = 0; i < rs.length; i++) {
    const prev = rs[i - 1];
    const gap = prev ? rs[i].metrics.gameCreation - (prev.metrics.gameCreation + prev.metrics.durationMin * 60_000) : Infinity;
    sessionIdx.push(gap < 45 * 60_000 ? sessionIdx[i - 1] + 1 : 0);
  }
  const byGameInSession = [0, 1, 2, 3].map((k) => bucket(k === 3 ? "4th+" : ["1st", "2nd", "3rd"][k], rs.filter((_, i) => (k === 3 ? sessionIdx[i] >= 3 : sessionIdx[i] === k))));
  const afterWin = bucket("After a win", rs.filter((_, i) => sessionIdx[i] > 0 && rs[i - 1].metrics.win));
  const afterLoss = bucket("After a loss", rs.filter((_, i) => sessionIdx[i] > 0 && !rs[i - 1].metrics.win));
  const afterN = (n: number) => rs.filter((_, i) => sessionIdx[i] >= n && rs.slice(i - n, i).every((r) => !r.metrics.win));
  const afterTwoLosses = bucket("After 2 losses", afterN(2));
  const hour = (r: GameReport) => new Date(r.metrics.gameCreation).getHours();
  const byTimeOfDay = [
    bucket("Morning", rs.filter((r) => hour(r) >= 6 && hour(r) < 12)),
    bucket("Afternoon", rs.filter((r) => hour(r) >= 12 && hour(r) < 18)),
    bucket("Evening", rs.filter((r) => hour(r) >= 18 && hour(r) < 23)),
    bucket("Late night", rs.filter((r) => hour(r) >= 23 || hour(r) < 6)),
  ];
  const chains = rs.filter(hasDeathChain);
  const noChains = rs.filter((r) => !hasDeathChain(r));
  const winRate = avg(rs.map((r) => (r.metrics.win ? 1 : 0)));
  let stopAfter: number | null = null;
  for (const n of [1, 2, 3]) {
    const b = bucket("", afterN(n));
    if (b.games >= 5 && b.winRate <= winRate - 0.08) {
      stopAfter = n;
      break;
    }
  }
  // Current session: newest game back while gaps are short, and the newest game was recent.
  const newest = rs[rs.length - 1];
  const session = { games: 0, wins: 0, losses: 0, lossStreak: 0, startedAt: null as number | null };
  const live = now - (newest.metrics.gameCreation + newest.metrics.durationMin * 60_000) < 60 * 60_000;
  if (live) {
    for (let i = rs.length - 1; i >= 0; i--) {
      session.games++;
      session.startedAt = rs[i].metrics.gameCreation;
      if (rs[i].metrics.win) session.wins++;
      else session.losses++;
      if (sessionIdx[i] === 0) break;
    }
    for (let i = rs.length - 1; i >= rs.length - session.games && !rs[i].metrics.win; i--) session.lossStreak++;
  }
  return {
    games: rs.length,
    winRate,
    byGameInSession,
    afterWin,
    afterLoss,
    afterTwoLosses,
    byTimeOfDay,
    chainGames: chains.length,
    chainWinRate: bucket("", chains).winRate,
    noChainWinRate: bucket("", noChains).winRate,
    stopAfter,
    session,
  };
}

/** Pre-game read: should you be queueing right now? */
export function queueCheck(profile: TiltProfile | null, debriefs: Debrief[], now = Date.now()): { tone: "good" | "warn" | "bad"; title: string; body: string } {
  const lastDb = debriefs[0];
  const recentDb = lastDb && now - lastDb.at < 90 * 60_000 ? lastDb : null;
  if (recentDb?.answers.energy?.includes("done")) return { tone: "bad", title: "You said you were done", body: "After your last game you said you wanted to stop. Past you was probably right." };
  if (profile?.session.lossStreak && profile.stopAfter && profile.session.lossStreak >= profile.stopAfter) {
    return { tone: "bad", title: `${profile.session.lossStreak} losses in a row`, body: `This is your stop-loss. After ${profile.stopAfter} losses in a row you win ${pct(bucketAfter(profile, profile.stopAfter))} of your next games. Take a real break.` };
  }
  if (recentDb && recentDb.moods.some((m) => m === "tilted" || m === "frustrated")) return { tone: "warn", title: "Last game ended tilted", body: "Take 5 minutes away from the screen before you queue. Water, stand up, then decide." };
  if (profile?.session.games && profile.session.games >= 3 && profile.byGameInSession[3].games >= 5 && profile.byGameInSession[3].winRate < profile.winRate - 0.05) {
    return { tone: "warn", title: `Game ${profile.session.games + 1} of this session`, body: `Your 4th+ game in a session wins ${pct(profile.byGameInSession[3].winRate)}. Your average is ${pct(profile.winRate)}.` };
  }
  return { tone: "good", title: "Good to queue", body: profile?.session.games ? `${profile.session.wins}W ${profile.session.losses}L this session.` : "Fresh session. Pick one goal and play for it." };
}

function bucketAfter(p: TiltProfile, n: number): number {
  return n >= 2 ? p.afterTwoLosses.winRate : p.afterLoss.winRate;
}

/** Your record on a champion and against one, from synced games. */
export function matchupRead(reports: GameReport[], champion: string, enemy: string | null) {
  const on = reports.filter((r) => r.metrics.champion === champion);
  const vs = enemy ? reports.filter((r) => r.metrics.opponentChampion === enemy) : [];
  const wr = (rs: GameReport[]) => (rs.length ? avg(rs.map((r) => (r.metrics.win ? 1 : 0))) : null);
  return {
    games: on.length,
    winRate: wr(on),
    cs10: on.length ? Math.round(avg(on.map((r) => r.metrics.cs10))) : null,
    deathsPre14: on.length ? avg(on.map((r) => r.metrics.deathsPre14)) : null,
    vsGames: vs.length,
    vsWinRate: wr(vs),
    vsGold15: vs.length ? Math.round(avg(vs.map((r) => r.metrics.goldDiff15 ?? 0))) : null,
  };
}

/** Which mental goal to suggest, from what your games show. */
export function suggestMental(reports: GameReport[], records: LiveRecord[]): { id: ChallengeId; reason: string } {
  const recent = reports.slice(0, 15);
  const chainRate = recent.length ? avg(recent.map((r) => (hasDeathChain(r) ? 1 : 0))) : 0;
  if (chainRate >= 0.3) return { id: "reset_after_death", reason: `You had a death chain in ${pct(chainRate)} of your last ${recent.length} games.` };
  const drops = records.flatMap((r) => r.deaths).filter((d) => d.csBefore && d.csAfter !== null && d.csAfter / d.csBefore < 0.8).length;
  if (drops >= 3) return { id: "steady_after_death", reason: `Your farm dropped after ${drops} recent deaths.` };
  return { id: "check_ins", reason: "Rating your head on each death is the base habit the others build on." };
}
