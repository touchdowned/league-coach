import { useEffect, useState } from "react";
import { toast, Toaster } from "sonner";
import type { GameReport } from "../core/types";
import { coach, Settings, TaskProgress } from "./api";
import { PlayerCard, ProgressProvider, useProgress } from "./progress";
import { Button, Skeleton } from "./ui";
import { ChampionsView } from "./views/Champions";
import { CoachView } from "./views/Coach";
import { PuzzlesView } from "./views/Puzzles";
import { ReviewView } from "./views/Review";
import { RoleView } from "./views/Role";
import { SettingsView } from "./views/Settings";

export type Tab = "coach" | "review" | "puzzles" | "champions" | "role" | "settings";

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "coach", label: "Coach", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "review", label: "Review", icon: "M5 4l14 8-14 8z" },
  { id: "puzzles", label: "Puzzles", icon: "M12 3l9 9-9 9-9-9z" },
  { id: "champions", label: "Champions", icon: "M4 20l4-12 4 6 4-10 4 16" },
  { id: "role", label: "Best role", icon: "M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3" },
  { id: "settings", label: "Settings", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zM4 12h2m12 0h2M12 4v2m0 12v2" },
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
  const [reviewTarget, setReviewTarget] = useState<{ matchId: string; autoplay: boolean } | null>(null);
  const [sync, setSync] = useState<TaskProgress | null>(null);
  const { state: progress } = useProgress();

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

  function openReview(matchId: string, autoplay = false) {
    setReviewTarget({ matchId, autoplay });
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
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d={n.icon} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {n.label}
              {n.id === "review" && games && <UnreviewedBadge games={games} reviewed={progress.reviewedGames} />}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          {loading ? <Skeleton h={92} r={12} /> : <PlayerCard name={settings.riotId} />}
          <button className="sync" disabled={!!sync || !settings?.apiKey} onClick={runSync}>
            <span className="sync-fill" style={{ transform: `scaleX(${sync ? syncPct : 0})` }} />
            <span className="sync-label">{sync ? sync.label : "Sync games"}</span>
            {sync && <span className="sync-pct">{Math.round(syncPct * 100)}%</span>}
          </button>
        </div>
      </aside>

      <main className="main" key={tab}>
        {loading ? (
          <LoadingPage />
        ) : tab === "coach" ? (
          <CoachView games={games} onReview={openReview} onPuzzles={() => setTab("puzzles")} onSync={runSync} syncing={!!sync} canSync={!!settings.apiKey} />
        ) : tab === "review" ? (
          <ReviewView games={games} target={reviewTarget} settings={settings} onTargetConsumed={() => setReviewTarget(null)} onPuzzles={() => setTab("puzzles")} />
        ) : tab === "puzzles" ? (
          <PuzzlesView games={games} />
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

function UnreviewedBadge({ games, reviewed }: { games: GameReport[]; reviewed: string[] }) {
  const n = games.slice(0, 10).filter((g) => g.mistakes.length > 0 && !reviewed.includes(g.metrics.matchId)).length;
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

