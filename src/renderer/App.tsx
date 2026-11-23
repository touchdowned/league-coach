import { useEffect, useState } from "react";
import { fmtTime } from "../core/analysis";
import { benchmarkFor, ROLE_LABEL } from "../core/benchmarks";
import { REGIONS } from "../core/riot";
import type { RoleVerdict } from "../core/roles";
import type { GameReport } from "../core/types";
import { coach, Settings } from "./api";

type Tab = "games" | "role" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("games");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [games, setGames] = useState<GameReport[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [role, setRole] = useState<RoleVerdict | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    coach().getSettings().then((s) => {
      setSettings(s);
      if (!s.apiKey || !s.riotId) setTab("settings");
    });
    coach().listGames().then(setGames);
    return coach().onProgress((p) => setProgress(p.label));
  }, []);

  async function sync() {
    setSyncing(true);
    setError("");
    const res = await coach().sync();
    setSyncing(false);
    setProgress("");
    if (!res.ok) return setError(res.error);
    setGames(res.reports);
    setRole(await coach().getRole());
    if (res.reports.length && !selected) setSelected(res.reports[0].metrics.matchId);
  }

  useEffect(() => {
    if (tab === "role") coach().getRole().then(setRole);
  }, [tab, games]);

  const current = games.find((g) => g.metrics.matchId === selected) ?? null;

  return (
    <div className="app">
      <header>
        <h1>League Coach</h1>
        <nav>
          {(["games", "role", "settings"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "games" ? "Games" : t === "role" ? "Best role" : "Settings"}
            </button>
          ))}
        </nav>
        <button className="primary" disabled={syncing || !settings?.apiKey} onClick={sync}>
          {syncing ? progress || "Syncing…" : "Sync games"}
        </button>
      </header>
      {error && <div className="error">{error}</div>}

      {tab === "settings" && settings && (
        <SettingsView
          value={settings}
          onSave={async (s) => {
            await coach().setSettings(s);
            setSettings(s);
            setTab("games");
          }}
        />
      )}

      {tab === "games" && (
        <div className="games">
          <aside>
            {games.length === 0 && <p className="muted">No games yet. Press "Sync games".</p>}
            {games.map((g) => (
              <GameRow key={g.metrics.matchId} g={g} active={g.metrics.matchId === selected} onClick={() => setSelected(g.metrics.matchId)} />
            ))}
          </aside>
          <main>{current ? <ReportView r={current} /> : <p className="muted">Pick a game to see its review.</p>}</main>
        </div>
      )}

      {tab === "role" && <RoleView v={role} />}
    </div>
  );
}

function GameRow({ g, active, onClick }: { g: GameReport; active: boolean; onClick: () => void }) {
  const m = g.metrics;
  return (
    <button className={`game-row ${active ? "active" : ""} ${m.win ? "win" : "loss"}`} onClick={onClick}>
      <span className={`grade g-${g.grade}`}>{g.grade}</span>
      <span className="champ">
        <strong>{m.champion}</strong>
        <small>
          {ROLE_LABEL[m.role]} · {m.kills}/{m.deaths}/{m.assists}
        </small>
      </span>
      <small className="when">{new Date(m.gameCreation).toLocaleDateString()}</small>
    </button>
  );
}

function Stat({ label, value, bench, good }: { label: string; value: string; bench?: string; good?: boolean | null }) {
  return (
    <div className={`stat ${good === true ? "good" : good === false ? "bad" : ""}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {bench && <small className="muted">typical {bench}</small>}
    </div>
  );
}

function groupByTime(mistakes: GameReport["mistakes"]) {
  const groups = new Map<number, { timeMs: number; labels: number[]; titles: string[] }>();
  mistakes.forEach((x, i) => {
    const g = groups.get(x.timeMs) ?? { timeMs: x.timeMs, labels: [], titles: [] };
    g.labels.push(i + 1);
    g.titles.push(x.title);
    groups.set(x.timeMs, g);
  });
  return [...groups.values()];
}

const signed = (n: number | null) => (n === null ? "–" : `${n >= 0 ? "+" : ""}${n}`);

function ReportView({ r }: { r: GameReport }) {
  const m = r.metrics;
  const b = benchmarkFor(m.role);
  const total = m.durationMin * 60_000;
  return (
    <div className="report">
      <div className="report-head">
        <span className={`grade big g-${r.grade}`}>{r.grade}</span>
        <div>
          <h2>
            {m.champion} {m.opponentChampion ? `vs ${m.opponentChampion}` : ""} · {m.win ? "Victory" : "Defeat"}
          </h2>
          <p className="muted">
            {ROLE_LABEL[m.role]} · {Math.round(m.durationMin)} min · {new Date(m.gameCreation).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="focus">
        <small>Focus for next game</small>
        <p>{r.focus}</p>
      </div>

      <div className="stats">
        <Stat label="CS at 10" value={String(m.cs10)} bench={String(b.cs10)} good={m.cs10 >= b.cs10} />
        <Stat label="Gold diff at 15" value={signed(m.goldDiff15)} good={m.goldDiff15 === null ? null : m.goldDiff15 >= 0} />
        <Stat label="XP diff at 15" value={signed(m.xpDiff15)} good={m.xpDiff15 === null ? null : m.xpDiff15 >= 0} />
        <Stat label="Deaths before 14" value={String(m.deathsPre14)} bench={b.deathsPre14.toFixed(1)} good={m.deathsPre14 <= b.deathsPre14} />
        <Stat label="Kill participation" value={`${Math.round(m.killParticipation * 100)}%`} bench={`${Math.round(b.killParticipation * 100)}%`} good={m.killParticipation >= b.killParticipation} />
        <Stat label="Vision / min" value={m.visionPerMin.toFixed(2)} bench={b.visionPerMin.toFixed(2)} good={m.visionPerMin >= b.visionPerMin} />
        <Stat label="CS / min" value={m.csPerMin.toFixed(1)} bench={b.csPerMin.toFixed(1)} good={m.csPerMin >= b.csPerMin} />
        <Stat label="Damage share" value={`${Math.round(m.damageShare * 100)}%`} />
      </div>

      <h3>Mistake timeline</h3>
      <div className="timeline">
        <div className="lane-phase" style={{ width: `${Math.min((14 * 60_000) / total, 1) * 100}%` }}>
          laning
        </div>
        {groupByTime(r.mistakes).map((grp) => (
          <span key={grp.timeMs} className="marker" style={{ left: `${(grp.timeMs / total) * 100}%` }} title={grp.titles.join("\n")}>
            {grp.labels.join(",")}
          </span>
        ))}
      </div>

      {r.mistakes.length === 0 ? (
        <p className="muted">No big mistakes found from the match data. Nice game.</p>
      ) : (
        <ol className="mistakes">
          {r.mistakes.map((x, i) => (
            <li key={i}>
              <div className="m-head">
                <span className="marker static">{i + 1}</span>
                <strong>{x.title}</strong>
                <span className="time">{fmtTime(x.timeMs)}</span>
              </div>
              <p>{x.detail}</p>
              <p className="tip">{x.tip}</p>
            </li>
          ))}
        </ol>
      )}

      {r.strengths.length > 0 && (
        <>
          <h3>What went well</h3>
          <ul className="strengths">
            {r.strengths.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RoleView({ v }: { v: RoleVerdict | null }) {
  if (!v || v.roles.length === 0) return <p className="muted pad">Sync your games to compare roles.</p>;
  return (
    <div className="role">
      <div className="focus">
        <small>Your best role</small>
        <p>{v.summary}</p>
      </div>
      <ul className="reasons">
        {v.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="role-cards">
        {v.roles.map((r) => (
          <div key={r.role} className={`role-card ${r.role === v.best ? "best" : ""}`}>
            <h3>{r.label}</h3>
            <p className="muted">
              {r.games} games · {r.confidence} confidence
            </p>
            <div className="stats small">
              <Stat label="Win rate" value={`${Math.round(r.winRate * 100)}%`} />
              <Stat label="Gold diff 15" value={signed(Math.round(r.avgGoldDiff15))} />
              <Stat label="CS at 10" value={r.avgCs10.toFixed(0)} />
              <Stat label="Deaths pre-14" value={r.avgDeathsPre14.toFixed(1)} />
            </div>
            <small className="muted">Champions</small>
            <ul className="champs">
              {r.champions.slice(0, 5).map((c) => (
                <li key={c.name}>
                  {c.name} <span className="muted">{c.games}g · {Math.round(c.winRate * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ value, onSave }: { value: Settings; onSave: (s: Settings) => void }) {
  const [s, setS] = useState(value);
  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(s);
      }}
    >
      <label>
        Riot ID
        <input value={s.riotId} placeholder="Name#TAG" onChange={(e) => setS({ ...s, riotId: e.target.value })} />
      </label>
      <label>
        Region
        <select value={s.region} onChange={(e) => setS({ ...s, region: e.target.value })}>
          {Object.keys(REGIONS).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <label>
        Riot API key
        <input type="password" value={s.apiKey} placeholder="RGAPI-…" onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
        <small className="muted">
          Get a free key at developer.riotgames.com. Development keys expire every 24 hours. It's saved only on this PC.
        </small>
      </label>
      <label>
        Games to load
        <input type="number" min={5} max={100} value={s.matchCount} onChange={(e) => setS({ ...s, matchCount: Number(e.target.value) })} />
      </label>
      <button className="primary" type="submit">
        Save
      </button>
    </form>
  );
}
