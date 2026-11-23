import { benchmarkFor } from "./benchmarks";
import type {
  GameMetrics,
  GameReport,
  MatchDto,
  Mistake,
  Participant,
  ParticipantFrame,
  TimelineDto,
  TimelineEvent,
} from "./types";

const MIN = 60_000;
const LANE_PHASE_END = 14 * MIN;
// Summoner's Rift spans roughly 0..14870 on both axes. Blue base is bottom-left,
// red base top-right, and the river runs along x + y ≈ 14870.
const RIVER_SUM = 14870;
const DEEP_MARGIN = 2500;

const MONSTER_NAMES: Record<string, string> = {
  DRAGON: "dragon",
  BARON_NASHOR: "baron",
  RIFTHERALD: "herald",
  HORDE: "voidgrubs",
  ATAKHAN: "Atakhan",
};

export function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The frame closest to (at or before) `ms`. */
function frameAt(timeline: TimelineDto, ms: number) {
  const frames = timeline.info.frames;
  let best = frames[0];
  for (const f of frames) {
    if (f.timestamp <= ms + 1000) best = f;
    else break;
  }
  return best;
}

function pf(timeline: TimelineDto, ms: number, participantId: number): ParticipantFrame | undefined {
  return frameAt(timeline, ms)?.participantFrames[String(participantId)];
}

function hasFrameAt(timeline: TimelineDto, ms: number): boolean {
  const last = timeline.info.frames[timeline.info.frames.length - 1];
  return !!last && last.timestamp >= ms - 1000;
}

function cs(frame: ParticipantFrame | undefined): number {
  return frame ? frame.minionsKilled + frame.jungleMinionsKilled : 0;
}

function allEvents(timeline: TimelineDto): TimelineEvent[] {
  return timeline.info.frames.flatMap((f) => f.events);
}

/** Is this point on the enemy's half of the map, well past the river? */
export function isDeepInEnemyHalf(teamId: number, pos: { x: number; y: number }): boolean {
  const sum = pos.x + pos.y;
  return teamId === 100 ? sum > RIVER_SUM + DEEP_MARGIN : sum < RIVER_SUM - DEEP_MARGIN;
}

export function findPlayer(match: MatchDto, puuid: string): Participant {
  const p = match.info.participants.find((x) => x.puuid === puuid);
  if (!p) throw new Error(`Player not found in ${match.metadata.matchId}`);
  return p;
}

export function findOpponent(match: MatchDto, me: Participant): Participant | null {
  if (!me.teamPosition) return null;
  return match.info.participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition) ?? null;
}

export function computeMetrics(match: MatchDto, timeline: TimelineDto, puuid: string): GameMetrics {
  const me = findPlayer(match, puuid);
  const opp = findOpponent(match, me);
  const durationMin = match.info.gameDuration / 60;
  const id = me.participantId;

  const diff = (ms: number, key: "totalGold" | "xp"): number | null => {
    if (!opp || !hasFrameAt(timeline, ms)) return null;
    const a = pf(timeline, ms, id);
    const b = pf(timeline, ms, opp.participantId);
    return a && b ? a[key] - b[key] : null;
  };

  const kills = allEvents(timeline).filter((e) => e.type === "CHAMPION_KILL");
  const deathsPre14 = kills.filter((e) => e.victimId === id && e.timestamp < LANE_PHASE_END).length;

  const team = match.info.participants.filter((p) => p.teamId === me.teamId);
  const teamKills = team.reduce((s, p) => s + p.kills, 0);
  const teamDamage = team.reduce((s, p) => s + p.totalDamageDealtToChampions, 0);

  return {
    matchId: match.metadata.matchId,
    gameCreation: match.info.gameCreation,
    durationMin,
    queueId: match.info.queueId,
    role: me.teamPosition,
    champion: me.championName,
    opponentChampion: opp?.championName ?? null,
    win: me.win,
    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,
    cs10: cs(pf(timeline, 10 * MIN, id)),
    cs15: cs(pf(timeline, 15 * MIN, id)),
    csPerMin: (me.totalMinionsKilled + me.neutralMinionsKilled) / Math.max(durationMin, 1),
    goldDiff10: diff(10 * MIN, "totalGold"),
    goldDiff15: diff(15 * MIN, "totalGold"),
    xpDiff10: diff(10 * MIN, "xp"),
    xpDiff15: diff(15 * MIN, "xp"),
    deathsPre14,
    killParticipation: teamKills ? (me.kills + me.assists) / teamKills : 0,
    visionPerMin: me.visionScore / Math.max(durationMin, 1),
    soloKills: me.challenges?.soloKills ?? 0,
    damageShare: teamDamage ? me.totalDamageDealtToChampions / teamDamage : 0,
  };
}

/** Look at each of the player's deaths and flag what went wrong. */
export function findMistakes(match: MatchDto, timeline: TimelineDto, puuid: string): Mistake[] {
  const me = findPlayer(match, puuid);
  const opp = findOpponent(match, me);
  const byId = new Map(match.info.participants.map((p) => [p.participantId, p]));
  const events = allEvents(timeline);
  const out: Mistake[] = [];

  const myDeaths = events.filter((e) => e.type === "CHAMPION_KILL" && e.victimId === me.participantId);

  for (const d of myDeaths) {
    const t = d.timestamp;
    const killer = d.killerId ? byId.get(d.killerId) : undefined;
    const helpers = (d.assistingParticipantIds ?? []).map((i) => byId.get(i)).filter(Boolean) as Participant[];
    const involved = [killer, ...helpers].filter(Boolean) as Participant[];
    const lanePhase = t < LANE_PHASE_END;
    const before = pf(timeline, t - 1, me.participantId);
    const at = fmtTime(t);
    let flagged = false;

    // Ganked by the enemy jungler during laning.
    if (lanePhase && involved.some((p) => p.teamPosition === "JUNGLE")) {
      out.push({
        kind: "ganked",
        timeMs: t,
        severity: 7,
        title: `Ganked at ${at}`,
        detail: `The enemy jungler${involved.length > 1 ? ` and ${involved.length - 1} other(s)` : ""} caught you during laning.`,
        tip: "Before you push past the middle of the lane, check where the enemy jungler was last seen. If you don't know, assume they're nearby and play safe or ward the river.",
      });
      flagged = true;
    }

    // Died deep on the enemy's side of the map.
    if (d.position && isDeepInEnemyHalf(me.teamId, d.position)) {
      out.push({
        kind: "overextended",
        timeMs: t,
        severity: lanePhase ? 6 : 7,
        title: `Overextended at ${at}`,
        detail: "You died deep on the enemy's half of the map.",
        tip: "Only walk into enemy territory with vision, with your team nearby, or when you know where most enemies are.",
      });
      flagged = true;
    }

    // Gave a shutdown.
    if ((d.shutdownBounty ?? 0) >= 300) {
      out.push({
        kind: "gave_shutdown",
        timeMs: t,
        severity: 8,
        title: `Gave up a ${d.shutdownBounty}g shutdown at ${at}`,
        detail: "You were worth a big bounty and the enemy collected it.",
        tip: "When you're fed, you are the most valuable target on the map. Recall with your lead, and fight only with your team or with vision.",
      });
      flagged = true;
    }

    // Died holding a lot of unspent gold.
    if (before && before.currentGold >= 1300) {
      out.push({
        kind: "died_with_gold",
        timeMs: t,
        severity: 5,
        title: `Died holding ${before.currentGold}g at ${at}`,
        detail: "You had enough gold for a big item but hadn't spent it.",
        tip: "Recall when you have gold for a component (usually 1100g+) and the wave is pushed. Spending it makes you stronger for the next fight.",
      });
      flagged = true;
    }

    // Was ahead of the lane opponent and died, giving the lead back.
    if (lanePhase && opp && before) {
      const oppFrame = pf(timeline, t - 1, opp.participantId);
      if (oppFrame && before.totalGold - oppFrame.totalGold >= 500) {
        out.push({
          kind: "threw_lead",
          timeMs: t,
          severity: 6,
          title: `Gave back your lead at ${at}`,
          detail: `You were ${before.totalGold - oppFrame.totalGold}g ahead of ${opp.championName} and died.`,
          tip: "When you're ahead, push the wave, take plates or recall to buy. You don't need to take risky fights to stay ahead.",
        });
        flagged = true;
      }
    }

    // Enemy took a big objective shortly after the death.
    const obj = events.find(
      (e) =>
        e.type === "ELITE_MONSTER_KILL" &&
        e.killerTeamId !== undefined &&
        e.killerTeamId !== me.teamId &&
        e.timestamp > t &&
        e.timestamp - t <= 90_000,
    );
    if (obj) {
      const name = MONSTER_NAMES[obj.monsterType ?? ""] ?? "an objective";
      out.push({
        kind: "died_before_objective",
        timeMs: t,
        severity: obj.monsterType === "BARON_NASHOR" ? 9 : 6,
        title: `Death led to enemy ${name} at ${fmtTime(obj.timestamp)}`,
        detail: `The enemy took ${name} ${Math.round((obj.timestamp - t) / 1000)}s after you died.`,
        tip: "About a minute before an objective spawns, stop taking risks: reset, buy and group with your team.",
      });
      flagged = true;
    }

    if (!flagged && lanePhase) {
      out.push({
        kind: "early_death",
        timeMs: t,
        severity: 4,
        title: `Died in lane at ${at}`,
        detail: killer ? `Killed by ${killer.championName}.` : "Died during laning.",
        tip: "Watch this in the replay. Ask: did I know their damage and cooldowns, and where the minion wave was?",
      });
    }
  }

  return out.sort((a, b) => b.severity - a.severity || a.timeMs - b.timeMs);
}

export function buildReport(match: MatchDto, timeline: TimelineDto, puuid: string): GameReport {
  const m = computeMetrics(match, timeline, puuid);
  const bench = benchmarkFor(m.role);
  const all = findMistakes(match, timeline, puuid);
  const mistakes = all.slice(0, 5);

  const strengths: string[] = [];
  if (m.cs10 >= bench.cs10 + 5) strengths.push(`Strong farming: ${m.cs10} CS at 10 min (typical is ~${bench.cs10}).`);
  if ((m.goldDiff15 ?? 0) >= 500) strengths.push(`Won lane: +${m.goldDiff15}g on ${m.opponentChampion} at 15 min.`);
  if (m.deathsPre14 === 0) strengths.push("No deaths before 14 minutes.");
  if (m.killParticipation >= bench.killParticipation + 0.1)
    strengths.push(`High kill participation (${Math.round(m.killParticipation * 100)}%).`);
  if (m.visionPerMin >= bench.visionPerMin + 0.2) strengths.push(`Good vision (${m.visionPerMin.toFixed(2)} per min).`);
  if (m.soloKills >= 2) strengths.push(`${m.soloKills} solo kills.`);

  return { metrics: m, mistakes, strengths, focus: pickFocus(m, all), grade: grade(m, all) };
}

function pickFocus(m: GameMetrics, mistakes: Mistake[]): string {
  const bench = benchmarkFor(m.role);
  const count = (k: Mistake["kind"]) => mistakes.filter((x) => x.kind === k).length;
  if (count("ganked") >= 2) return "Track the enemy jungler: before each push, say out loud where they were last seen.";
  if (m.deathsPre14 >= 3) return "Aim for 1 or fewer deaths before 14 minutes. Play for farm when you're unsure.";
  if (count("died_with_gold") >= 2) return "Recall on time: when you have 1100g+ and the wave is pushed, go back and buy.";
  if (count("overextended") >= 2) return "Stop walking into enemy jungle without vision or your team.";
  if (m.cs10 < bench.cs10 - 10) return `Farm better in lane: aim for ${bench.cs10}+ CS at 10 minutes.`;
  if (count("died_before_objective") >= 1) return "Play safe in the minute before dragon and baron spawn.";
  if (m.visionPerMin < bench.visionPerMin - 0.2) return "Use your trinket on cooldown and buy a control ward every recall.";
  return "Keep it up. Review your first death and ask what you could have known.";
}

function grade(m: GameMetrics, mistakes: Mistake[]): GameReport["grade"] {
  const bench = benchmarkFor(m.role);
  let s = 0;
  s += (m.cs10 - bench.cs10) / 10;
  s += (m.goldDiff15 ?? 0) / 800;
  s += (bench.deathsPre14 - m.deathsPre14) * 0.6;
  s += (m.killParticipation - bench.killParticipation) * 4;
  s += ((m.kills + m.assists) / Math.max(m.deaths, 1) - 2.5) * 0.4;
  s += m.win ? 0.5 : 0;
  s -= mistakes.reduce((t, x) => t + x.severity, 0) / 15;
  if (s >= 3) return "S";
  if (s >= 1.5) return "A";
  if (s >= 0) return "B";
  if (s >= -1.5) return "C";
  return "D";
}
