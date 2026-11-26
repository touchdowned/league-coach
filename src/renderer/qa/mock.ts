// Preview-only: a fake main process so the renderer can be opened in a plain browser
// (npm run preview:qa) with believable games, for screenshots and UI checks.
// Nothing here ships: vite only builds index.html.
import { buildReport } from "../../core/analysis";
import { EMPTY_PROGRESS, applyEvent, type ProgressState } from "../../core/progress";
import type { GameReport, TimelineEvent } from "../../core/types";
import { death, makeGame, ME } from "../../../tests/fixtures";
import { coachPlan } from "../../core/coach";
import { baselineFrom, challengeDefs, ISSUE_CHALLENGE, matchupRead, queueCheck, suggestMental, tiltProfile, type ChallengeId, type LiveView } from "../../core/mind";
import type { CoachApi, DraftInfo, DraftOption, LivePayload, Settings } from "../api";

const CHAMPS = ["Garen", "LeeSin", "Ahri", "Jinx", "Thresh", "Darius", "Viego", "Zed", "Caitlyn", "Lulu"];
const MINE = ["Ahri", "Ahri", "Syndra", "Ahri", "Orianna", "Syndra", "Ahri", "Ahri", "Orianna", "Ahri", "Syndra", "Ahri"];

const SAMPLE_FINDINGS: NonNullable<GameReport["findings"]> = [
  {
    id: "recall-2", kind: "recall", t: 387_000, time: "6:27", title: "Recall at 6:27 gave up cannon wave 12",
    proof: ["Recall began at 6:27 in the bottom river by dragon; in the fountain 6:35 to 6:38.", "Last in XP range of the mid wave at 6:14, back in range at 6:50: 36 s away.", "When you left: 5 enemy minions against your 4 at the front, 2250 units from your tower.", "11.5 enemy minions died in mid while you were out of XP range: 1.5 of wave 11 (spawned 5:30), 7 of wave 12 (spawned 6:00), 3 of wave 13 (spawned 6:30).", "Wave 12 was a cannon wave: alive when you left, dead when you got back."],
    cost: "1.8 waves: 563 XP and up to 232 gold in last hits (over the 1.5-wave line).", gold: 232, xp: 563, minions: 11.5,
    fix: "Start this recall 21 s later, leaving the wave at 6:35. The same 36 s trip then loses 4.5 minions instead of 11.5: 331 XP and 139 gold kept. That means killing the 5 enemy minions at the front first; they died at your tower without you.",
    jump: { t: 368_000, follow: "Azir" }, score: 570,
  },
  {
    id: "exposure-1", kind: "exposure", t: 585_000, time: "9:45", title: "9:45: past the middle with Lillia unseen for 38 s, dead at 9:57", deathAt: 597_000,
    proof: ["From 9:45 to 9:56 you stood up to 1450 units past the middle of the map (deepest at 9:52, in mid lane).", "Lillia was last on your team's minimap at 9:07 in their top-side jungle, 38 s before: far enough back to have walked to you (5200 units at 500 units a second).", "With fog off: Lillia was 2900 units from you at 9:49, in the top river by baron, and on you at 9:55.", "Allied wards standing within 3000 units of you: 0."],
    cost: "You died at 9:57: 300 gold to them, and 1.6 waves: 474 XP and up to 184 gold in last hits while dead and walking back (53 s).", gold: 484, xp: 474, minions: 10,
    fix: "From 9:45, when Lillia could first have reached you unseen, stand 1450 units further back (at or behind the middle line) until Lillia shows. Lillia came through the top river by baron at 9:49: a ward there placed before 9:39 shows the gank 6 s before it lands.",
    jump: { t: 580_000, follow: "Azir" }, score: 768,
  },
];

function games(): GameReport[] {
  const out: GameReport[] = [];
  for (let i = 0; i < 12; i++) {
    const evs: TimelineEvent[] = [
      death((4 + (i % 3)) * 60_000 + 12_000, 3, 7, { position: { x: 8200, y: 8400 } }),
      death((9 + (i % 4)) * 60_000 + 40_000, 3, 2 + 5, { assistingParticipantIds: [8], position: { x: 9500, y: 9100 } }),
      { type: "ITEM_PURCHASED", timestamp: 6 * 60_000 + 20_000, participantId: 3, itemId: 1056 },
      { type: "WARD_PLACED", timestamp: 3 * 60_000, creatorId: 3, wardType: "YELLOW_TRINKET" } as TimelineEvent,
    ];
    if (i % 2) evs.push(death(13 * 60_000 + 5_000, 3, 9, { position: { x: 10000, y: 9800 } }));
    const g = makeGame({ id: `NA1_50000${i}`, win: i % 3 !== 0, myChamp: MINE[i], myCsPerMin: 5.2 + (i % 5) * 0.5, myGpm: 360 + i * 6, oppGpm: 400, events: evs, currentGold: i % 2 ? 1700 : 300 });
    g.match.info.participants.forEach((p, k) => { if (p.puuid !== ME) p.championName = CHAMPS[k]; p.riotIdGameName = `Player${k}`; });
    // Lanes and a wandering jungler so the map views and the jungle drill have something real to show.
    const lane: Record<string, [number, number]> = { TOP: [2500, 11500], MIDDLE: [7400, 7400], BOTTOM: [11800, 2800], UTILITY: [12200, 3200] };
    g.timeline.info.frames.forEach((f, m) => {
      for (const pf of Object.values(f.participantFrames)) {
        const part = g.match.info.participants[pf.participantId - 1];
        const blue = part.teamId === 100;
        const [lx, ly] = lane[part.teamPosition] ?? [7400, 7400];
        const jx = 4000 + ((m * 2900 + pf.participantId * 1700 + i * 900) % 7000);
        const jy = 4000 + ((m * 4100 + pf.participantId * 900 + i * 1300) % 7000);
        const [x, y] = part.teamPosition === "JUNGLE" ? [jx, jy] : [lx + (blue ? -600 : 600), ly + (blue ? -600 : 600)];
        pf.position = { x: Math.round(x), y: Math.round(y) };
      }
    });
    g.match.info.gameCreation = Date.now() - (i + 1) * 3.6e6 * 5;
    out.push(buildReport(g.match, g.timeline, ME));
    // The preview has no replay read, so the first game carries sample findings to show the panel.
    if (out.length === 1) out[0].findings = SAMPLE_FINDINGS;
  }
  return out;
}

/** Mirrors MindManager.buildDraft in the main process, for champ select as Ahri into Zed. */
function draft(reports: GameReport[]): DraftInfo {
  const defs = challengeDefs(baselineFrom(reports, "MIDDLE"));
  const plan = coachPlan(reports);
  const opt = (id: ChallengeId, reason: string): DraftOption => ({ id, title: defs[id].title, rule: defs[id].rule, why: defs[id].why, pass: defs[id].pass, reason });
  const skill: DraftOption[] = [];
  const add = (id: ChallengeId, reason: string) => !skill.some((x) => x.id === id) && skill.push(opt(id, reason));
  if (plan.current) add(ISSUE_CHALLENGE[plan.current.id], plan.current.evidence);
  for (const i of plan.upNext) add(ISSUE_CHALLENGE[i.id], i.evidence);
  for (const id of ["deaths14", "cs10", "vision"] as ChallengeId[]) if (skill.length < 3) add(id, "A solid default while the coach learns your games.");
  const m = suggestMental(reports, []);
  return {
    phase: "champ-select", champion: "Ahri", championName: "Ahri", role: "MIDDLE", enemy: "Zed", enemyName: "Zed",
    read: matchupRead(reports, "Ahri", "Zed"), skillOptions: skill.slice(0, 3),
    mentalOptions: (["reset_after_death", "steady_after_death", "check_ins"] as ChallengeId[]).map((id) => opt(id, id === m.id ? m.reason : defs[id].why)),
    recommendedSkill: skill[0]?.id ?? "deaths14", recommendedMental: m.id, queue: queueCheck(tiltProfile(reports), []), plan: null, lastIntention: null,
  };
}

/** The overlay as it looks mid-game; ?dead shows the death card. */
function live(): LivePayload {
  const dead = new URLSearchParams(location.search).has("dead");
  const t = 742;
  const view: LiveView = {
    gameTime: t, champion: "Ahri", role: "MIDDLE", isDead: dead, respawnIn: dead ? 12 : 0, gold: 1240, kda: [3, 2, 4], cs: 74, focus: 72,
    skill: { id: "cs10", kind: "skill", title: "70 CS by 10:00", status: "passed", progress: 1, value: "74 / 70", detail: "Hit at 10:00" },
    mental: { id: "reset_after_death", kind: "mental", title: "Reset after every death", status: dead ? "at-risk" : "on-track", progress: dead ? 0 : 0.6, value: dead ? "Dead" : "36s", detail: dead ? "Breathe. Plan the next 90s." : "Farm and ward, no trades" },
    deaths: [],
    lastDeath: dead ? { t: t - 4, gold: 1240, killer: "Player1", killerChamp: "Lee Sin", helpers: 1, jungler: true, streak: 0, chain: false, respawnAt: t + 12, beforeObjective: null, csBefore: 7.2, csAfter: null, checkIn: null } : null,
    nudges: dead ? [] : [{ key: "drag", at: t, tone: "info", text: "Dragon in 58s. Reset now if you need to, then group. No solo side lane." }],
    nextObjective: { name: "Dragon", inSec: 58 },
  };
  return { view, intention: "Play for the long game", rules: { skill: "Last hit first, trade second. Never miss a cannon.", mental: "First 90s after you respawn: farm, ward, no trades.", skillId: "cs10", mentalId: "reset_after_death" } };
}

export function installMock() {
  // ?fresh shows a first run: no Riot ID, no games.
  const fresh = new URLSearchParams(location.search).has("fresh");
  const reports = fresh ? [] : games();
  let settings: Settings = {
    apiKey: "RGAPI-preview", riotId: "Preview#NA1", region: "na1", matchCount: 20, leagueDir: "C:\\Riot Games\\League of Legends",
    vodDir: "", autoAdvanceSec: 6, autoReview: true, autoLaunchReplay: true, launchAtLogin: false, overlay: true, overlayNudges: true,
    overlayPos: null, draftCompanion: true, autoDebrief: true,
  };
  if (fresh) settings = { ...settings, apiKey: "", riotId: "" };
  let progress: ProgressState = { ...EMPTY_PROGRESS };
  let mind: import("../api").MindData = { plans: [], records: [], debriefs: [], pending: [] };
  const off = () => () => {};
  const no = async () => ({ ok: false as const, error: "Not available in the preview." });
  const known: Partial<CoachApi> = {
    getSettings: async () => settings,
    setSettings: async (s) => { settings = s; },
    sync: async () => (fresh ? { ok: false, error: "Add your Riot ID and API key in Settings first." } : { ok: true, reports }),
    listGames: async () => reports,
    getProgress: async () => progress,
    progressEvent: async (e) => { const r = applyEvent(progress, e); progress = r.state; return r; },
    replayState: async () => ({ ok: true, value: { kind: "client-closed" } }),
    postGameStatus: async () => ({ ok: true, value: undefined }),
    // ?debrief leaves the newest game waiting for its debrief.
    mindGet: async () => ({ ok: true, value: { ...mind, pending: new URLSearchParams(location.search).has("debrief") && reports[0] ? [reports[0].metrics.matchId.split("_").pop()!] : [] } }),
    mindSaveDebrief: async (db) => { mind = { ...mind, debriefs: [db, ...mind.debriefs] }; return { ok: true, value: { ...mind, pending: [] } }; },
    mindSkipDebrief: async () => ({ ok: true, value: { ...mind, pending: [] } }),
    clipsList: async () => ({ ok: true, value: {} }),
    vodFind: async () => ({ ok: true, value: null }),
    benchGet: async () => ({ ok: true, value: [] }),
    mindDraftInfo: async () => ({ ok: true, value: draft(reports) }),
    onMindLive: (cb) => { if (location.hash === "#live-overlay") setTimeout(() => cb(live()), 50); return () => {}; },
  };
  window.coach = new Proxy(known as CoachApi, {
    get: (t, k: string) => (k in t ? (t as any)[k] : k.startsWith("on") ? off : no),
  });
}
