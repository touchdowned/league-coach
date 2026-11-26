import { benchmarkFor } from "./benchmarks";
import type { GameReport, MistakeKind } from "./types";

/**
 * The coach decides what the player works on. It scores every known leak by how
 * much it is likely costing them, picks the worst one that isn't fixed yet, and
 * gives concrete in-game rules plus a pass/fail check for each game.
 */

export type IssueId =
  | "early_deaths"
  | "ganks"
  | "overextending"
  | "unspent_gold"
  | "objective_deaths"
  | "shutdowns"
  | "farming"
  | "losing_lane"
  | "absent_from_fights"
  | "vision"
  | "recall_timing"
  | "lane_farm";

export interface Issue {
  id: IssueId;
  title: string;
  /** Plain statement of the problem with the player's numbers. */
  evidence: string;
  /** Why this matters for winning. */
  why: string;
  /** What to actually do in game. */
  rules: string[];
  /** How the coach judges a game. */
  passRule: string;
  cost: number; // higher = hurting you more
  results: (boolean | null)[]; // last games, oldest first
  recentPassRate: number; // last 5 applicable games
  fixed: boolean;
}

export interface CoachPlan {
  current: Issue | null;
  upNext: Issue[];
  fixed: Issue[];
  gamesConsidered: number;
  verdict: string; // one blunt line about where the player is
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rateOf = (rs: GameReport[], kind: MistakeKind) => avg(rs.map((r) => (r.mistakes.some((m) => m.kind === kind) ? 1 : 0)));
const pct = (n: number) => `${Math.round(n * 100)}%`;

interface IssueDef {
  id: IssueId;
  title: string;
  why: string;
  rules: string[];
  passRule: string;
  check: (r: GameReport) => boolean | null;
  measure: (rs: GameReport[]) => { cost: number; evidence: string };
}

function defs(rs: GameReport[]): IssueDef[] {
  // Average the benchmark over the games so mixed roles compare fairly.
  const bm = rs.map((r) => benchmarkFor(r.metrics.role));
  const b = {
    cs10: Math.round(avg(bm.map((x) => x.cs10))),
    deathsPre14: avg(bm.map((x) => x.deathsPre14)),
    killParticipation: avg(bm.map((x) => x.killParticipation)),
    visionPerMin: avg(bm.map((x) => x.visionPerMin)),
  };
  const has = (r: GameReport, k: MistakeKind) => r.mistakes.some((m) => m.kind === k);
  // Gold-cost leaks from the replay-reading engine (non-death mistakes). ~150g a game ≈ 1 cost point.
  const withLeaks = rs.filter((r) => r.leaks);
  const leakGold = (r: GameReport, kinds: string[]) => (r.leaks ?? []).filter((l) => kinds.includes(l.kind)).reduce((a, l) => a + l.cost, 0);
  const perGame = (kinds: string[]) => (withLeaks.length ? avg(withLeaks.map((r) => leakGold(r, kinds))) : 0);
  const fmtG = (n: number) => `${Math.round(n).toLocaleString("en-US")}g`;
  const leakDefs: IssueDef[] = withLeaks.length < 3 ? [] : [
    {
      id: "recall_timing",
      title: "Time your recalls to waves",
      why: "A badly timed recall costs a wave, plates or an objective without anyone seeing it. In Silver it often costs more gold per game than your deaths do.",
      rules: [
        "Shove the wave into their tower first, then back while it crashes.",
        "Back with 1,100–1,300g, not 500: small trips cost the same time as big ones.",
        "Leave 60–90s before dragon or baron spawns, never 30s before.",
      ],
      passRule: "Recalls cost under 300g in total",
      check: (r) => (r.leaks ? leakGold(r, ["recall"]) < 300 : null),
      measure: () => {
        const pg = perGame(["recall"]);
        return { cost: pg / 150, evidence: `Your recalls cost about ${fmtG(pg)} a game in farm, plates and objectives.` };
      },
    },
    {
      id: "lane_farm",
      title: "Stop bleeding farm in lane",
      why: "Every minion your opponent gets that you don't is gold they fight you with. Lost CS outside deaths and recalls is the quietest leak in the game.",
      rules: [
        "Don't take a trade that costs you a cannon or two casters.",
        "Roam only after shoving, and turn back if nothing is there within 25 seconds.",
        "Under your tower: melee = 2 tower shots + 1 auto, caster = 1 tower shot + 1 auto.",
      ],
      passRule: "Lose fewer than 10 CS to your opponent outside deaths and recalls",
      check: (r) => (r.leaks ? leakGold(r, ["farm", "roam"]) / 21 < 10 : null),
      measure: () => {
        const pg = perGame(["farm", "roam"]);
        return { cost: pg / 150, evidence: `You lose about ${Math.round(pg / 21)} CS (${fmtG(pg)}) a game to your lane opponent while alive and in lane.` };
      },
    },
  ];
  return [
    ...leakDefs,
    {
      id: "early_deaths",
      title: "Stop dying before 14 minutes",
      why: "Each early death costs ~300g of shutdown/kill gold plus a wave or two of CS and XP. At Silver this is the most common reason a lane is lost.",
      rules: [
        "Before every trade, ask: is their main damage spell up? If yes, don't step up.",
        "Below 50% HP with no recall timer to wait for, back off and farm under tower.",
        "If you can't see the enemy jungler, stand on your side of the wave.",
      ],
      passRule: "1 or fewer deaths before 14:00",
      check: (r) => r.metrics.deathsPre14 <= 1,
      measure: (rs) => {
        const a = avg(rs.map((r) => r.metrics.deathsPre14));
        return {
          cost: (a - b.deathsPre14) * 3,
          evidence: `You average ${a.toFixed(1)} deaths before 14 min. Typical for your rank is ${b.deathsPre14.toFixed(1)}.`,
        };
      },
    },
    {
      id: "ganks",
      title: "Stop getting ganked",
      why: "Ganks give the enemy jungler and laner gold, tempo and usually a plate or dragon. It's the easiest leak to fix because it's pure information.",
      rules: [
        "At 3:00 and every time you see the jungler, say where they'll be in 30-45 seconds.",
        "Buy a control ward on your first recall and keep a river bush warded.",
        "When your wave is past the middle and the jungler is unaccounted for, stop pushing and back up.",
      ],
      passRule: "No deaths to the enemy jungler during laning",
      check: (r) => !has(r, "ganked"),
      measure: (rs) => {
        const rate = rateOf(rs, "ganked");
        return { cost: rate * 4, evidence: `You died to a jungle gank in ${pct(rate)} of your last ${rs.length} games.` };
      },
    },
    {
      id: "overextending",
      title: "Stop walking into enemy territory blind",
      why: "Deaths deep on the enemy side are almost always 1v2 or worse. You lose the death and the enemy gets free map control.",
      rules: [
        "Count visible enemies before crossing river. If 2+ are missing, don't cross.",
        "Farm side waves only when you know where the enemy jungler and mid are.",
        "Ward ahead of where you're walking, not where you're standing.",
      ],
      passRule: "No deaths deep on the enemy half of the map",
      check: (r) => !has(r, "overextended"),
      measure: (rs) => {
        const rate = rateOf(rs, "overextended");
        return { cost: rate * 3, evidence: `You died deep in enemy territory in ${pct(rate)} of recent games.` };
      },
    },
    {
      id: "unspent_gold",
      title: "Recall on time",
      why: "Dying with 1,300g+ unspent means you fought weaker than you could have and then lost the gold's value for another minute.",
      rules: [
        "When you hit ~1,100g and your wave is pushed in, recall.",
        "Never stay for 'one more wave' when you can afford a component and you're below 60% HP.",
        "Plan recalls around cannon waves so you lose the least farm.",
      ],
      passRule: "Never die holding 1,300g or more",
      check: (r) => !has(r, "died_with_gold"),
      measure: (rs) => {
        const rate = rateOf(rs, "died_with_gold");
        return { cost: rate * 2.5, evidence: `You died with 1,300g+ unspent in ${pct(rate)} of recent games.` };
      },
    },
    {
      id: "objective_deaths",
      title: "Don't die before objectives",
      why: "A death right before dragon or baron spawns usually hands the enemy that objective for free. Those win games more than kills do.",
      rules: [
        "Check dragon and baron timers on every recall.",
        "From 60 seconds before spawn: no solo side-laning, no face-checks. Reset and group.",
        "If you die near spawn time, tell your team to give it rather than fight 4v5.",
      ],
      passRule: "The enemy never takes an objective within 90s of your death",
      check: (r) => !has(r, "died_before_objective"),
      measure: (rs) => {
        const rate = rateOf(rs, "died_before_objective");
        return { cost: rate * 3, evidence: `In ${pct(rate)} of recent games your death was followed by the enemy taking dragon, baron or another objective.` };
      },
    },
    {
      id: "shutdowns",
      title: "Stop throwing your leads",
      why: "Giving a shutdown turns your lead into theirs. You won lane, then paid them for it.",
      rules: [
        "When you're up a kill or more, spend the lead on items and plates, not more fights.",
        "Fight only when your team can reach you within a few seconds.",
        "Don't chase past river when ahead. The enemy wants you to.",
      ],
      passRule: "No shutdowns given and no deaths while 500g+ ahead in lane",
      check: (r) => !has(r, "gave_shutdown") && !has(r, "threw_lead"),
      measure: (rs) => {
        const rate = avg(rs.map((r) => (has(r, "gave_shutdown") || has(r, "threw_lead") ? 1 : 0)));
        return { cost: rate * 3, evidence: `You gave back a lead or a shutdown in ${pct(rate)} of recent games.` };
      },
    },
    {
      id: "farming",
      title: `Hit ${b.cs10} CS by 10 minutes`,
      why: "Minions are guaranteed gold. 10 CS is about one kill, and you can't be ganked for it.",
      rules: [
        "Last-hit first, trade second. Never miss a cannon minion.",
        "Practice last-hitting with no items in Practice Tool for 5 minutes before ranked.",
        "When you can't contest a wave safely, catch it under tower instead of skipping it.",
      ],
      passRule: `${b.cs10}+ CS at 10:00`,
      check: (r) => r.metrics.cs10 >= benchmarkFor(r.metrics.role).cs10,
      measure: (rs) => {
        const a = avg(rs.map((r) => r.metrics.cs10));
        return { cost: (b.cs10 - a) / 5, evidence: `You average ${Math.round(a)} CS at 10 min. Typical is ${b.cs10}; good players get 75+.` };
      },
    },
    {
      id: "losing_lane",
      title: "Stop losing lane on gold",
      why: "Being behind at 15 means every fight after is harder and your team has to carry you.",
      rules: [
        "Trade when the enemy laner uses a key spell on the wave, not when they're full.",
        "Contest plates only when you have priority (your wave is pushing).",
        "If you're behind, stop fighting and farm. Even CS beats a second death.",
      ],
      passRule: "Even or ahead in gold at 15:00",
      check: (r) => (r.metrics.goldDiff15 === null ? null : r.metrics.goldDiff15 >= 0),
      measure: (rs) => {
        const gd = rs.map((r) => r.metrics.goldDiff15).filter((x): x is number => x !== null);
        const a = avg(gd);
        return { cost: -a / 350, evidence: `You're ${a >= 0 ? "+" : ""}${Math.round(a)}g on average against your lane opponent at 15 min.` };
      },
    },
    {
      id: "absent_from_fights",
      title: "Show up to fights",
      why: "After laning, games are won by groups. If you aren't in the fight, your team is playing 4v5.",
      rules: [
        "After 14:00, when dragon or a tower fight is coming, shove your wave and walk there before it starts.",
        "Don't farm a side lane while your team fights mid unless you're pushing a tower.",
        "Each time your wave reaches their tower you have about 15 s before the next one arrives: use it to walk to the fight or the objective, not to wait in lane.",
      ],
      passRule: `${Math.round(b.killParticipation * 100)}%+ kill participation`,
      check: (r) => r.metrics.killParticipation >= benchmarkFor(r.metrics.role).killParticipation,
      measure: (rs) => {
        const a = avg(rs.map((r) => r.metrics.killParticipation));
        return { cost: (b.killParticipation - a) * 10, evidence: `Your kill participation is ${pct(a)}. Typical for your role is ${pct(b.killParticipation)}.` };
      },
    },
    {
      id: "vision",
      title: "Use your vision",
      why: "Most of your ganks and overextend deaths happen where you had no ward.",
      rules: [
        "Use your trinket every time it's off cooldown.",
        "Buy one control ward every recall. It's 75g.",
        "Switch to Oracle Lens after your first items if you're roaming.",
      ],
      passRule: `${b.visionPerMin.toFixed(1)}+ vision score per minute`,
      check: (r) => r.metrics.visionPerMin >= benchmarkFor(r.metrics.role).visionPerMin,
      measure: (rs) => {
        const a = avg(rs.map((r) => r.metrics.visionPerMin));
        return { cost: (b.visionPerMin - a) * 4, evidence: `Your vision score is ${a.toFixed(2)} per minute. Typical is ${b.visionPerMin.toFixed(2)}.` };
      },
    },
  ];
}

/** reports: newest first. */
export function coachPlan(reports: GameReport[], window = 15): CoachPlan {
  const rs = reports.slice(0, window);
  if (rs.length === 0) return { current: null, upNext: [], fixed: [], gamesConsidered: 0, verdict: "No games yet." };

  const issues: Issue[] = defs(rs).map((d) => {
    const { cost, evidence } = d.measure(rs);
    const results = rs.slice(0, 10).reverse().map(d.check);
    const last5 = results.filter((x) => x !== null).slice(-5) as boolean[];
    const recentPassRate = avg(last5.map((x) => (x ? 1 : 0)));
    return {
      id: d.id,
      title: d.title,
      evidence,
      why: d.why,
      rules: d.rules,
      passRule: d.passRule,
      cost,
      results,
      recentPassRate,
      // Fixed = the long-run numbers are fine, or you've passed it in 4 of your last 5.
      fixed: cost <= 0.3 || (last5.length >= 5 && recentPassRate >= 0.8),
    };
  });

  const open = issues.filter((i) => !i.fixed).sort((a, b) => b.cost - a.cost);
  const fixed = issues.filter((i) => i.fixed && i.cost > -99).sort((a, b) => a.cost - b.cost);
  const winRate = avg(rs.map((r) => (r.metrics.win ? 1 : 0)));

  let verdict: string;
  if (open.length === 0) verdict = `No major leaks in your last ${rs.length} games. If you're not climbing, play more games on fewer champions.`;
  else if (open.length >= 5) verdict = `${open.length} problems are costing you games. Fix them one at a time, starting with the one below.`;
  else verdict = `${open.length} problem${open.length > 1 ? "s" : ""} left. ${winRate < 0.5 ? `You've won ${pct(winRate)} of your last ${rs.length}, which means these are costing you LP.` : `You've won ${pct(winRate)} of your last ${rs.length}. Fixing these is how you climb faster.`}`;

  return { current: open[0] ?? null, upNext: open.slice(1, 3), fixed, gamesConsidered: rs.length, verdict };
}
