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
      <span className="focus-dot next">Next focus</span>
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
      <div className="focus-top">
        <div>
          <span className="eyebrow accent icon-eyebrow"><Target size={13} /> Your one focus for the next game</span>
          <h2>{focus.title}</h2>
          <p className="focus-rule">{focus.rule}</p>
          <p className="focus-cue">{focus.cue}</p>
          {moved && <p className="focus-moved">“{moved}” held in {FOCUS_HOLD} of your last {FOCUS_LAST} games, so this is the next one.</p>}
        </div>
        <div className="focus-art">
          <FocusArt kind={focus.key} />
        </div>
      </div>
      {focus.worst && (
        <div className="focus-actions">
          <Button variant="primary" size="lg" onClick={() => onReview(focus.worst!.matchId)}>
            <Play size={15} fill="currentColor" /> Watch your costliest one
          </Button>
          <span className="muted">{focus.worst.title}</span>
        </div>
      )}
      <div className="focus-bottom">
        <div>
          <span className="eyebrow">Why this</span>
          <p>{focus.why}</p>
        </div>
        <div>
          <span className="eyebrow">A game passes with</span>
          <p>{focus.pass}</p>
        </div>
        <div>
          <span className="eyebrow">Your games since</span>
          <Dots graded={focus.graded} />
          <p>
            {focus.graded.length === 0
              ? `Hold it in ${FOCUS_HOLD} of ${FOCUS_LAST} games and the next focus unlocks.`
              : `${last.held ? "Held" : "Not held"} last game (${last.count} counted). ${focus.needed === 0 ? "" : `${focus.needed} more held ${focus.needed === 1 ? "game" : "games"} to unlock the next focus.`}`}
          </p>
        </div>
      </div>
    </section>
  );
}

/** A small picture of the rule: your lane, drawn the same way for every focus. Blue is you, red is them. */
function FocusArt({ kind }: { kind: Focus["key"] }) {
  const you = "#2f6fe0";
  const them = "#d8433f";
  const ink = "#1d1b16";
  const lane = <rect x="20" y="96" width="260" height="34" rx="17" fill="#e2ded4" />;
  const tower = (x: number, c: string) => <rect x={x - 9} y={86} width={18} height={54} rx={5} fill={c} />;
  const dot = (x: number, y: number, c: string, r = 12) => <circle cx={x} cy={y} r={r} fill={c} />;
  const minions = (x: number, c: string, n: number) => Array.from({ length: n }, (_, i) => <circle key={`${c}${x}${i}`} cx={x + i * 13} cy={113} r={5} fill={c} />);
  const label = (x: number, y: number, t: string, c = ink) => (
    <text x={x} y={y} textAnchor="middle" fontSize="13" fontWeight="800" fill={c}>{t}</text>
  );
  return (
    <svg viewBox="0 0 300 220" aria-hidden>
      {lane}
      {tower(34, you)}
      {tower(266, them)}
      {kind === "recall" && (
        <>
          {minions(196, you, 4)}
          {dot(170, 113, you)}
          <path d="M170 92 q-8 -34 -60 -40" fill="none" stroke={you} strokeWidth="4" strokeDasharray="7 7" strokeLinecap="round" />
          {label(96, 46, "then B", you)}
          {label(222, 160, "wave at their tower")}
        </>
      )}
      {kind === "exposure" && (
        <>
          <line x1="150" y1="70" x2="150" y2="156" stroke={ink} strokeWidth="3" strokeDasharray="6 6" />
          {label(150, 60, "middle line")}
          {dot(120, 113, you)}
          <circle cx="216" cy="176" r="15" fill="none" stroke={them} strokeWidth="4" strokeDasharray="5 5" />
          {label(216, 181, "?", them)}
          {label(216, 208, "jungler unseen", them)}
        </>
      )}
      {kind === "fight" && (
        <>
          {dot(126, 113, you)}
          {dot(176, 113, them)}
          {dot(204, 96, them, 9)}
          {label(126, 80, "lv 5", you)}
          {label(182, 72, "lv 6 +1", them)}
          <path d="M112 136 q-30 26 -62 8" fill="none" stroke={you} strokeWidth="4" strokeLinecap="round" />
          {label(84, 176, "walk back", you)}
        </>
      )}
      {kind === "objective" && (
        <>
          <circle cx="150" cy="176" r="22" fill="none" stroke={ink} strokeWidth="4" />
          {label(150, 181, "1:00")}
          {dot(150, 113, you)}
          <path d="M136 104 q-40 -44 -92 -22" fill="none" stroke={you} strokeWidth="4" strokeDasharray="7 7" strokeLinecap="round" />
          {label(84, 58, "recall now", you)}
        </>
      )}
      {kind === "death" && (
        <>
          {minions(64, you, 4)}
          <path d="M120 113 h22" stroke={you} strokeWidth="4" strokeLinecap="round" />
          {dot(170, 113, you)}
          {dot(214, 113, them)}
          {label(88, 160, "wave arriving", you)}
          {label(192, 80, "wait")}
        </>
      )}
    </svg>
  );
}
