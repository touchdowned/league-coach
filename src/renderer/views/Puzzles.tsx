import { useEffect, useMemo, useRef, useState } from "react";
import { CHOICES, Choice, puzzleAt, puzzlesFromGames } from "../../core/puzzles";
import type { GameReport } from "../../core/types";
import { ChampIcon, MapBackdrop } from "../charts";
import { useProgress } from "../progress";
import { Button, Kbd } from "../ui";

const KEY = "lc.puzzles";
interface Stats {
  index: number;
  solved: number;
  attempted: number;
  streak: number;
  best: number;
}
const EMPTY: Stats = { index: 0, solved: 0, attempted: 0, streak: 0, best: 0 };

function load(): Stats {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return EMPTY;
  }
}

export function PuzzlesView({ games }: { games: GameReport[] }) {
  const own = useMemo(() => puzzlesFromGames(games), [games]);
  const [stats, setStats] = useState<Stats>(load);
  const [picked, setPicked] = useState<Choice | null>(null);
  const { award } = useProgress();
  const main = games[0]?.metrics;
  const p = puzzleAt(stats.index, own, main?.champion, main?.role);
  const currentId = useRef(p.id);
  currentId.current = p.id;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(stats));
    } catch {
      /* storage unavailable: progress just won't persist */
    }
  }, [stats]);

  function choose(c: Choice) {
    if (picked) return;
    setPicked(c);
    const right = c === p.answer;
    award({ type: "puzzle", right });
    if (right) {
      const id = p.id;
      setTimeout(() => currentId.current === id && next(), 1500);
    }
    setStats((s) => {
      const streak = right ? s.streak + 1 : 0;
      return { ...s, attempted: s.attempted + 1, solved: s.solved + (right ? 1 : 0), streak, best: Math.max(s.best, streak) };
    });
  }

  function next() {
    setPicked((cur) => {
      if (cur !== null) setStats((s) => ({ ...s, index: s.index + 1 }));
      return null;
    });
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (!picked && n >= 1 && n <= p.options.length) choose(p.options[n - 1]);
      if (picked && (e.key === "Enter" || e.key === " ")) next();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const right = picked === p.answer;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Puzzles</p>
          <h1>What's the right play?</h1>
          <p className="muted">
            {own.length} from your own deaths, then endless drills. <Kbd>1</Kbd>–<Kbd>4</Kbd> to answer, <Kbd>Enter</Kbd> for next.
          </p>
        </div>
        <div className="puzzle-stats">
          <div>
            <small>Accuracy</small>
            <strong>{stats.attempted ? Math.round((stats.solved / stats.attempted) * 100) : 0}%</strong>
          </div>
          <div>
            <small>Streak</small>
            <strong className={stats.streak >= 3 ? "hot" : ""} key={stats.streak}>{stats.streak}</strong>
          </div>
          <div>
            <small>Best</small>
            <strong>{stats.best}</strong>
          </div>
          <div>
            <small>Solved</small>
            <strong>{stats.solved}</strong>
          </div>
        </div>
      </div>

      <div className="puzzle">
        <div className="panel puzzle-map-card">
          <PuzzleMap position={p.position} threats={p.threats} teamId={p.teamId} champion={p.champion} />
        </div>
        <div className={`panel puzzle-body ${picked ? (right ? "is-right" : "is-wrong") : ""}`} key={p.id}>
          <div className="puzzle-tag">
            <span className={`tag ${p.source === "your-game" ? "tag-hot" : ""}`}>{p.source === "your-game" ? "From your game" : "Drill"}</span>
            <span className="cell-champ">
              <ChampIcon name={p.champion} size={28} />
              {p.champion}
              {p.opponent && (
                <>
                  <span className="vs">vs</span>
                  <ChampIcon name={p.opponent} size={28} />
                  {p.opponent}
                </>
              )}
            </span>
          </div>
          <ul className="facts">
            {p.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <h3>What do you do?</h3>
          <div className="choices">
            {p.options.map((o, i) => {
              const state = !picked ? "" : o === p.answer ? "correct" : o === picked ? "wrong" : "dim";
              return (
                <button key={o} className={`choice ${state}`} onClick={() => choose(o)} disabled={!!picked}>
                  <kbd>{i + 1}</kbd>
                  {CHOICES[o]}
                  {picked && p.youChose === o && <span className="you-did">what you did</span>}
                </button>
              );
            })}
          </div>
          {picked && (
            <div className={`answer ${right ? "right" : "wrong"}`}>
              <strong>{right ? "Correct." : `Wrong. The answer is: ${CHOICES[p.answer]}.`}</strong>
              <p>{p.explanation}</p>
              {p.outcome && <p className="muted small">What actually happened: {p.outcome}</p>}
              <Button variant="primary" onClick={next}>
                {right ? "Next (auto)" : "Next puzzle"} →
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const MAP_MAX = 14870;

function PuzzleMap({
  position,
  threats,
  teamId,
  champion,
}: {
  position: { x: number; y: number };
  threats: { x: number; y: number; label: string }[];
  teamId: number;
  champion: string;
}) {
  const size = 320;
  const px = (p: { x: number; y: number }) => [(p.x / MAP_MAX) * size, (1 - p.y / MAP_MAX) * size];
  const [x, y] = px(position);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="map big">
      <MapBackdrop size={size} />
      <rect width={size} height={size} className="map-frame" />
      {threats.map((t, i) => {
        const [tx, ty] = px(t);
        return (
          <g key={i}>
            <circle cx={tx} cy={ty} r="26" className="fog" />
            <text x={tx} y={ty + 6} textAnchor="middle" className="fog-label">
              {t.label}
            </text>
          </g>
        );
      })}
      <circle cx={x} cy={y} r="13" className={teamId === 100 ? "you blue" : "you red"} />
      <text x={x} y={y + 4} textAnchor="middle" className="you-label">
        {champion.slice(0, 2)}
      </text>
      <text x="8" y={size - 8} className="map-note">
        {teamId === 100 ? "You're blue side (bottom-left base)" : "You're red side (top-right base)"}
      </text>
    </svg>
  );
}
