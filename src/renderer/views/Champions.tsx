import { useMemo, useState } from "react";
import { ROLE_LABEL } from "../../core/benchmarks";
import { championStats, ChampionStats } from "../../core/champions";
import type { GameReport } from "../../core/types";
import { ChampIcon } from "../charts";
import { champName } from "../../core/names";

const VERDICT: Record<ChampionStats["verdict"], { label: string; tip: string }> = {
  core: { label: "Core pick", tip: "You win on this and play it well. Spam it in ranked." },
  keep: { label: "Keep", tip: "Solid. Worth keeping in your pool." },
  practice: { label: "Needs work", tip: "Your numbers are below average on this champion. Practice in normals first." },
  drop: { label: "Consider dropping", tip: "Low win rate and low scores over enough games. A smaller pool climbs faster." },
  new: { label: "Few games", tip: "Not enough games to judge yet." },
};

export function ChampionsView({ games }: { games: GameReport[] }) {
  const stats = useMemo(() => championStats(games), [games]);
  const [open, setOpen] = useState<string | null>(null);
  const sel = stats.find((s) => s.champion === open) ?? stats[0];

  if (stats.length === 0) return <p className="muted pad">Sync your games to see your champion pool.</p>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Champions</p>
          <h1>Your champion pool</h1>
          <p className="muted">
            {stats.length} champions over {games.length} games. Most climbers stick to 2 or 3 per role.
          </p>
        </div>
      </div>
      <div className="grid-2 wide-left champ-grid">
        <div className="panel flush">
          <table className="table">
            <thead>
              <tr>
                <th>Champion</th>
                <th>Games</th>
                <th>Win rate</th>
                <th>KDA</th>
                <th>CS@10</th>
                <th>Gold @15</th>
                <th>Score</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.champion} className={sel?.champion === s.champion ? "active" : ""} onClick={() => setOpen(s.champion)}>
                  <td>
                    <span className="cell-champ">
                      <ChampIcon name={s.champion} size={28} />
                      <span>
                        {champName(s.champion)}
                        <small className="muted"> {s.roles.map((r) => ROLE_LABEL[r]).join(", ")}</small>
                      </span>
                    </span>
                  </td>
                  <td>{s.games}</td>
                  <td>
                    <span className="wr">
                      <span className="wr-bar">
                        <span style={{ width: `${s.winRate * 100}%` }} className={s.winRate >= 0.5 ? "good" : "bad"} />
                      </span>
                      {Math.round(s.winRate * 100)}%
                    </span>
                  </td>
                  <td>{s.kda.toFixed(1)}</td>
                  <td>{Math.round(s.avgCs10)}</td>
                  <td className={s.avgGoldDiff15 >= 0 ? "pos" : "neg"}>
                    {s.avgGoldDiff15 >= 0 ? "+" : ""}
                    {Math.round(s.avgGoldDiff15)}
                  </td>
                  <td>{s.score}</td>
                  <td>
                    <span className={`pill v-${s.verdict}`}>{VERDICT[s.verdict].label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sel && (
          <div className="panel">
            <div className="panel-head">
              <span className="cell-champ">
                <ChampIcon name={sel.champion} size={40} />
                <h3>{champName(sel.champion)}</h3>
              </span>
              <span className={`pill v-${sel.verdict}`}>{VERDICT[sel.verdict].label}</span>
            </div>
            <p className="muted">{VERDICT[sel.verdict].tip}</p>
            <h4>Matchups</h4>
            {sel.matchups.length === 0 ? (
              <p className="muted small">No lane opponents recorded.</p>
            ) : (
              <ul className="matchups">
                {sel.matchups.map((mu) => (
                  <li key={mu.opponent}>
                    <ChampIcon name={mu.opponent} size={26} />
                    <span className="mu-name">{champName(mu.opponent)}</span>
                    <span className="muted small">
                      {mu.wins}W {mu.games - mu.wins}L
                    </span>
                    <span className={mu.avgGoldDiff15 >= 0 ? "pos" : "neg"}>
                      {mu.avgGoldDiff15 >= 0 ? "+" : ""}
                      {Math.round(mu.avgGoldDiff15)}g @15
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
