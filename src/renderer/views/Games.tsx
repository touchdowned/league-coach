import { useState } from "react";
import { fmtTime } from "../../core/analysis";
import { benchmarkFor, ROLE_LABEL } from "../../core/benchmarks";
import { SKILLS, skillScores } from "../../core/profile";
import type { GameReport } from "../../core/types";
import { ChampIcon, DeathMap, LineChart, Meter } from "../charts";

export function GamesView({ games, selected, onSelect }: { games: GameReport[]; selected: string | null; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "win" | "loss">("all");
  const list = games.filter((g) => filter === "all" || (filter === "win") === g.metrics.win);
  const current = games.find((g) => g.metrics.matchId === selected) ?? games[0] ?? null;

  return (
    <div className="split">
      <div className="list-pane">
        <div className="segmented small full">
          {(["all", "win", "loss"] as const).map((f) => (
            <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "win" ? "Wins" : "Losses"}
            </button>
          ))}
        </div>
        {list.length === 0 && <p className="muted pad">No games yet. Press "Sync games".</p>}
        {list.map((g) => {
          const m = g.metrics;
          return (
            <button
              key={m.matchId}
              className={`game-row ${m.win ? "win" : "loss"} ${current?.metrics.matchId === m.matchId ? "active" : ""}`}
              onClick={() => onSelect(m.matchId)}
            >
              <ChampIcon name={m.champion} size={38} />
              <span className="game-row-main">
                <strong>{m.champion}</strong>
                <small>
                  {ROLE_LABEL[m.role]} · {m.kills}/{m.deaths}/{m.assists} · {m.cs10} CS@10
                </small>
              </span>
              <span className="game-row-side">
                <span className={`grade g-${g.grade}`}>{g.grade}</span>
                <small>{new Date(m.gameCreation).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="detail-pane">{current ? <Report r={current} /> : <p className="muted pad">Pick a game to see its review.</p>}</div>
    </div>
  );
}

const signed = (n: number | null) => (n === null ? "–" : `${n >= 0 ? "+" : ""}${n}`);

function Compare({ label, you, typical, better }: { label: string; you: string; typical: string; better: boolean | null }) {
  return (
    <div className={`compare ${better === true ? "good" : better === false ? "bad" : ""}`}>
      <small>{label}</small>
      <strong>{you}</strong>
      <span className="muted">typical {typical}</span>
    </div>
  );
}

function Report({ r }: { r: GameReport }) {
  const m = r.metrics;
  const b = benchmarkFor(m.role);
  const scores = skillScores(m);
  const markers = r.mistakes
    .map((x, i) => ({ x: Math.round(x.timeMs / 60000), label: String(i + 1) }))
    .filter((mk, i, arr) => arr.findIndex((o) => o.x === mk.x) === i);

  return (
    <div className="page">
      <div className="report-hero">
        <ChampIcon name={m.champion} size={64} />
        <div className="hero-main">
          <div className="hero-title">
            <h1>{m.champion}</h1>
            {m.opponentChampion && (
              <>
                <span className="vs">vs</span>
                <ChampIcon name={m.opponentChampion} size={32} />
                <span>{m.opponentChampion}</span>
              </>
            )}
          </div>
          <p className="muted">
            <span className={m.win ? "win-text" : "loss-text"}>{m.win ? "Victory" : "Defeat"}</span> · {ROLE_LABEL[m.role]} · {Math.round(m.durationMin)} min ·{" "}
            {new Date(m.gameCreation).toLocaleString()} · {m.kills}/{m.deaths}/{m.assists}
          </p>
        </div>
        <div className={`grade big g-${r.grade}`}>{r.grade}</div>
      </div>

      <div className="focus-card">
        <small>Focus for next game</small>
        <p>{r.focus}</p>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Gold lead vs {m.opponentChampion ?? "lane opponent"}</h3>
            <span className="muted small">numbered = mistakes</span>
          </div>
          <LineChart
            points={r.series.filter((p) => p.goldDiff !== null).map((p) => ({ x: p.minute, y: p.goldDiff! }))}
            format={(n) => `${n >= 0 ? "+" : ""}${Math.round(n)}`}
            xLabel={(x) => `${x}m`}
            markers={markers}
          />
        </div>
        <div className="card map-card">
          <div className="card-head">
            <h3>Where you died</h3>
            <span className="muted small">✕ death · ● kill</span>
          </div>
          <DeathMap deaths={r.deathsAt} kills={r.killsAt} size={260} />
        </div>
      </div>

      <div className="compares">
        <Compare label="CS at 10" you={String(m.cs10)} typical={String(b.cs10)} better={m.cs10 >= b.cs10} />
        <Compare label="Gold diff at 15" you={signed(m.goldDiff15)} typical="±0" better={m.goldDiff15 === null ? null : m.goldDiff15 >= 0} />
        <Compare label="Deaths before 14" you={String(m.deathsPre14)} typical={b.deathsPre14.toFixed(1)} better={m.deathsPre14 <= b.deathsPre14} />
        <Compare label="Kill participation" you={`${Math.round(m.killParticipation * 100)}%`} typical={`${Math.round(b.killParticipation * 100)}%`} better={m.killParticipation >= b.killParticipation} />
        <Compare label="Vision / min" you={m.visionPerMin.toFixed(2)} typical={b.visionPerMin.toFixed(2)} better={m.visionPerMin >= b.visionPerMin} />
        <Compare label="Damage share" you={`${Math.round(m.damageShare * 100)}%`} typical="20%" better={m.damageShare >= 0.2} />
      </div>

      <div className="grid-2 wide-left">
        <div className="card">
          <div className="card-head">
            <h3>Key moments</h3>
            <span className="muted small">{r.mistakes.length} found</span>
          </div>
          {r.mistakes.length === 0 ? (
            <p className="muted">No deaths that the match data can flag. Check your CS and gold lead above: that is where this game was won or lost.</p>
          ) : (
            <ol className="moments">
              {r.mistakes.map((x, i) => (
                <li key={i} className={`sev-${x.severity >= 8 ? "high" : x.severity >= 6 ? "mid" : "low"}`}>
                  <span className="moment-num">{i + 1}</span>
                  <div>
                    <div className="moment-head">
                      <strong>{x.title}</strong>
                      <span className="time">{fmtTime(x.timeMs)}</span>
                    </div>
                    <p>{x.detail}</p>
                    {x.read && (
                      <div className="read">
                        <small>What you were probably thinking</small>
                        <p>{x.read}</p>
                      </div>
                    )}
                    <div className="correction">
                      <small>Why that's wrong</small>
                      <p>{x.tip}</p>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h3>This game's skills</h3>
          </div>
          <div className="meters">
            {SKILLS.map((s) => (
              <Meter key={s.key} label={s.label} value={scores[s.key]} />
            ))}
          </div>
          {r.strengths.length > 0 && (
            <>
              <h4>Above your rank's average</h4>
              <ul className="checks">
                {r.strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
