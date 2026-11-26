import { Check, ChevronRight, X } from "lucide-react";
import { DAILY, dayKey, ProgressState } from "../core/progress";
import type { GameReport } from "../core/types";

export type SessionStep = "review" | "puzzles" | "mechanics";

export const STEPS: { id: SessionStep; label: string; goal: string }[] = [
  { id: "review", label: "Review", goal: `${DAILY.moments} moments from your games` },
  { id: "puzzles", label: "Puzzles", goal: `${DAILY.puzzles} puzzles on your focus` },
  { id: "mechanics", label: "Lane lab", goal: "1 set as a warm-up" },
];

export function todayOf(p: ProgressState) {
  return p.today.date === dayKey(new Date()) ? p.today : { date: "", moments: 0, puzzles: 0, puzzlesRight: 0, drills: 0 };
}

export function stepDone(step: SessionStep, p: ProgressState): boolean {
  const t = todayOf(p);
  if (step === "review") return t.moments >= DAILY.moments;
  if (step === "puzzles") return t.puzzles >= DAILY.puzzles;
  return (t.drills ?? 0) >= 1;
}

export function stepProgress(step: SessionStep, p: ProgressState): string {
  const t = todayOf(p);
  if (step === "review") return `${Math.min(t.moments, DAILY.moments)}/${DAILY.moments}`;
  if (step === "puzzles") return `${Math.min(t.puzzles, DAILY.puzzles)}/${DAILY.puzzles}`;
  return `${Math.min(t.drills ?? 0, 1)}/1`;
}

export const firstOpenStep = (p: ProgressState) => STEPS.find((s) => !stepDone(s.id, p))?.id ?? null;

/** Pinned bar while today's training runs: where you are, and one button to the next step. */
export function SessionBar({ progress, current, onGo, onEnd }: { progress: ProgressState; current: SessionStep; games: GameReport[]; onGo: (s: SessionStep) => void; onEnd: () => void }) {
  const next = firstOpenStep(progress);
  const allDone = next === null;
  const ready = stepDone(current, progress) && next !== current;
  return (
    <div className={`session-bar ${ready || allDone ? "ready" : ""}`}>
      <span className="session-title">Today's training</span>
      <ol>
        {STEPS.map((s, i) => {
          const done = stepDone(s.id, progress);
          return (
            <li key={s.id} className={`${done ? "done" : ""} ${s.id === current ? "on" : ""}`}>
              <span className="session-dot">{done ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
              {s.label}
              <small>{stepProgress(s.id, progress)}</small>
            </li>
          );
        })}
      </ol>
      {allDone ? (
        <button className="session-next" onClick={onEnd}>
          Done for today <Check size={14} />
        </button>
      ) : ready && next ? (
        <button className="session-next" onClick={() => onGo(next)}>
          Next: {STEPS.find((s) => s.id === next)!.label} <ChevronRight size={14} />
        </button>
      ) : (
        <span className="session-goal">{STEPS.find((s) => s.id === current)!.goal}</span>
      )}
      <button className="session-x" onClick={onEnd} aria-label="End session">
        <X size={14} />
      </button>
    </div>
  );
}
