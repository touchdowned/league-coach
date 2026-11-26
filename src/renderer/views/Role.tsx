import { useMemo } from "react";
import { buildProfile, SKILLS } from "../../core/profile";
import { recommendRole } from "../../core/roles";
import type { GameReport } from "../../core/types";
import { ChampIcon, Meter, Radar } from "../charts";

export function RoleView({ games }: { games: GameReport[] }) {
  const v = useMemo(() => recommendRole(games.map((g) => g.metrics)), [games]);
  if (v.roles.length === 0) return <p className="muted pad">Sync your games to compare roles.</p>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Best role</p>
          <h1>Where you climb best</h1>
          <p className="muted">Compared against typical Silver/Gold players in each role.</p>
        </div>
      </div>
      <div className="focus-card verdict">
        <small>Verdict</small>
        <p>{v.summary}</p>
      </div>
      {v.reasons.length > 0 && (
        <ul className="checks">
          {v.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="role-grid">
        {v.roles.map((r) => {
          const p = buildProfile(games, r.role, 50);
          return (
            <div key={r.role} className={`card role-card ${r.role === v.best ? "best" : ""}`}>
              <div className="panel-head">
                <h3>
                  {r.label} {r.role === v.best && <span className="pill good">Best</span>}
                </h3>
                <span className="muted small">
                  {r.games} games · {r.confidence} confidence
                </span>
              </div>
              <div className="role-kpis">
                <div>
                  <small>Win rate</small>
                  <strong>{Math.round(r.winRate * 100)}%</strong>
                </div>
                <div>
                  <small>Gold @15</small>
                  <strong className={r.avgGoldDiff15 >= 0 ? "pos" : "neg"}>
                    {r.avgGoldDiff15 >= 0 ? "+" : ""}
                    {Math.round(r.avgGoldDiff15)}
                  </strong>
                </div>
                <div>
                  <small>Deaths pre-14</small>
                  <strong>{r.avgDeathsPre14.toFixed(1)}</strong>
                </div>
              </div>
              {p && (
                <>
                  <Radar axes={SKILLS.map((s) => s.label)} values={SKILLS.map((s) => p.skills[s.key])} size={240} />
                  <Meter label="Coach score" value={p.overall} />
                </>
              )}
              <h4>Champions</h4>
              <div className="champ-chips">
                {r.champions.slice(0, 6).map((c) => (
                  <span key={c.name} className="champ-chip" title={`${c.games} games`}>
                    <ChampIcon name={c.name} size={24} />
                    {Math.round(c.winRate * 100)}%
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
