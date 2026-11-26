// Preview-only: a fake main process so the renderer can be opened in a plain browser
// (npm run preview:qa) with believable games, for screenshots and UI checks.
// Nothing here ships: vite only builds index.html.
import { buildReport } from "../../core/analysis";
import { EMPTY_PROGRESS, applyEvent, type ProgressState } from "../../core/progress";
import type { GameReport, TimelineEvent } from "../../core/types";
import { death, makeGame, ME } from "../../../tests/fixtures";
import type { CoachApi, Settings } from "../api";

const CHAMPS = ["Garen", "LeeSin", "Ahri", "Jinx", "Thresh", "Darius", "Viego", "Zed", "Caitlyn", "Lulu"];
const MINE = ["Ahri", "Ahri", "Syndra", "Ahri", "Orianna", "Syndra", "Ahri", "Ahri", "Orianna", "Ahri", "Syndra", "Ahri"];

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
  }
  return out;
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
    mindGet: async () => ({ ok: true, value: { plans: [], records: [], debriefs: [], pending: [] } }),
    clipsList: async () => ({ ok: true, value: {} }),
    vodFind: async () => ({ ok: true, value: null }),
    benchGet: async () => ({ ok: true, value: [] }),
  };
  window.coach = new Proxy(known as CoachApi, {
    get: (t, k: string) => (k in t ? (t as any)[k] : k.startsWith("on") ? off : no),
  });
}
