import { useMemo, useState } from "react";
import { ROLE_LABEL } from "../../core/benchmarks";
import { coachPlan, CoachPlan } from "../../core/coach";
import { buildProfile, SKILLS, trend } from "../../core/profile";
import type { GameReport, Position } from "../../core/types";
import { ChampIcon, LineChart, Meter, Radar, ResultDots } from "../charts";

const TREND_METRICS = [
  { key: "gd15", label: "Gold lead at 15", pick: (m: GameReport["metrics"]) => m.goldDiff15, fmt: (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}`, zero: true },
  { key: "deaths", label: "Deaths before 14", pick: (m: GameReport["metrics"]) => m.deathsPre14, fmt: (n: number) => n.toFixed(1), zero: false },
  { key: "cs10", label: "CS at 10", pick: (m: GameReport["metrics"]) => m.cs10, fmt: (n: number) => String(Math.round(n)), zero: false },
  { key: "kp", label: "Kill participation", pick: (m: GameReport["metrics"]) => m.killParticipation * 100, fmt: (n: number) => `${Math.round(n)}%`, zero: false },
] as const;

export function OverviewView({
  games,
  onOpenGame,
  onSync,
  canSync,
}: {
  games: GameReport[];
  onOpenGame: (id: string) => void;
  onSync: () => void;
  canSync: boolean;
}) {
  const [role, setRole] = useState<Position | "ALL">("ALL");
  const [metric, setMetric] = useState<(typeof TREND_METRICS)[number]["key"]>("gd15");
  const filtered = useMemo(() => (role === "ALL" ? games : games.filter((g) => g.metrics.role === role)), [games, role]);
  const profile = useMemo(() => buildProfile(games, role), [games, role]);

  if (games.length === 0) {
    return (
      <div className="empty-state">
        <h2>Welcome to League Coach</h2>
        <p className="muted">Sync your recent games to build your player profile, focus goals and game reviews.</p>
        <button className="primary" disabled={!canSync} onClick={onSync}>
          Sync games
        </button>
      </div>
    );
  }

  const roles = [...new Set(games.map((g) => g.metrics.role))].filter(Boolean) as Position[];
  const wins = filtered.slice(0, 20).filter((g) => g.metrics.win).length;
  const recent20 = Math.min(filtered.length, 20);
  const plan = coachPlan(filtered);
  const tm = TREND_METRICS.find((t) => t.key === metric)!;
  const tr = trend(filtered.slice(0, 30), tm.pick);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coach</h1>
          <p className="muted">Your last {recent20} games{role !== "ALL" ? ` as ${ROLE_LABEL[role]}` : ""}</p>
        </div>
        <div className="segmented">
          {(["ALL", ...roles] as (Position | "ALL")[]).map((r) => (
            <button key={r} className={role === r ? "active" : ""} onClick={() => setRole(r)}>
              {r === "ALL" ? "All roles" : ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>

      <NextStep plan={plan} />

      <div className="kpis">
        <div className="kpi">
          <small>Win rate</small>
          <strong>{Math.round((wins / Math.max(recent20, 1)) * 100)}%</strong>
          <span className="muted">
            {wins}W {recent20 - wins}L
          </span>
        </div>
        <div className="kpi">
          <small>Coach score</small>
          <strong>{profile?.overall ?? "–"}</strong>
          <span className="muted">50 is typical Silver/Gold</span>
        </div>
        <div className="kpi">
          <small>Best skill</small>
          <strong>{profile ? SKILLS.find((s) => s.key === profile.strongest)!.label : "–"}</strong>
          <span className="muted">{profile ? `${profile.skills[profile.strongest]} / 100` : ""}</span>
        </div>
        <div className="kpi warn">
          <small>Lowest skill</small>
          <strong>{profile ? SKILLS.find((s) => s.key === profile.weakest)!.label : "–"}</strong>
          <span className="muted">{profile ? `${profile.skills[profile.weakest]} / 100` : ""}</span>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Skill profile</h3>
            <span className="muted small">{profile?.previous ? "Dashed: the 20 games before" : "Ring = typical Silver/Gold"}</span>
          </div>
          {profile && (
            <div className="profile">
              <Radar
                axes={SKILLS.map((s) => s.label)}
                values={SKILLS.map((s) => profile.skills[s.key])}
                compare={profile.previous ? SKILLS.map((s) => profile.previous![s.key]) : undefined}
              />
              <div className="meters">
                {SKILLS.map((s) => (
                  <div key={s.key} title={s.blurb}>
                    <Meter
                      label={s.label}
                      value={profile.skills[s.key]}
                      delta={profile.previous ? profile.skills[s.key] - profile.previous[s.key] : null}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <PlanSummary plan={plan} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Trend</h3>
          <div className="segmented small">
            {TREND_METRICS.map((t) => (
              <button key={t.key} className={metric === t.key ? "active" : ""} onClick={() => setMetric(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <LineChart
          points={tr.map((p) => ({ x: p.i + 1, y: p.value }))}
          zeroLine={tm.zero}
          format={tm.fmt}
          xLabel={(x) => `game ${x}`}
          height={170}
        />
        <p className="muted small">5-game rolling average, oldest on the left.</p>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Recent games</h3>
        </div>
        <div className="recent">
          {filtered.slice(0, 10).map((g) => (
            <button key={g.metrics.matchId} className={`recent-game ${g.metrics.win ? "win" : "loss"}`} onClick={() => onOpenGame(g.metrics.matchId)}>
              <ChampIcon name={g.metrics.champion} size={40} />
              <span className={`grade g-${g.grade}`}>{g.grade}</span>
              <small>
                {g.metrics.kills}/{g.metrics.deaths}/{g.metrics.assists}
              </small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function NextStep({ plan }: { plan: CoachPlan }) {
  const c = plan.current;
  if (!c) {
    return (
      <div className="next-step done">
        <small>Coach</small>
        <h2>{plan.verdict}</h2>
      </div>
    );
  }
  return (
    <div className="next-step">
      <div className="next-step-main">
        <small>Your next step</small>
        <h2>{c.title}</h2>
        <p className="evidence">{c.evidence}</p>
        <p className="muted">{c.why}</p>
        <ol className="rules">
          {c.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ol>
      </div>
      <div className="next-step-side">
        <small>Pass condition each game</small>
        <strong>{c.passRule}</strong>
        <ResultDots results={c.results} />
        <span className="muted small">
          Last 10 games. Pass 4 of your next 5 and the coach moves you on.
        </span>
        <p className="verdict">{plan.verdict}</p>
      </div>
    </div>
  );
}

function PlanSummary({ plan }: { plan: CoachPlan }) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Coaching plan</h3>
        <span className="muted small">from your last {plan.gamesConsidered} games</span>
      </div>
      <ol className="plan">
        {plan.current && (
          <li className="now">
            <span className="pill bad">Now</span>
            <div>
              <strong>{plan.current.title}</strong>
              <p className="muted small">{plan.current.evidence}</p>
            </div>
          </li>
        )}
        {plan.upNext.map((i) => (
          <li key={i.id}>
            <span className="pill ok">Next</span>
            <div>
              <strong>{i.title}</strong>
              <p className="muted small">{i.evidence}</p>
            </div>
          </li>
        ))}
        {plan.fixed.slice(0, 3).map((i) => (
          <li key={i.id} className="fixed">
            <span className="pill good">OK</span>
            <div>
              <strong>{i.title}</strong>
              <p className="muted small">{i.evidence}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
