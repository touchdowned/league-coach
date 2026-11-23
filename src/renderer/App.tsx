import { useEffect, useState } from "react";
import { Brain, CircleAlert, Clapperboard, Compass, Gamepad2, LoaderCircle, LucideIcon, PlayCircle, RefreshCw, Settings as SettingsIcon, Swords, Target } from "lucide-react";
import { toast, Toaster } from "sonner";
import type { GameReport } from "../core/types";
import { momentCount } from "../core/engine";
import { coach, PostGameStatus, Settings, TaskProgress } from "./api";
import { PlayerCard, ProgressProvider, useProgress } from "./progress";
import { Button, Skeleton } from "./ui";
import { firstOpenStep, SessionBar, SessionStep } from "./session";
import { ChampionsView } from "./views/Champions";
import { CoachView } from "./views/Coach";
import { MechanicsView } from "./views/Mechanics";
import { PuzzlesView } from "./views/Puzzles";
import { ReviewView } from "./views/Review";
import { RoleView } from "./views/Role";
import { SettingsView } from "./views/Settings";

export type Tab = "coach" | "review" | "puzzles" | "mechanics" | "champions" | "role" | "settings";

const NAV: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "coach", label: "Coach", icon: Target },
  { id: "review", label: "Review", icon: Clapperboard },
  { id: "puzzles", label: "Puzzles", icon: Brain },
  { id: "mechanics", label: "Mechanics", icon: Gamepad2 },
  { id: "champions", label: "Champions", icon: Swords },
  { id: "role", label: "Best role", icon: Compass },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

export function App() {
  return (
    <ProgressProvider>
      <Shell />
      <Toaster position="bottom-right" theme="dark" toastOptions={{ className: "toast" }} />
    </ProgressProvider>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>("coach");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [games, setGames] = useState<GameReport[] | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ matchId: string; autoplay: boolean; kind?: string } | null>(null);
  const [sync, setSync] = useState<TaskProgress | null>(null);
  const [postGame, setPostGame] = useState<PostGameStatus | null>(null);
  const { state: progress } = useProgress();
  // One-button daily training: review, then puzzles, then a lane lab set.
  const [session, setSession] = useState<SessionStep | null>(null);
  function goStep(step: SessionStep) {
    setSession(step);
    if (step === "review") {
      const next = games?.find((g) => momentCount(g) > 0 && !progress.reviewedGames.includes(g.metrics.matchId)) ?? games?.[0];
      if (next) openReview(next.metrics.matchId, true);
      else setTab("review");
    } else setTab(step);
  }
  function startSession() {
    goStep(firstOpenStep(progress) ?? "review");
  }

  // After a ranked game the app syncs it on its own and asks to open its review.
  useEffect(() => {
    coach().postGameStatus().then((r) => r.ok && r.value && r.value.stage !== "idle" && setPostGame(r.value));
    const offStatus = coach().onPostGameStatus(setPostGame);
    const offOpen = coach().onPostGameOpen(async (matchId) => {
      setGames(await coach().listGames());
      openReview(matchId, true);
      toast.success("Your review is ready", { description: "Starting with the moments that cost you the most." });
    });
    return () => {
      offStatus();
      offOpen();
    };
  }, []);

  useEffect(() => {
    Promise.all([coach().getSettings(), coach().listGames()]).then(([s, g]) => {
      setSettings(s);
      setGames(g);
      if (!s.apiKey || !s.riotId) setTab("settings");
    });
    return coach().onProgress(setSync);
  }, []);

  async function runSync() {
    setSync({ done: 0, total: 1, label: "Starting" });
    const res = await coach().sync();
    setSync(null);
    if (!res.ok) {
      toast.error("Sync failed", { description: res.error });
      return;
    }
    const fresh = res.reports.filter((r) => !(games ?? []).some((g) => g.metrics.matchId === r.metrics.matchId));
    setGames(res.reports);
    toast.success(fresh.length ? `${fresh.length} new game${fresh.length > 1 ? "s" : ""} analyzed` : "You're up to date", {
      description: fresh.length ? "Your coaching plan is updated." : undefined,
    });
  }

  function openReview(matchId: string, autoplay = false, kind?: string) {
    setReviewTarget({ matchId, autoplay, kind });
    setTab("review");
  }

  const loading = settings === null || games === null;
  const syncPct = sync ? sync.done / Math.max(sync.total, 1) : 0;

  return (
    <div className="shell">
      {sync && <div className="top-progress" style={{ transform: `scaleX(${Math.max(0.04, syncPct)})` }} />}
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark" />
          <strong>League Coach</strong>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={`nav ${tab === n.id ? "active" : ""}`} onClick={() => setTab(n.id)}>
              <n.icon size={18} strokeWidth={1.8} aria-hidden />
              {n.label}
              {n.id === "review" && games && <UnreviewedBadge games={games} reviewed={progress.reviewedGames} />}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          {postGame && postGame.stage !== "idle" && (
            <PostGamePill
              status={postGame}
              onOpen={() => (postGame.matchId ? openReview(postGame.matchId, true) : undefined)}
              onDismiss={() => setPostGame(null)}
            />
          )}
          {loading ? <Skeleton h={92} r={12} /> : <PlayerCard name={settings.riotId} />}
          <button className="sync" disabled={!!sync || !settings?.apiKey} onClick={runSync}>
            <span className="sync-fill" style={{ transform: `scaleX(${sync ? syncPct : 0})` }} />
            <RefreshCw size={15} className={`sync-icon ${sync ? "spinning" : ""}`} aria-hidden />
            <span className="sync-label">{sync ? sync.label : "Sync games"}</span>
            {sync && <span className="sync-pct">{Math.round(syncPct * 100)}%</span>}
          </button>
        </div>
      </aside>

      <main className="main" key={tab}>
        {session && games && <SessionBar progress={progress} current={session} games={games} onGo={goStep} onEnd={() => setSession(null)} />}
        {loading ? (
          <LoadingPage />
        ) : tab === "coach" ? (
          <CoachView games={games} onReview={openReview} onPuzzles={() => setTab("puzzles")} onMechanics={() => setTab("mechanics")} onStartSession={startSession} onSync={runSync} syncing={!!sync} canSync={!!settings.apiKey} />
        ) : tab === "review" ? (
          <ReviewView games={games} target={reviewTarget} settings={settings} onTargetConsumed={() => setReviewTarget(null)} onPuzzles={() => setTab("puzzles")} onGameUpdated={(r) => setGames((gs) => gs && gs.map((g) => (g.metrics.matchId === r.metrics.matchId ? r : g)))} />
        ) : tab === "puzzles" ? (
          <PuzzlesView games={games} />
        ) : tab === "mechanics" ? (
          <MechanicsView games={games} />
        ) : tab === "champions" ? (
          <ChampionsView games={games} />
        ) : tab === "role" ? (
          <RoleView games={games} />
        ) : (
          <SettingsView
            value={settings}
            onSave={async (s) => {
              await coach().setSettings(s);
              setSettings(s);
              toast.success("Settings saved");
              if (!games.length && s.apiKey) setTab("coach");
            }}
          />
        )}
      </main>
    </div>
  );
}

function PostGamePill({ status, onOpen, onDismiss }: { status: PostGameStatus; onOpen: () => void; onDismiss: () => void }) {
  const ready = status.stage === "ready";
  const failed = status.stage === "failed";
  const Icon = ready ? PlayCircle : failed ? CircleAlert : LoaderCircle;
  return (
    <button
      className={`postgame-pill ${status.stage}`}
      onClick={ready ? onOpen : failed ? onDismiss : undefined}
      title={ready ? "Open the review" : failed ? "Dismiss" : undefined}
    >
      <Icon size={15} className={!ready && !failed ? "spinning" : undefined} aria-hidden />
      <span>{status.label}</span>
    </button>
  );
}

function UnreviewedBadge({ games, reviewed }: { games: GameReport[]; reviewed: string[] }) {
  const n = games.slice(0, 10).filter((g) => momentCount(g) > 0 && !reviewed.includes(g.metrics.matchId)).length;
  return n ? <span className="badge">{n}</span> : null;
}

function LoadingPage() {
  return (
    <div className="page">
      <Skeleton w={180} h={28} />
      <Skeleton h={220} r={16} />
      <div className="grid-3">
        <Skeleton h={110} r={14} />
        <Skeleton h={110} r={14} />
        <Skeleton h={110} r={14} />
      </div>
      <Skeleton h={260} r={16} />
    </div>
  );
}

