import { Brain, Clapperboard, Crosshair, Footprints, Gamepad2, ListChecks, Play, TrendingUp, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { ROLE_LABEL } from "../../core/benchmarks";
import { coachPlan, CoachPlan } from "../../core/coach";
import { LEAK_LABEL, leverTotals, momentCount } from "../../core/engine";
import { buildProfile, SKILLS, trend } from "../../core/profile";
import { DAILY, dayKey } from "../../core/progress";
import type { GameReport, Position } from "../../core/types";
import { ChampIcon, LineChart, Meter, Radar, ResultDots } from "../charts";
import { useProgress } from "../progress";
import { Button, Empty, Ring } from "../ui";

const TRENDS = [
  { key: "gd15", label: "Gold @15", pick: (m: GameReport["metrics"]) => m.goldDiff15, fmt: (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n)}`, zero: true },
  { key: "deaths", label: "Early deaths", pick: (m: GameReport["metrics"]) => m.deathsPre14, fmt: (n: number) => n.toFixed(1), zero: false },
  { key: "cs10", label: "CS @10", pick: (m: GameReport["metrics"]) => m.cs10, fmt: (n: number) => String(Math.round(n)), zero: false },
] as const;

export function CoachView({
  games,
  onReview,
  onPuzzles,
  onMechanics,
  onStartSession,
  onSync,
  syncing,
  canSync,
}: {
  games: GameReport[];
  onReview: (matchId: string, autoplay?: boolean, kind?: string) => void;
  onPuzzles: () => void;
  onMechanics?: () => void;
  onStartSession?: () => void;
  onSync: () => void;
  syncing: boolean;
  canSync: boolean;
}) {
  const [role, setRole] = useState<Position | "ALL">("ALL");
  const [metric, setMetric] = useState<(typeof TRENDS)[number]["key"]>("gd15");
  const { state: progress } = useProgress();
  const filtered = useMemo(() => (role === "ALL" ? games : games.filter((g) => g.metrics.role === role)), [games, role]);
  const plan = useMemo(() => coachPlan(filtered), [filtered]);
  const profile = useMemo(() => buildProfile(games, role), [games, role]);

  if (games.length === 0) {
    return (
      <div className="page">
        <Empty
          title="Let's look at your games"
          body="Sync pulls your recent ranked and draft games, finds what's costing you, and builds your plan. It takes about a minute."
          action={
            <Button variant="primary" size="lg" onClick={onSync} loading={syncing} disabled={!canSync}>
              {canSync ? "Sync games" : "Add your API key in Settings first"}
            </Button>
          }
        />
      </div>
    );
  }

  const roles = [...new Set(games.map((g) => g.metrics.role))].filter(Boolean) as Position[];
  const nextReview = games.find((g) => momentCount(g) > 0 && !progress.reviewedGames.includes(g.metrics.matchId));
  const today = progress.today.date === dayKey(new Date()) ? progress.today : { moments: 0, puzzles: 0, puzzlesRight: 0 };
  const t = TRENDS.find((x) => x.key === metric)!;
  const tr = trend(filtered.slice(0, 30), t.pick);
  const last10 = filtered.slice(0, 10);
  const wins = last10.filter((g) => g.metrics.win).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Coach</p>
          <h1>{plan.current ? "Here's what to fix next." : "No major leaks right now."}</h1>
        </div>
        {onStartSession && (
          <Button variant="primary" onClick={onStartSession}>
            <Play size={15} fill="currentColor" /> Start today's training
          </Button>
        )}
        <div className="seg">
          {(["ALL", ...roles] as (Position | "ALL")[]).map((r) => (
            <button key={r} className={role === r ? "on" : ""} onClick={() => setRole(r)}>
              {r === "ALL" ? "All" : ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      </header>

      {filtered.length >= 2 && !filtered[0].metrics.win && !filtered[1].metrics.win && Date.now() - filtered[0].metrics.gameCreation < 6 * 3600e3 && (
        <div className="hero quiet tilt">
          Two losses in a row. Take ten minutes off queue: review the last game or do a puzzle set before you play again.
        </div>
      )}

      <NextStep plan={plan} games={filtered} onReview={onReview} onPuzzles={onPuzzles} onMechanics={onMechanics} />

      <Levers games={filtered} onReview={onReview} />

      <section className="grid-3">
        <div className="tile action" onClick={() => nextReview && onReview(nextReview.metrics.matchId, true)} data-disabled={!nextReview || undefined}>
          <div className="tile-top">
            <p className="eyebrow icon-eyebrow"><Clapperboard size={13} /> Review</p>
            <Ring value={today.moments / DAILY.moments} size={34} stroke={3} tone={today.moments >= DAILY.moments ? "good" : "accent"}>
              <small>
                {Math.min(today.moments, DAILY.moments)}/{DAILY.moments}
              </small>
            </Ring>
          </div>
          {nextReview ? (
            <>
              <div className="tile-champ">
                <ChampIcon name={nextReview.metrics.champion} size={40} />
                <div>
                  <strong>
                    {nextReview.metrics.champion} {nextReview.metrics.opponentChampion ? `vs ${nextReview.metrics.opponentChampion}` : ""}
                  </strong>
                  <small>
                    {momentCount(nextReview)} moments · {nextReview.metrics.win ? "Win" : "Loss"}
                  </small>
                </div>
              </div>
              <span className="tile-cta"><Play size={13} fill="currentColor" /> Start guided review</span>
            </>
          ) : (
            <>
              <strong>All recent games reviewed</strong>
              <small className="muted">Play a game and sync to get new moments.</small>
            </>
          )}
        </div>

        <div className="tile action" onClick={onPuzzles}>
          <div className="tile-top">
            <p className="eyebrow icon-eyebrow"><Brain size={13} /> Puzzles</p>
            <Ring value={today.puzzles / DAILY.puzzles} size={34} stroke={3} tone={today.puzzles >= DAILY.puzzles ? "good" : "accent"}>
              <small>
                {Math.min(today.puzzles, DAILY.puzzles)}/{DAILY.puzzles}
              </small>
            </Ring>
          </div>
          <strong>Train your decisions</strong>
          <small className="muted">Real moments from your deaths, then endless drills.</small>
          <span className="tile-cta"><Zap size={13} fill="currentColor" /> Play</span>
        </div>

        <div className="tile">
          <div className="tile-top">
            <p className="eyebrow icon-eyebrow"><TrendingUp size={13} /> Last 10 games</p>
            <span className={`delta ${wins >= 5 ? "up" : "down"}`}>{wins * 10}% WR</span>
          </div>
          <div className="form-strip">
            {last10
              .slice()
              .reverse()
              .map((g) => (
                <button key={g.metrics.matchId} className={`form-cell ${g.metrics.win ? "w" : "l"}`} onClick={() => onReview(g.metrics.matchId)} title={`${g.metrics.champion}: ${momentCount(g)} moments to review`}>
                  <ChampIcon name={g.metrics.champion} size={28} />
                  <b className={momentCount(g) > 2 ? "g-D" : momentCount(g) ? "g-C" : "g-A"}>{momentCount(g)}</b>
                  {progress.reviewedGames.includes(g.metrics.matchId) && <i className="check" />}
                </button>
              ))}
          </div>
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h3>The plan</h3>
            <small className="muted">from your last {plan.gamesConsidered} games</small>
          </div>
          <PlanList plan={plan} />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Skill profile</h3>
            <small className="muted">50 = typical Silver/Gold</small>
          </div>
          {profile && (
            <div className="profile">
              <Radar axes={SKILLS.map((s) => s.label)} values={SKILLS.map((s) => profile.skills[s.key])} compare={profile.previous ? SKILLS.map((s) => profile.previous![s.key]) : undefined} size={240} />
              <div className="meters">
                {SKILLS.map((s) => (
                  <Meter key={s.key} label={s.label} value={profile.skills[s.key]} delta={profile.previous ? profile.skills[s.key] - profile.previous[s.key] : null} />
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Trend</h3>
          <div className="seg sm">
            {TRENDS.map((x) => (
              <button key={x.key} className={metric === x.key ? "on" : ""} onClick={() => setMetric(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
        </div>
        <LineChart points={tr.map((p) => ({ x: p.i + 1, y: p.value }))} zeroLine={t.zero} format={t.fmt} xLabel={(x) => `game ${x}`} height={150} />
      </section>
    </div>
  );
}

// Which drill trains each focus, and which mistake in your games shows it.
const TRAIN: Record<string, { drill: "jungle" | "decisions" | "mechanics"; kind?: string }> = {
  ganks: { drill: "jungle", kind: "ganked" },
  overextending: { drill: "jungle", kind: "overextended" },
  early_deaths: { drill: "jungle", kind: "early_death" },
  objective_deaths: { drill: "decisions", kind: "died_before_objective" },
  unspent_gold: { drill: "decisions", kind: "died_with_gold" },
  shutdowns: { drill: "decisions", kind: "gave_shutdown" },
  recall_timing: { drill: "decisions", kind: "recall" },
  lane_farm: { drill: "mechanics", kind: "farm" },
  farming: { drill: "mechanics" },
  losing_lane: { drill: "mechanics" },
};

function NextStep({ plan, games, onReview, onPuzzles, onMechanics }: { plan: CoachPlan; games: GameReport[]; onReview: (id: string, autoplay?: boolean, kind?: string) => void; onPuzzles: () => void; onMechanics?: () => void }) {
  const c = plan.current;
  if (!c) return <div className="hero quiet">{plan.verdict}</div>;
  const passed = c.results.filter((x) => x === true).length;
  return (
    <section className="hero">
      <div className="hero-main">
        <p className="eyebrow accent icon-eyebrow"><Crosshair size={13} /> Your focus</p>
        <h2>{c.title}</h2>
        <p className="hero-evidence">{c.evidence}</p>
        <ol className="rules">
          {c.rules.map((r, i) => (
            <li key={r}>
              <span>{i + 1}</span>
              {r}
            </li>
          ))}
        </ol>
        {(() => {
          const t = TRAIN[c.id] ?? { drill: "decisions" as const };
          const hits = (g: GameReport) => g.mistakes.filter((m) => m.kind === t.kind).length + (g.leaks ?? []).filter((l) => l.kind === t.kind).length;
          const example = t.kind ? [...games].sort((a, b) => hits(b) - hits(a)).find((g) => hits(g) > 0) : undefined;
          const goDrill = () => {
            if (t.drill === "mechanics" && onMechanics) return onMechanics();
            try {
              localStorage.setItem("lc.puzzleMode", t.drill === "jungle" ? "jungle" : "decisions");
            } catch {
              /* falls back to the last mode */
            }
            onPuzzles();
          };
          return (
            <div className="hero-actions">
              <Button variant="primary" onClick={goDrill}>
                {t.drill === "jungle" ? <Footprints size={15} /> : t.drill === "mechanics" ? <Gamepad2 size={15} /> : <Brain size={15} />}
                {t.drill === "jungle" ? "Drill it: where's the jungler?" : t.drill === "mechanics" ? "Drill it in the lane lab" : "Drill it: decision puzzles"}
              </Button>
              {example && (
                <Button onClick={() => onReview(example.metrics.matchId, true, t.kind)}>
                  <Play size={14} /> Watch it happen ({example.metrics.champion}, {hits(example)}x)
                </Button>
              )}
            </div>
          );
        })()}
      </div>
      <aside className="hero-side">
        <p className="eyebrow icon-eyebrow"><ListChecks size={13} /> Passing means</p>
        <strong>{c.passRule}</strong>
        <ResultDots results={c.results} />
        <small className="muted">
          {passed} of your last {c.results.length} games passed. Pass 4 of 5 to move on.
        </small>
        <p className="why">{c.why}</p>
      </aside>
    </section>
  );
}

// Where the gold actually goes: every leak the replay reader found, summed per game.
function Levers({ games, onReview }: { games: GameReport[]; onReview: (id: string, autoplay?: boolean, kind?: string) => void }) {
  const levers = useMemo(() => leverTotals(games), [games]);
  if (!levers.length) return null;
  const max = Math.max(...levers.map((l) => l.perGame), 1);
  const worst = (kind: string) => {
    let best: { id: string; cost: number; title: string } | undefined;
    for (const g of games) for (const l of g.leaks ?? []) if (l.kind === kind && (!best || l.cost > best.cost)) best = { id: g.metrics.matchId, cost: l.cost, title: l.title };
    return best;
  };
  return (
    <section className="card levers">
      <div className="card-head">
        <h3>Biggest levers</h3>
        <small className="muted">Gold you threw away per game, by cause. Fix the top bar first.</small>
      </div>
      <ol>
        {levers.map((l) => {
          const w = worst(l.kind);
          return (
            <li key={l.kind}>
              <div className="lever-label">
                <strong>{LEAK_LABEL[l.kind]}</strong>
                <span>{l.perGame}g / game</span>
              </div>
              <div className="lever-bar"><i style={{ width: `${(l.perGame / max) * 100}%` }} /></div>
              {w && (
                <button className="lever-worst" onClick={() => onReview(w.id, true, l.kind)}>
                  <Play size={12} /> Watch the worst one: {w.title}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PlanList({ plan }: { plan: CoachPlan }) {
  const rows = [
    ...(plan.current ? [{ i: plan.current, tag: "Now", tone: "accent" }] : []),
    ...plan.upNext.map((i) => ({ i, tag: "Next", tone: "muted" })),
    ...plan.fixed.slice(0, 3).map((i) => ({ i, tag: "Fixed", tone: "good" })),
  ];
  return (
    <ol className="plan">
      {rows.map(({ i, tag, tone }) => (
        <li key={i.id} className={tone}>
          <span className={`plan-tag ${tone}`}>{tag}</span>
          <div>
            <strong>{i.title}</strong>
            <small>{i.evidence}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}
