import { ArrowRight, Brain, Check, Clapperboard, Crosshair, Eye, Flame, Gauge, MonitorPlay, Moon, NotebookPen, Skull, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { debriefCoaching, debriefQuestions, Debrief, LiveRecord, mmss, Mood, MOODS, tiltProfile, TiltProfile, WinBucket } from "../../core/mind";
import type { GameReport } from "../../core/types";
import { coach, DraftInfo, LivePayload, MindData } from "../api";
import { ChampIcon, LineChart } from "../charts";
import { DraftCard } from "../overlay/Draft";
import { Button } from "../ui";

const gameIdOf = (matchId: string) => matchId.split("_").pop() ?? matchId;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function MindView({ games, debriefFor, onDebriefDone, onReview }: { games: GameReport[]; debriefFor: string | null; onDebriefDone: () => void; onReview: (matchId: string) => void }) {
  const [data, setData] = useState<MindData | null>(null);
  const [draft, setDraft] = useState<DraftInfo | null>(null);
  const [live, setLive] = useState<LivePayload | null>(null);
  const [debrief, setDebrief] = useState<string | null>(debriefFor);
  const [mode, setMode] = useState<string | null>(null);
  useEffect(() => setDebrief(debriefFor), [debriefFor]);
  useEffect(() => {
    coach().mindGet().then((r) => r.ok && setData(r.value));
    coach().mindDraftInfo().then((r) => r.ok && setDraft(r.value));
    coach().mindWindowMode().then((r) => r.ok && setMode(r.value));
    const off1 = coach().onMindLive((p) => !p.preview && setLive(p));
    const off2 = coach().onMindPlan(() => coach().mindDraftInfo().then((r) => r.ok && setDraft(r.value)));
    return () => {
      off1();
      off2();
    };
  }, []);
  const profile = useMemo(() => tiltProfile(games), [games]);

  if (!data) return <div className="page" />;

  if (debrief) {
    const rec = data.records.find((r) => r.gameId === debrief) ?? null;
    const report = games.find((g) => gameIdOf(g.metrics.matchId) === debrief) ?? null;
    return (
      <DebriefFlow
        gameId={debrief}
        rec={rec}
        report={report}
        profile={profile}
        onDone={async (db) => {
          const r = db ? await coach().mindSaveDebrief(db) : await coach().mindSkipDebrief(debrief);
          if (r.ok) setData(r.value);
          setDebrief(null);
          onDebriefDone();
          coach().mindDraftInfo().then((x) => x.ok && setDraft(x.value));
        }}
        onReview={report ? () => onReview(report.metrics.matchId) : undefined}
      />
    );
  }

  const pending = data.pending.filter((g) => !data.debriefs.some((d) => d.gameId === g));
  return (
    <div className="page mind">
      <header className="page-head">
        <div>
          <span className="eyebrow accent">Mental game</span>
          <h1>Mind</h1>
          <p className="muted">One goal per game, tracked live over League, then a short debrief. Your head is a skill too.</p>
        </div>
      </header>

      {pending.length > 0 && (
        <button className="mind-pending" onClick={() => setDebrief(pending[0])}>
          <NotebookPen size={18} aria-hidden />
          <div>
            <b>Debrief your last game</b>
            <span>Two minutes, while it's fresh. It's what the next goal is built from.</span>
          </div>
          <ArrowRight size={18} aria-hidden />
        </button>
      )}

      {live && <LiveMirror p={live} />}

      <div className="mind-grid">
        <section className="card mind-next">
          <div className="card-head">
            <h3>Next game</h3>
            <span className="muted small">Shows up by itself in champ select</span>
          </div>
          {draft && <DraftCard info={draft} onLocked={() => coach().mindDraftInfo().then((r) => r.ok && setDraft(r.value))} />}
        </section>
        <div className="mind-col">
          <OverlayCard mode={mode} />
          <GoalHistory records={data.records} />
        </div>
      </div>

      <FocusTrend records={data.records} debriefs={data.debriefs} />
      {profile ? <TiltCard p={profile} /> : <section className="card"><p className="muted">Sync at least 5 games to see your tilt profile.</p></section>}
      <MoodCard debriefs={data.debriefs} />
      <DebriefList debriefs={data.debriefs} records={data.records} onOpen={(g) => setDebrief(g)} />
    </div>
  );
}

// ---------------------------------------------------------------- cards

function OverlayCard({ mode }: { mode: string | null }) {
  const [on, setOn] = useState(false);
  return (
    <section className="card mind-overlay">
      <div className="card-head">
        <h3>
          <MonitorPlay size={15} aria-hidden /> In-game overlay
        </h3>
      </div>
      {mode === "fullscreen" ? (
        <p className="mind-warn">
          <TriangleAlert size={14} aria-hidden /> League is set to Fullscreen, which draws over everything. In game: Settings → Video → Window Mode → <b>Borderless</b>.
        </p>
      ) : (
        <p className="muted small">Goals and focus sit over League in a click-through panel. Borderless or windowed mode.</p>
      )}
      <ul className="mind-keys">
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> hide / show
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> move the panel
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd>…<kbd>5</kbd> rate your head while dead
        </li>
      </ul>
      <Button
        variant="secondary"
        onClick={async () => {
          if (on) await coach().mindEndPreview();
          else await coach().mindPreview();
          setOn(!on);
        }}
      >
        {on ? "Close preview" : "Preview and place overlay"}
      </Button>
    </section>
  );
}

function LiveMirror({ p }: { p: LivePayload }) {
  const v = p.view;
  return (
    <section className="card mind-live">
      <span className="live-dot" /> <b>In game</b> · {mmss(v.gameTime)} · {v.kda.join("/")} · {v.cs} CS
      <span className="mind-live-goals">
        <StatusPill title={v.skill.title} status={v.skill.status} value={v.skill.value} />
        <StatusPill title={v.mental.title} status={v.mental.status} value={v.mental.value} />
        <span className="mind-live-focus">Focus {v.focus}</span>
      </span>
    </section>
  );
}

function StatusPill({ title, status, value }: { title: string; status: string; value: string }) {
  return (
    <span className={`spill ${status}`}>
      {title} <b>{value}</b>
    </span>
  );
}

function GoalHistory({ records }: { records: LiveRecord[] }) {
  const rs = records.slice(0, 10);
  return (
    <section className="card">
      <div className="card-head">
        <h3>Goal record</h3>
        <span className="muted small">{rs.length ? `${rs.filter((r) => r.skill.status === "passed").length + rs.filter((r) => r.mental.status === "passed").length} of ${rs.length * 2} kept` : ""}</span>
      </div>
      {rs.length === 0 ? (
        <p className="muted small">Play a game with League Coach open and your goals show up here.</p>
      ) : (
        <div className="goal-rows">
          {rs.map((r) => (
            <div key={r.gameId} className="goal-row">
              <ChampIcon name={r.champion} size={26} />
              <GoalMark ok={r.skill.status === "passed"} icon="skill" title={r.skill.title} />
              <GoalMark ok={r.mental.status === "passed"} icon="mental" title={r.mental.title} />
              <span className={`goal-focus ${r.focus >= 70 ? "good" : r.focus >= 45 ? "warn" : "bad"}`}>{r.focus}</span>
              <span className={`goal-wl ${r.win === null ? "" : r.win ? "win" : "loss"}`}>{r.win === null ? "" : r.win ? "W" : "L"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GoalMark({ ok, icon, title }: { ok: boolean; icon: "skill" | "mental"; title: string }) {
  const Icon = icon === "skill" ? Crosshair : Brain;
  return (
    <span className={`goal-mark ${ok ? "ok" : "miss"}`} title={title}>
      <Icon size={12} aria-hidden /> {title}
      {ok ? <Check size={12} aria-hidden /> : <X size={12} aria-hidden />}
    </span>
  );
}

function FocusTrend({ records, debriefs }: { records: LiveRecord[]; debriefs: Debrief[] }) {
  const pts = records
    .slice(0, 30)
    .reverse()
    .map((r, i) => ({ x: i + 1, y: r.focus }));
  const self = debriefs.slice(0, 30).reverse();
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Gauge size={15} aria-hidden /> Focus over your games
        </h3>
        <span className="muted small">{self.length ? `Your own rating averages ${(self.reduce((a, d) => a + d.focus, 0) / self.length).toFixed(1)} / 5` : "Built from death chains, farm after deaths, goals and check-ins"}</span>
      </div>
      <LineChart points={pts} zeroLine={false} height={150} xLabel={(x) => `#${x}`} reference={{ y: 70, label: "Locked in" }} />
    </section>
  );
}

function Bars({ buckets, base }: { buckets: WinBucket[]; base: number }) {
  return (
    <div className="wr-rows">
      {buckets.map((b) => (
        <div key={b.label} className={`wr-row ${b.games < 3 ? "thin" : b.winRate >= base + 0.05 ? "good" : b.winRate <= base - 0.05 ? "bad" : ""}`}>
          <span>{b.label}</span>
          <span className="wr-track">
            <span style={{ width: `${b.games ? Math.max(3, b.winRate * 100) : 0}%` }} />
            <i style={{ left: `${base * 100}%` }} title="Your average" />
          </span>
          <b>{b.games ? pct(b.winRate) : "—"}</b>
          <small className="muted">{b.games} g</small>
        </div>
      ))}
    </div>
  );
}

function TiltCard({ p }: { p: TiltProfile }) {
  return (
    <section className="card tilt">
      <div className="card-head">
        <h3>
          <Flame size={15} aria-hidden /> Your tilt profile
        </h3>
        <span className="muted small">
          {p.games} games · {pct(p.winRate)} overall
        </span>
      </div>
      <div className="tilt-headlines">
        <div className={`tilt-stat ${p.chainWinRate < p.noChainWinRate - 0.05 ? "bad" : ""}`}>
          <Skull size={16} aria-hidden />
          <b>
            {pct(p.chainWinRate)} <small>vs {pct(p.noChainWinRate)}</small>
          </b>
          <span>
            Win rate in games where you died twice within 2.5 minutes ({p.chainGames} of {p.games} games)
          </span>
        </div>
        <div className={`tilt-stat ${p.stopAfter ? "bad" : "good"}`}>
          <TriangleAlert size={16} aria-hidden />
          <b>{p.stopAfter ? `Stop after ${p.stopAfter} loss${p.stopAfter > 1 ? "es" : ""}` : "No stop-loss needed yet"}</b>
          <span>{p.stopAfter ? `After ${p.stopAfter} in a row your next game is clearly worse than your ${pct(p.winRate)} average.` : "Losses don't drag your next game down much. Keep watching it."}</span>
        </div>
        <div className="tilt-stat">
          <Moon size={16} aria-hidden />
          <b>
            {pct(p.afterLoss.winRate)} <small>after a loss</small>
          </b>
          <span>
            {pct(p.afterWin.winRate)} after a win, {pct(p.afterTwoLosses.winRate)} after two losses ({p.afterTwoLosses.games} games)
          </span>
        </div>
      </div>
      <div className="tilt-charts">
        <div>
          <h4>Game number in a session</h4>
          <Bars buckets={p.byGameInSession} base={p.winRate} />
        </div>
        <div>
          <h4>Time of day</h4>
          <Bars buckets={p.byTimeOfDay} base={p.winRate} />
        </div>
      </div>
    </section>
  );
}

function MoodCard({ debriefs }: { debriefs: Debrief[] }) {
  const rows = MOODS.map((m) => {
    const ds = debriefs.filter((d) => d.moods.includes(m.id) && d.win !== null);
    return { ...m, games: ds.length, winRate: ds.length ? ds.filter((d) => d.win).length / ds.length : 0 };
  }).filter((r) => r.games > 0);
  const triggers = new Map<string, number>();
  for (const d of debriefs) for (const t of d.answers.trigger ?? []) triggers.set(t, (triggers.get(t) ?? 0) + 1);
  const TRIG: Record<string, string> = { own: "Own mistakes", teammate: "Teammates", chat: "Chat / pings", lane: "Losing lane", streak: "Losing streaks", life: "Outside the game" };
  return (
    <section className="card">
      <div className="card-head">
        <h3>
          <Eye size={15} aria-hidden /> How you felt vs how you did
        </h3>
        <span className="muted small">From {debriefs.length} debrief{debriefs.length === 1 ? "" : "s"}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted small">After a few debriefs this shows which moods you win in and what sets you off.</p>
      ) : (
        <div className="mood-grid">
          <div className="mood-rows">
            {rows
              .sort((a, b) => b.games - a.games)
              .map((r) => (
                <div key={r.id} className={`mood-row ${r.tone}`}>
                  <span>{r.label}</span>
                  <span className="mood-track">
                    <span style={{ width: `${r.winRate * 100}%` }} />
                  </span>
                  <b>{pct(r.winRate)}</b>
                  <small className="muted">{r.games} g</small>
                </div>
              ))}
          </div>
          <div className="mood-trig">
            <h4>What sets you off</h4>
            {[...triggers.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <div key={k} className="trig-row">
                  <span>{TRIG[k] ?? k}</span>
                  <b>{n}×</b>
                </div>
              ))}
            {!triggers.size && <p className="muted small">Nothing yet. Good.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function DebriefList({ debriefs, records, onOpen }: { debriefs: Debrief[]; records: LiveRecord[]; onOpen: (gameId: string) => void }) {
  if (!debriefs.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Debriefs</h3>
      </div>
      <div className="db-list">
        {debriefs.slice(0, 12).map((d) => {
          const rec = records.find((r) => r.gameId === d.gameId);
          return (
            <button key={d.gameId} className="db-item" onClick={() => onOpen(d.gameId)}>
              <ChampIcon name={d.champion} size={28} />
              <div>
                <b>
                  {d.moods.map((m) => MOODS.find((x) => x.id === m)?.label).join(", ") || "No mood"} · focus {d.focus}/5
                </b>
                <span className="muted small">
                  {new Date(d.at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                  {rec ? ` · ${rec.skill.status === "passed" ? "kept" : "missed"} ${rec.skill.title.toLowerCase()}` : ""}
                  {d.nextIntention ? ` · next: “${d.nextIntention}”` : ""}
                </span>
              </div>
              <span className={`goal-wl ${d.win === null ? "" : d.win ? "win" : "loss"}`}>{d.win === null ? "" : d.win ? "W" : "L"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- debrief flow

function DebriefFlow({ gameId, rec, report, profile, onDone, onReview }: { gameId: string; rec: LiveRecord | null; report: GameReport | null; profile: TiltProfile | null; onDone: (db: Debrief | null) => void; onReview?: () => void }) {
  const [step, setStep] = useState(0);
  const [moods, setMoods] = useState<Mood[]>([]);
  const [focus, setFocus] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const [next, setNext] = useState("");
  const questions = useMemo(() => debriefQuestions(rec, moods, report), [rec, moods, report]);
  const win = rec?.win ?? report?.metrics.win ?? null;
  const champion = rec?.champion || report?.metrics.champion || "";
  // Steps: 0 mood, 1 focus, 2..n questions, last = coaching.
  const qStep = step - 2;
  const last = 2 + questions.length;
  const cards = step === last ? debriefCoaching({ moods, focus, answers }, rec, profile) : [];
  const progress = step / last;

  function toggleMood(m: Mood) {
    setMoods((ms) => (ms.includes(m) ? ms.filter((x) => x !== m) : ms.length >= 2 ? [ms[1], m] : [...ms, m]));
  }
  function answer(qid: string, opt: string, multi?: boolean) {
    setAnswers((a) => {
      const cur = a[qid] ?? [];
      return { ...a, [qid]: multi ? (cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]) : [opt] };
    });
    if (!multi) setTimeout(() => setStep((s) => s + 1), 180);
  }
  const canNext = step === 0 ? moods.length > 0 : step === 1 ? focus > 0 : step < last ? (answers[questions[qStep]?.id]?.length ?? 0) > 0 : true;

  return (
    <div className="page debrief">
      <div className="db-top">
        <div className="db-game">
          {champion && <ChampIcon name={champion} size={40} />}
          <div>
            <span className="eyebrow accent">Debrief</span>
            <h2>
              {win === null ? "That game" : win ? "Win" : "Loss"}
              {champion ? ` on ${champion}` : ""}
              {rec ? ` · ${mmss(rec.durationSec)}` : ""}
            </h2>
          </div>
        </div>
        <button className="db-skip" onClick={() => onDone(null)}>
          Skip
        </button>
      </div>
      <div className="db-progress">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>

      {rec && step < 2 && (
        <div className="db-facts">
          <Fact label={rec.skill.title} value={rec.skill.value} ok={rec.skill.status === "passed"} />
          <Fact label={rec.mental.title} value={rec.mental.value} ok={rec.mental.status === "passed"} />
          <Fact label="Deaths" value={String(rec.deaths.length)} sub={rec.deaths.some((d) => d.chain) ? "with a death chain" : "no death chains"} ok={!rec.deaths.some((d) => d.chain)} />
          <Fact label="Check-ins" value={rec.checkIns.length ? rec.checkIns.map((c) => c.rating).join(" · ") : "none"} sub={rec.checkIns.length ? "1 tilted, 5 locked in" : "Ctrl+Shift+1-5 while dead"} />
        </div>
      )}

      <div className="db-stage" key={step}>
        {step === 0 && (
          <>
            <h1 className="db-q">How did that game feel?</h1>
            <p className="muted">Pick one or two.</p>
            <div className="mood-pick">
              {(["high", "low"] as const).map((energy) => (
                <div key={energy} className="mood-pick-row">
                  <span className="mood-pick-label">{energy === "high" ? "Wired" : "Flat"}</span>
                  {MOODS.filter((m) => m.energy === energy).map((m) => (
                    <button key={m.id} className={`mood-chip ${m.tone} ${moods.includes(m.id) ? "on" : ""}`} onClick={() => toggleMood(m.id)}>
                      {m.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h1 className="db-q">How focused were you, honestly?</h1>
            <div className="focus-pick">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`focus-chip ${focus === n ? "on" : ""}`}
                  onClick={() => {
                    setFocus(n);
                    setTimeout(() => setStep(2), 180);
                  }}
                >
                  <b>{n}</b>
                  <small>{["Gone", "Drifting", "In and out", "Mostly there", "Locked in"][n - 1]}</small>
                </button>
              ))}
            </div>
            {rec && rec.checkIns.length > 0 && <p className="muted small">In game you rated yourself {rec.checkIns.map((c) => `${c.rating} at ${mmss(c.t)}`).join(", ")}.</p>}
          </>
        )}
        {step >= 2 && step < last && questions[qStep] && (
          <>
            {questions[qStep].context && <p className="db-context">{questions[qStep].context}</p>}
            <h1 className="db-q">{questions[qStep].prompt}</h1>
            {questions[qStep].multi && <p className="muted">Pick all that fit.</p>}
            <div className="db-opts">
              {questions[qStep].options.map((o) => (
                <button key={o.id} className={`db-opt ${(answers[questions[qStep].id] ?? []).includes(o.id) ? "on" : ""}`} onClick={() => answer(questions[qStep].id, o.id, questions[qStep].multi)}>
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}
        {step === last && (
          <>
            <h1 className="db-q">Take this into the next game</h1>
            <div className="db-cards">
              {cards.map((c, i) => (
                <div key={i} className={`db-card ${c.tone}`} style={{ animationDelay: `${i * 70}ms` }}>
                  <b>{c.title}</b>
                  <p>{c.body}</p>
                  {c.rule && (
                    <button className={`db-rule ${next === c.rule ? "on" : ""}`} onClick={() => setNext(c.rule!)}>
                      {next === c.rule ? <Check size={13} aria-hidden /> : <ArrowRight size={13} aria-hidden />} {c.rule}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <label className="db-field">
              <span>Next game, I will…</span>
              <input value={next} maxLength={80} onChange={(e) => setNext(e.target.value)} placeholder="Pick a rule above or write your own" />
            </label>
            <label className="db-field">
              <span>Anything else (only you see this)</span>
              <textarea value={note} rows={2} onChange={(e) => setNote(e.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="db-nav">
        {step > 0 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <span className="grow" />
        {step < last ? (
          <Button variant="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </Button>
        ) : (
          <>
            {onReview && (
              <Button
                variant="secondary"
                onClick={() => {
                  onDone(save());
                  onReview();
                }}
              >
                <Clapperboard size={15} aria-hidden /> Save and review the game
              </Button>
            )}
            <Button variant="primary" onClick={() => onDone(save())}>
              Save debrief
            </Button>
          </>
        )}
      </div>
    </div>
  );

  function save(): Debrief {
    return { gameId, matchId: report?.metrics.matchId, at: Date.now(), moods, focus, answers, note, nextIntention: next, win, champion };
  }
}

function Fact({ label, value, sub, ok }: { label: string; value: string; sub?: string; ok?: boolean }) {
  return (
    <div className={`db-fact ${ok === undefined ? "" : ok ? "ok" : "miss"}`}>
      <small>{label}</small>
      <b>{value}</b>
      {sub && <span>{sub}</span>}
    </div>
  );
}

