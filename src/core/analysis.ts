import { readGame } from "./engine";
import { buildTrack } from "./track";
import { benchmarkFor } from "./benchmarks";
import type {
  GameMetrics,
  GameReport,
  MatchDto,
  Mistake,
  MistakeContext,
  MistakeKind,
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

/**
 * Look at each of the player's deaths, flag what went wrong, guess what the player
 * was probably thinking from what they did, and say why that read was wrong.
 */
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
    const involved = [killer, ...helpers].filter((p): p is Participant => !!p && p.teamId !== me.teamId);
    const lanePhase = t < LANE_PHASE_END;
    const before = pf(timeline, t - 1, me.participantId);
    const oppFrame = opp ? pf(timeline, t - 1, opp.participantId) : undefined;
    const goldDiff = before && oppFrame ? before.totalGold - oppFrame.totalGold : null;
    const at = fmtTime(t);
    const obj = events.find(
      (e) =>
        e.type === "ELITE_MONSTER_KILL" &&
        e.killerTeamId !== undefined &&
        e.killerTeamId !== me.teamId &&
        e.timestamp > t &&
        e.timestamp - t <= 90_000,
    );
    const objName = obj ? (MONSTER_NAMES[obj.monsterType ?? ""] ?? "an objective") : null;
    const context: MistakeContext = {
      minute: t / MIN,
      currentGold: before?.currentGold ?? null,
      goldDiff,
      position: d.position ?? null,
      killers: involved.map((p) => p.championName),
      enemyJunglerInvolved: involved.some((p) => p.teamPosition === "JUNGLE"),
      numberOfEnemies: involved.length,
      deepInEnemyHalf: !!d.position && isDeepInEnemyHalf(me.teamId, d.position),
      followedBy: objName && obj ? { name: objName, afterSec: Math.round((obj.timestamp - t) / 1000) } : null,
      shutdownGiven: d.shutdownBounty ?? 0,
    };
    const add = (kind: MistakeKind, severity: number, title: string, detail: string, read: string, tip: string) =>
      out.push({ kind, timeMs: t, severity, title, detail, read, tip, context });
    let flagged = false;
    const outnumbered = involved.length >= 2 ? ` You were caught ${involved.length}v1.` : "";

    if (lanePhase && context.enemyJunglerInvolved) {
      add(
        "ganked",
        7,
        `Ganked at ${at}`,
        `The enemy jungler${involved.length > 2 ? ` and ${involved.length - 2} more` : ""} killed you in lane.${outnumbered}`,
        goldDiff !== null && goldDiff > 300
          ? "You were ahead and pushing, so you likely assumed your lane opponent couldn't punish you and forgot the jungler exists."
          : "You were likely focused on your lane opponent and the wave, and weren't tracking where the enemy jungler was.",
        "You don't need to see the jungler to know where they are. Note their last sighting and which side they started. If you can't account for them, don't stand past the middle of your lane without a river ward.",
      );
      flagged = true;
    }

    if (context.deepInEnemyHalf) {
      add(
        "overextended",
        lanePhase ? 6 : 7,
        `Overextended at ${at}`,
        `You died deep on the enemy's half of the map.${outnumbered}`,
        lanePhase
          ? "You likely chased a kill or kept pushing because the wave or a low-HP target looked free."
          : "You likely walked forward to farm a side wave or check a bush without knowing where the enemy team was.",
        "Count the enemies you can see. If 2 or more are missing, the space past river is theirs. Farm on your side and let the wave come to you.",
      );
      flagged = true;
    }

    if (context.shutdownGiven >= 300) {
      add(
        "gave_shutdown",
        8,
        `Gave up a ${context.shutdownGiven}g shutdown at ${at}`,
        "You were the most valuable target on the map and the enemy collected it.",
        "Being fed probably made you feel you could win any fight, so you took one without checking how many enemies could join.",
        "A lead is a tool, not a shield. Spend it on items and objectives, and only fight when your team is close enough to help.",
      );
      flagged = true;
    }

    if (before && before.currentGold >= 1300) {
      add(
        "died_with_gold",
        5,
        `Died holding ${before.currentGold}g at ${at}`,
        "You had a full item component unspent when you died.",
        "You likely stayed for one more wave or a plate because leaving felt like losing farm.",
        "Unspent gold does nothing. When you have 1,100g+ and your wave is pushed in, recall. You'll come back stronger than the farm you'd have taken.",
      );
      flagged = true;
    }

    if (lanePhase && goldDiff !== null && goldDiff >= 500 && opp) {
      add(
        "threw_lead",
        6,
        `Threw a ${goldDiff}g lead at ${at}`,
        `You were ${goldDiff}g ahead of ${opp.championName} and died, giving most of it back.`,
        "You were ahead, so you likely played as if the lead made you safe from everything, not just your lane opponent.",
        "When you're ahead in lane, the only way to lose it is to die. Shove, take plates, recall on a good timer. Make them come to you.",
      );
      flagged = true;
    }

    if (obj && objName) {
      add(
        "died_before_objective",
        obj.monsterType === "BARON_NASHOR" ? 9 : 6,
        `Your death gave them ${objName}`,
        `The enemy took ${objName} ${context.followedBy!.afterSec}s after you died.`,
        `You likely weren't watching the objective timer, or you thought one more wave or play was worth it before ${objName}.`,
        "Check objective timers every time you recall. From 60s before spawn, don't make risky plays: reset, buy and move with your team.",
      );
      flagged = true;
    }

    if (!flagged && lanePhase) {
      add(
        "early_death",
        4,
        `Died in lane at ${at}`,
        killer ? `${killer.championName} killed you${involved.length > 1 ? ` with help` : " 1v1"}.` : "You died during laning.",
        "You likely misjudged how much damage they had, or traded when their key ability was up.",
        "Before trading, check their level, items and whether their main spell is up. If you can't name their kill combo, trade only when it's on cooldown.",
      );
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

  const me = findPlayer(match, puuid);
  const opp = findOpponent(match, me);
  const track = buildTrack(match, timeline);
  const series = timeline.info.frames.map((f) => {
    const a = f.participantFrames[String(me.participantId)];
    const b = opp ? f.participantFrames[String(opp.participantId)] : undefined;
    return {
      minute: Math.round(f.timestamp / MIN),
      goldDiff: a && b ? a.totalGold - b.totalGold : null,
      xpDiff: a && b ? a.xp - b.xp : null,
      cs: cs(a),
      oppCs: b ? cs(b) : null,
    };
  });
  const kills = allEvents(timeline).filter((e) => e.type === "CHAMPION_KILL" && e.position);
  const toMap = (e: TimelineEvent) => ({ timeMs: e.timestamp, x: e.position!.x, y: e.position!.y });

  return {
    metrics: m,
    teamId: me.teamId,
    gameVersion: match.info.gameVersion,
    series,
    deathsAt: kills.filter((e) => e.victimId === me.participantId).map(toMap),
    killsAt: kills.filter((e) => e.killerId === me.participantId).map(toMap),
    mistakes,
    strengths,
    focus: pickFocus(m, all),
    grade: grade(m, all),
    track,
    leaks: readGame(match, timeline, track, me, opp),
  };
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
  return "No single leak stood out. Rewatch your first death and name what you could have known before it.";
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
