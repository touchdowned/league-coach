import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/analysis";
import type { AllGameData, LiveEvent, LivePlayer } from "../src/core/live";
import { champKey, findMe } from "../src/core/live";
import { baselineFrom, challengeDefs, deathLesson, debriefCoaching, debriefQuestions, GamePlan, hasDeathChain, LiveTracker, queueCheck, tiltProfile } from "../src/core/mind";
import { death, makeGame, ME } from "./fixtures";

// ---- a tiny live-game simulator: one snapshot per second ----

function player(o: Partial<LivePlayer> & { name: string; team: "ORDER" | "CHAOS"; position: string; championName: string }): LivePlayer {
  return {
    riotId: `${o.name}#NA1`,
    riotIdGameName: o.name,
    summonerName: o.name,
    rawChampionName: `game_character_displayname_${o.championName}`,
    level: 1,
    isDead: false,
    respawnTimer: 0,
    scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0, wardScore: 0 },
    items: [],
    ...o,
  };
}

class Sim {
  t = 0;
  gold = 500;
  me = player({ name: "Me", team: "ORDER", position: "MIDDLE", championName: "Ahri" });
  opp = player({ name: "Opp", team: "CHAOS", position: "MIDDLE", championName: "Zed" });
  jg = player({ name: "Jg", team: "CHAOS", position: "JUNGLE", championName: "LeeSin" });
  ally = player({ name: "Ally", team: "ORDER", position: "TOP", championName: "Garen" });
  events: LiveEvent[] = [];
  private id = 1;
  constructor(public tracker: LiveTracker) {}
  snap(): AllGameData {
    return {
      activePlayer: { riotId: "Me#NA1", riotIdGameName: "Me", currentGold: this.gold, level: 6 },
      allPlayers: [this.me, this.ally, this.opp, this.jg].map((p) => structuredClone(p)),
      events: { Events: structuredClone(this.events) },
      gameData: { gameMode: "CLASSIC", gameTime: this.t },
    };
  }
  /** Advance to time `to`, farming at `csPerMin`. */
  run(to: number, csPerMin = 8) {
    while (this.t < to) {
      this.t += 1;
      if (!this.me.isDead && this.t > 65) {
        this.acc += csPerMin / 60;
        this.me.scores.creepScore += Math.floor(this.acc);
        this.acc %= 1;
      }
      if (this.me.isDead && this.t >= this.respawnAt) {
        this.me.isDead = false;
        this.me.respawnTimer = 0;
      }
      if (this.me.isDead) this.me.respawnTimer = this.respawnAt - this.t;
      this.tracker.update(this.snap());
    }
  }
  respawnAt = 0;
  private acc = 0;
  die(killer: LivePlayer, helpers: LivePlayer[] = [], timer = 20) {
    this.events.push({ EventID: this.id++, EventName: "ChampionKill", EventTime: this.t, KillerName: killer.riotIdGameName, VictimName: "Me", Assisters: helpers.map((h) => h.riotIdGameName!) });
    this.me.isDead = true;
    this.me.scores.deaths++;
    this.respawnAt = this.t + timer;
    this.me.respawnTimer = timer;
    this.t += 1;
    this.tracker.update(this.snap());
  }
}

const baseline = { role: "MIDDLE" as const, games: 10, cs10: 60, deathsPre14: 1.5, visionPerMin: 0.5, killParticipation: 0.5 };
const plan = (skill: GamePlan["skill"], mental: GamePlan["mental"]): GamePlan => ({ createdAt: 0, champion: "Ahri", role: "MIDDLE", skill, mental, intention: "Play for the long game", baseline });

describe("live helpers", () => {
  it("finds you in the player list by Riot ID and keys champions like match-v5", () => {
    const sim = new Sim(new LiveTracker(null, baseline));
    const d = sim.snap();
    expect(findMe(d)?.championName).toBe("Ahri");
    expect(champKey(player({ name: "x", team: "ORDER", position: "", championName: "Wukong", rawChampionName: "game_character_displayname_MonkeyKing" }))).toBe("MonkeyKing");
  });
});

describe("challenge targets", () => {
  it("stretches a little above your own average, never below the rank benchmark", () => {
    const low = challengeDefs({ ...baseline, cs10: 40 });
    const high = challengeDefs({ ...baseline, cs10: 75 });
    expect(low.cs10.target).toBeGreaterThanOrEqual(62); // mid benchmark
    expect(high.cs10.target).toBeGreaterThan(75);
    expect(high.cs10.target).toBeLessThanOrEqual(86);
  });
});

describe("LiveTracker", () => {
  it("tracks CS pace and locks the result at 10:00", () => {
    const tr = new LiveTracker(plan("cs10", "check_ins"), baseline);
    const sim = new Sim(tr);
    sim.run(300, 9);
    expect(tr.evaluate("cs10").status).toBe("on-track");
    sim.run(620, 9);
    const s = tr.evaluate("cs10");
    expect(s.status).toBe("passed");
    const slow = new LiveTracker(plan("cs10", "check_ins"), baseline);
    new Sim(slow).run(620, 5);
    expect(slow.evaluate("cs10").status).toBe("failed");
  });

  it("flags a jungle gank, gold held on death and a death chain", () => {
    const tr = new LiveTracker(plan("no_gank_deaths", "reset_after_death"), baseline);
    const sim = new Sim(tr);
    sim.run(200);
    sim.gold = 1450;
    sim.run(210);
    sim.die(sim.opp, [sim.jg], 15);
    const d = tr.deaths[0];
    expect(d.jungler).toBe(true);
    expect(d.gold).toBe(1450);
    expect(d.killerChamp).toBe("Zed");
    expect(d.helpers).toBe(1);
    expect(tr.evaluate("no_gank_deaths").status).toBe("failed");
    expect(deathLesson(d, tr.defs, "no_gank_deaths").cause).toMatch(/jungler/i);
    // Respawn, then die again 40s later: tilt chain.
    sim.gold = 300;
    sim.run(d.respawnAt + 40);
    sim.die(sim.opp);
    expect(tr.deaths[1].chain).toBe(true);
    expect(tr.evaluate("reset_after_death").status).toBe("failed");
    expect(deathLesson(tr.deaths[1], tr.defs, "no_gank_deaths").cause).toMatch(/90 seconds/);
  });

  it("counts a clean reset and rewards it in focus", () => {
    const tr = new LiveTracker(plan("deaths14", "reset_after_death"), baseline);
    const sim = new Sim(tr);
    sim.run(300);
    sim.die(sim.opp);
    sim.run(500);
    const s = tr.evaluate("reset_after_death");
    expect(s.status).toBe("on-track");
    expect(tr.focus()).toBeGreaterThanOrEqual(80);
  });

  it("attaches a focus check-in to the death you're dead from", () => {
    const tr = new LiveTracker(plan("deaths14", "check_ins"), baseline);
    const sim = new Sim(tr);
    sim.run(300);
    sim.die(sim.opp, [], 20);
    sim.run(305);
    tr.checkIn(2);
    expect(tr.deaths[0].checkIn).toBe(2);
    sim.run(400);
    expect(tr.evaluate("check_ins").status).toBe("on-track");
    // A low self-rating pulls focus down.
    expect(tr.focus()).toBeLessThan(80);
  });

  it("knows the dragon spawn and fails objective safety for a death just before it", () => {
    const tr = new LiveTracker(plan("objective_safety", "reset_after_death"), baseline);
    const sim = new Sim(tr);
    sim.run(245);
    expect(tr.view().nudges.some((n) => /Dragon in/.test(n.text))).toBe(true);
    sim.run(270);
    sim.die(sim.opp);
    expect(tr.deaths[0].beforeObjective?.name).toBe("Dragon");
    expect(tr.evaluate("objective_safety").status).toBe("failed");
  });

  it("detects small backs from gold spent on items", () => {
    const tr = new LiveTracker(plan("full_backs", "check_ins"), baseline);
    const sim = new Sim(tr);
    sim.run(300);
    for (const at of [320, 500]) {
      sim.gold = 600;
      sim.run(at);
      sim.gold = 50;
      sim.me.items.push({ itemID: 1036, price: 350 });
      sim.run(at + 2);
    }
    expect(tr.backs).toHaveLength(2);
    expect(tr.evaluate("full_backs").status).toBe("failed");
  });

  it("finishes into a record with final statuses", () => {
    const tr = new LiveTracker(plan("deaths14", "reset_after_death"), baseline);
    const sim = new Sim(tr);
    sim.run(900);
    const rec = tr.finish("123", true);
    expect(rec.skill.status).toBe("passed");
    expect(rec.mental.status).toBe("passed");
    expect(rec.champion).toBe("Ahri");
    expect(rec.durationSec).toBe(900);
  });
});

// ---- history ----

function report(i: number, win: boolean, hoursAgo: number, deathsMin: number[] = []) {
  const { match, timeline } = makeGame({ id: `G${i}`, win, events: deathsMin.map((m) => death(m * 60_000, 3, 8)) });
  match.info.gameCreation = Date.UTC(2026, 0, 10, 20) - hoursAgo * 3_600_000;
  return buildReport(match, timeline, ME);
}

describe("tilt profile", () => {
  it("finds death chains", () => {
    expect(hasDeathChain(report(0, false, 0, [5, 6]))).toBe(true);
    expect(hasDeathChain(report(0, false, 0, [5, 12]))).toBe(false);
  });

  it("measures win rate after losses and sets a stop-loss", () => {
    // Sessions of 4 games, 40 min apart: W L L L. After two losses: always a loss.
    const rs = [];
    let k = 0;
    for (let s = 0; s < 6; s++) for (let g = 0; g < 4; g++) rs.push(report(k++, g === 0, s * 24 + (3 - g) * 0.7));
    const p = tiltProfile(rs.sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation), Date.UTC(2026, 0, 10, 21))!;
    expect(p.byGameInSession[0].winRate).toBe(1);
    expect(p.afterTwoLosses.winRate).toBe(0);
    expect(p.stopAfter).toBe(1);
    expect(p.session.games).toBe(4);
    expect(p.session.lossStreak).toBe(3);
    expect(queueCheck(p, []).tone).toBe("bad");
  });
});

describe("debrief", () => {
  it("asks about the death chain and triggers when you say you were tilted", () => {
    const tr = new LiveTracker(plan("deaths14", "reset_after_death"), baseline);
    const sim = new Sim(tr);
    sim.run(300);
    sim.die(sim.opp, [], 10);
    sim.run(330);
    sim.die(sim.opp, [], 10);
    sim.run(700);
    const rec = tr.finish("1", false);
    const qs = debriefQuestions(rec, ["tilted"]);
    expect(qs.map((q) => q.id)).toEqual(expect.arrayContaining(["chain", "trigger", "response", "goal-reset_after_death", "energy"]));
    expect(qs.find((q) => q.id === "chain")!.context).toMatch(/5:01/);
    const cards = debriefCoaching({ moods: ["tilted"], focus: 2, answers: { chain: ["revenge"], trigger: ["teammate"], response: ["typed"] } }, rec, null);
    expect(cards[0].title).toMatch(/revenge/i);
    expect(cards.some((c) => /mute/i.test(c.rule ?? ""))).toBe(true);
  });

  it("works from synced data alone when no live record exists", () => {
    const rep = report(0, false, 0, [5]);
    const qs = debriefQuestions(null, ["calm"], rep);
    expect(qs.some((q) => q.id === "worst")).toBe(true);
    expect(baselineFrom([rep]).games).toBe(1);
  });
});
