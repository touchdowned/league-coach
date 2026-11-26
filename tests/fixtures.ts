import type { MatchDto, Participant, ParticipantFrame, Position, TimelineDto, TimelineEvent } from "../src/core/types";

const ROLES: Position[] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
export const ME = "me-puuid";

export interface FixtureOpts {
  myRole?: Position;
  win?: boolean;
  myChamp?: string;
  events?: TimelineEvent[];
  /** gold per minute for me and my lane opponent */
  myGpm?: number;
  oppGpm?: number;
  myCsPerMin?: number;
  currentGold?: number;
  id?: string;
}

/** Builds a 10 player, 30 minute game. Participant 1-5 are blue (100), 6-10 red (200). */
export function makeGame(o: FixtureOpts = {}): { match: MatchDto; timeline: TimelineDto } {
  const myRole = o.myRole ?? "MIDDLE";
  const myIdx = ROLES.indexOf(myRole);
  const participants: Participant[] = [];
  for (let i = 0; i < 10; i++) {
    const team = i < 5 ? 100 : 200;
    const role = ROLES[i % 5];
    const isMe = team === 100 && i === myIdx;
    participants.push({
      puuid: isMe ? ME : `p${i}`,
      participantId: i + 1,
      teamId: team,
      teamPosition: role,
      championName: isMe ? (o.myChamp ?? "Ahri") : `Champ${i}`,
      kills: isMe ? 5 : 3,
      deaths: 3,
      assists: isMe ? 6 : 4,
      totalMinionsKilled: isMe ? Math.round((o.myCsPerMin ?? 7) * 30) : 180,
      neutralMinionsKilled: 0,
      goldEarned: 10000,
      visionScore: 20,
      totalDamageDealtToChampions: 15000,
      win: team === 100 ? (o.win ?? true) : !(o.win ?? true),
      challenges: { soloKills: isMe ? 1 : 0 },
    });
  }
  const myId = myIdx + 1;
  const oppId = myIdx + 6;

  const frames = [];
  for (let min = 0; min <= 30; min++) {
    const pfs: Record<string, ParticipantFrame> = {};
    for (const p of participants) {
      const gpm = p.participantId === myId ? (o.myGpm ?? 400) : p.participantId === oppId ? (o.oppGpm ?? 400) : 400;
      const cpm = p.participantId === myId ? (o.myCsPerMin ?? 7) : 6;
      pfs[String(p.participantId)] = {
        participantId: p.participantId,
        totalGold: 500 + gpm * min,
        currentGold: p.participantId === myId ? (o.currentGold ?? 300) : 300,
        xp: 400 * min,
        level: Math.min(18, 1 + min),
        minionsKilled: Math.round(cpm * min),
        jungleMinionsKilled: 0,
        position: { x: 7000, y: 7000 },
      };
    }
    frames.push({ timestamp: min * 60_000, participantFrames: pfs, events: [] as TimelineEvent[] });
  }
  for (const e of o.events ?? []) frames[Math.min(30, Math.floor(e.timestamp / 60_000) + 1)].events.push(e);

  const id = o.id ?? "NA1_1";
  return {
    match: {
      metadata: { matchId: id, participants: participants.map((p) => p.puuid) },
      info: { gameCreation: 1_700_000_000_000, gameDuration: 1800, queueId: 420, gameVersion: "15.1", participants },
    },
    timeline: { metadata: { matchId: id }, info: { frameInterval: 60_000, frames } },
  };
}

export function death(timestamp: number, victimId: number, killerId: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { type: "CHAMPION_KILL", timestamp, victimId, killerId, assistingParticipantIds: [], position: { x: 7000, y: 7000 }, ...extra };
}
