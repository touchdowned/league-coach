import { Footprints } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { fmtTime } from "../../core/analysis";
import { describeSpot, dist, gradeGuess, junglePuzzles } from "../../core/track";
import type { GameReport } from "../../core/types";
import { ChampIcon } from "../charts";
import { useProgress } from "../progress";
import { Rift, useGameClock } from "../rift";
import { Button, Empty, Kbd } from "../ui";

const KEY = "lc.jungle";

function shuffleOrder(n: number, seed: number) {
  const a = Array.from({ length: n }, (_, i) => i);
  let s = seed || 1;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Jungle tracking from your own games: the map is frozen at a real minute of laning
 * phase, the enemy jungler is in the fog, and you see where they were a minute ago.
 * Click where they are now. Then watch their real path.
 */
export function JungleDrill({ games }: { games: GameReport[] }) {
  const all = useMemo(() => junglePuzzles(games), [games]);
  const order = useMemo(() => shuffleOrder(all.length, all.length * 7919), [all.length]);
  const [n, setN] = useState(() => {
    try {
      return Number(localStorage.getItem(KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  });
  const [guess, setGuess] = useState<{ x: number; y: number } | null>(null);
  const [score, setScore] = useState({ tries: 0, close: 0, totalOff: 0 });
  const { award } = useProgress();

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(n));
    } catch {
      /* not persisted */
    }
  }, [n]);

  const q = all.length ? all[order[n % all.length]] : null;
  const game = q ? games.find((g) => g.metrics.matchId === q.matchId) : null;
  // After the guess, replay the jungler's last minute at 12x so you see the real path.
  const t = useGameClock(q ? q.lastSeen.t : 0, q ? q.t : 0, 12, !!guess);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (guess && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (!q || !game?.track) {
    return <Empty title="Sync to unlock jungle tracking" body="This drill uses where every champion was in your own games. Press Sync games once and it fills with questions from your laning phases." />;
  }

  const off = guess ? dist(guess, q.answer) : 0;
  const g = gradeGuess(off);

  function pick(p: { x: number; y: number }) {
    if (guess) return;
    setGuess(p);
    const d = dist(p, q!.answer);
    const right = gradeGuess(d).right;
    setScore((s) => ({ tries: s.tries + 1, close: s.close + (right ? 1 : 0), totalOff: s.totalOff + d }));
    award({ type: "puzzle", right });
  }
  function next() {
    setGuess(null);
    setN((x) => x + 1);
  }

  return (
    <div className="jungle">
      <div className="panel jungle-map">
        <Rift
          track={game.track}
          teamId={q.teamId}
          meId={game.track.players.find((p) => p.champion === game.metrics.champion && p.teamId === game.teamId)?.id}
          t={guess ? t : q.t}
          hidden={guess && t < q.t ? [] : [q.jungler.id]}
          ghosts={[{ ...q.lastSeen, champion: q.jungler.champion, label: "1:00 ago" }]}
          guess={guess}
          answer={guess && t >= q.t ? { ...q.answer, champion: q.jungler.champion } : null}
          onPick={guess ? undefined : pick}
        />
        <span className="rift-clock">{fmtTime(guess ? t : q.t)}</span>
        {!guess && <span className="rift-frozen">Click where {q.jungler.champion} is</span>}
      </div>
      <div className="panel jungle-side">
        <p className="eyebrow icon-eyebrow"><Footprints size={13} /> Jungle tracking</p>
        <h2 className="jungle-q">
          <ChampIcon name={q.jungler.champion} size={30} /> {fmtTime(q.t)}. Where is {q.jungler.champion}?
        </h2>
        <p className="muted">
          From your {game.metrics.champion} game. They were {describeSpot(q.lastSeen, q.teamId)} a minute ago (the grey icon). Everyone else is where they really were.
        </p>
        {guess ? (
          <div className={`answer ${g.right ? "right" : "wrong"}`}>
            <strong>
              {g.label}. {q.jungler.champion} was {describeSpot(q.answer, q.teamId)}.
            </strong>
            <p>
              You were {Math.round(off).toLocaleString()} units off{off >= 3000 ? ", about a lane's width or more" : ""}. Watch the path from the grey icon: that's the route to expect next time at this minute.
            </p>
            <Button variant="primary" onClick={next}>
              Next <Kbd>Enter</Kbd>
            </Button>
          </div>
        ) : (
          <p className="muted small">Within 1,500 units counts as spot on, within 3,000 as close.</p>
        )}
        <div className="jungle-stats">
          <div>
            <small>Close or better</small>
            <strong>{score.tries ? Math.round((score.close / score.tries) * 100) : 0}%</strong>
          </div>
          <div>
            <small>Average miss</small>
            <strong>{score.tries ? Math.round(score.totalOff / score.tries).toLocaleString() : "–"}</strong>
          </div>
          <div>
            <small>Questions</small>
            <strong>{all.length}</strong>
          </div>
        </div>
      </div>
    </div>
  );
}
