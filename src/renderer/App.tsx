import { useEffect, useMemo, useState } from "react";
import type { GameReport } from "../core/types";
import { coach, Settings } from "./api";
import { ChampionsView } from "./views/Champions";
import { GamesView } from "./views/Games";
import { OverviewView } from "./views/Overview";
import { PuzzlesView } from "./views/Puzzles";
import { RoleView } from "./views/Role";
import { SettingsView } from "./views/Settings";

type Tab = "overview" | "games" | "puzzles" | "champions" | "role" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview", label: "Coach", icon: "◎" },
  { id: "games", label: "Game reviews", icon: "▤" },
  { id: "puzzles", label: "Puzzles", icon: "◆" },
  { id: "champions", label: "Champions", icon: "♜" },
  { id: "role", label: "Best role", icon: "⇅" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [games, setGames] = useState<GameReport[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    coach().getSettings().then((s) => {
      setSettings(s);
      if (!s.apiKey || !s.riotId) setTab("settings");
    });
    coach().listGames().then(setGames);
    return coach().onProgress((p) => setProgress(p.total > 1 ? `${p.label}` : p.label));
  }, []);

  async function sync() {
    setSyncing(true);
    setError("");
    const res = await coach().sync();
    setSyncing(false);
    setProgress("");
    if (!res.ok) return setError(res.error);
    setGames(res.reports);
  }

  async function saveSettings(s: Settings) {
    await coach().setSettings(s);
    setSettings(s);
  }

  function openGame(id: string) {
    setSelected(id);
    setTab("games");
  }

  const latest = useMemo(() => games[0]?.metrics, [games]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">LC</span>
          <div>
            <strong>League Coach</strong>
            <small>{settings?.riotId || "Not set up"}</small>
          </div>
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="primary wide" disabled={syncing || !settings?.apiKey} onClick={sync}>
            {syncing ? "Syncing…" : "Sync games"}
          </button>
          <small className="muted">
            {syncing ? progress : games.length ? `${games.length} games · last ${latest ? new Date(latest.gameCreation).toLocaleDateString() : ""}` : "No games yet"}
          </small>
        </div>
      </aside>

      <section className="content">
        {error && (
          <div className="banner error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {tab === "overview" && settings && (
          <OverviewView
            games={games}
            onOpenGame={openGame}
            onSync={sync}
            canSync={!!settings.apiKey && !syncing}
          />
        )}
        {tab === "games" && <GamesView games={games} selected={selected} onSelect={setSelected} />}
        {tab === "puzzles" && <PuzzlesView games={games} />}
        {tab === "champions" && <ChampionsView games={games} />}
        {tab === "role" && <RoleView games={games} />}
        {tab === "settings" && settings && (
          <SettingsView
            value={settings}
            onSave={async (s) => {
              await saveSettings(s);
              setTab("overview");
            }}
          />
        )}
      </section>
    </div>
  );
}
