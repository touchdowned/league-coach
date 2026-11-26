import { Check, Play, Target, X } from "lucide-react";
import { useEffect, useState } from "react";
import { FOCUS_HOLD, FOCUS_LAST, type Focus, type FocusGame } from "../../core/focus";
import { champName } from "../../core/names";
import type { GameReport } from "../../core/types";
import { coach } from "../api";
import { Button } from "../ui";

/** The focus as the main process last worked it out; refreshed whenever the games change. */
export function useFocus(games: GameReport[] | null): { focus: Focus | null; moved: string | null; loaded: boolean } {
  const [res, setRes] = useState<{ focus: Focus | null; moved: string | null; loaded: boolean }>({ focus: null, moved: null, loaded: false });
  const stamp = games ? games.map((g) => `${g.metrics.matchId}:${g.findings?.length ?? "-"}`).join("|") : "";
  useEffect(() => {
    let alive = true;
    (coach().focusGet?.() ?? Promise.resolve({ ok: false as const, error: "" })).then((r) => alive && setRes(r.ok ? { ...r.value, loaded: true } : { focus: null, moved: null, loaded: true }));
    return () => {
      alive = false;
    };
  }, [stamp]);
  return res;
}

function Dots({ graded }: { graded: FocusGame[] }) {
  const last = graded.slice(0, FOCUS_LAST).reverse();
  const empty = Math.max(0, FOCUS_LAST - last.length);
  return (
    <div className="focus-dots" aria-label={`${last.filter((g) => g.held).length} of the last ${last.length} games held`}>
      {last.map((g) => (
        <span key={g.matchId} className={g.held ? "focus-dot held" : "focus-dot broke"} title={`${champName(g.champion)}: ${g.count} counted, ${g.held ? "held" : "not held"}`}>
          {g.held ? <Check size={13} /> : <X size={13} />}
        </span>
      ))}
      {Array.from({ length: empty }, (_, i) => (
        <span key={i} className="focus-dot" />
      ))}
    </div>
  );
}

/** The one thing to do next game: the rule, when to ask it, the pass line and how it is going. */
export function FocusCard({ games, unread, onReview, onRead }: { games: GameReport[]; unread: number; onReview: (matchId: string) => void; onRead?: () => void }) {
  const { focus, moved, loaded } = useFocus(games);
  if (!loaded) return null;
  if (!focus) {
    const anyRead = games.some((g) => Array.isArray(g.findings));
    return (
      <section className="focus-card empty">
        <span className="eyebrow accent icon-eyebrow"><Target size={13} /> Your focus</span>
        <h2>{anyRead ? "Nothing costly was measured in your read games." : "Your focus comes from your replays."}</h2>
        <p className="muted">
          {anyRead
            ? "Keep playing: each ranked game's replay is read by itself, and the first thing that costs you becomes the focus."
            : "After each ranked game the app reads the replay by itself and closes it. The costliest thing it measures becomes the one rule for your next game."}
        </p>
        {!anyRead && onRead && unread > 0 && (
          <Button variant="primary" onClick={onRead}>
            Read my last game now
          </Button>
        )}
      </section>
    );
  }
  const last = focus.graded[0];
  return (
    <section className="focus-card">
      <div className="focus-main">
        <span className="eyebrow accent icon-eyebrow"><Target size={13} /> Your one focus for the next game</span>
        <h2>{focus.title}</h2>
        <p className="focus-rule">{focus.rule}</p>
        <p className="focus-cue">{focus.cue}</p>
        {moved && <p className="focus-moved">“{moved}” held in {FOCUS_HOLD} of your last {FOCUS_LAST} games, so this is the next one.</p>}
      </div>
      <div className="focus-side">
        <div>
          <span className="eyebrow">Why this</span>
          <p>{focus.why}</p>
        </div>
        <div>
          <span className="eyebrow">A game passes with</span>
          <p>{focus.pass}</p>
        </div>
        <div>
          <span className="eyebrow">Since you started</span>
          <Dots graded={focus.graded} />
          <p className="muted">
            {focus.graded.length === 0
              ? `Hold it in ${FOCUS_HOLD} of ${FOCUS_LAST} games and the next focus takes its place.`
              : `${last.held ? "Held" : "Not held"} last game (${last.count} counted). ${focus.needed === 0 ? "" : `${focus.needed} more held ${focus.needed === 1 ? "game" : "games"} to move on.`}`}
          </p>
        </div>
        {focus.worst && (
          <Button variant="ghost" onClick={() => onReview(focus.worst!.matchId)}>
            <Play size={13} fill="currentColor" /> See the costliest one: {focus.worst.title}
          </Button>
        )}
      </div>
    </section>
  );
}
