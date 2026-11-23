import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { toast } from "sonner";
import { DAILY, dayKey, EMPTY_PROGRESS, levelOf, liveStreak, ProgressEvent, ProgressState } from "../core/progress";
import { coach } from "./api";
import { Ring } from "./ui";

interface Ctx {
  state: ProgressState;
  award: (e: ProgressEvent) => Promise<number>;
}

const ProgressCtx = createContext<Ctx>({ state: EMPTY_PROGRESS, award: async () => 0 });
export const useProgress = () => useContext(ProgressCtx);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProgressState>(EMPTY_PROGRESS);
  const [levelUp, setLevelUp] = useState<number | null>(null);

  useEffect(() => {
    coach().getProgress().then(setState);
  }, []);

  const award = useCallback(async (e: ProgressEvent) => {
    const r = await coach().progressEvent(e);
    setState(r.state);
    if (r.gained > 0) {
      toast(`+${r.gained} XP`, {
        description: r.dailyJustCompleted ? "Daily training complete. +100 bonus." : r.streakExtended && r.state.streak > 1 ? `${r.state.streak} day streak` : undefined,
        className: "xp-toast",
        duration: 1800,
      });
    }
    if (r.leveledUp) setLevelUp(levelOf(r.state.xp).level);
    return r.gained;
  }, []);

  return (
    <ProgressCtx.Provider value={{ state, award }}>
      {children}
      {levelUp !== null && <LevelUp level={levelUp} onClose={() => setLevelUp(null)} />}
    </ProgressCtx.Provider>
  );
}

function LevelUp({ level, onClose }: { level: number; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3200);
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", k);
    };
  }, [onClose]);
  return (
    <div className="levelup-backdrop" onClick={onClose}>
      <div className="levelup">
        <div className="confetti" aria-hidden>
          {Array.from({ length: 18 }, (_, i) => (
            <i key={i} style={{ ["--i" as string]: i }} />
          ))}
        </div>
        <small>Level up</small>
        <strong>{level}</strong>
        <p>Keep training. Each level is about a day of focused review.</p>
      </div>
    </div>
  );
}

/** Compact player card for the sidebar: level ring, XP bar, streak, daily targets. */
export function PlayerCard({ name }: { name: string }) {
  const { state } = useProgress();
  const lvl = levelOf(state.xp);
  const streak = liveStreak(state);
  const today = state.today.date === dayKey(new Date()) ? state.today : { moments: 0, puzzles: 0 };
  return (
    <div className="player-card">
      <div className="player-top">
        <Ring value={lvl.into / lvl.needed} size={42} stroke={3.5} tone="xp">
          <b>{lvl.level}</b>
        </Ring>
        <div className="player-meta">
          <strong>{name || "Set up your account"}</strong>
          <small>
            {lvl.into} / {lvl.needed} XP
          </small>
        </div>
        <span className={`streak ${streak > 0 ? "on" : ""}`} title={`${streak} day streak`}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M8 1c1 3 4 4.5 4 8.2A4 4 0 0 1 8 15a4 4 0 0 1-4-5.8C4.6 7.8 6 7 6 5c1 .7 1.6 1.6 1.7 2.6C8.6 6 8.5 3.5 8 1Z" fill="currentColor" />
          </svg>
          {streak}
        </span>
      </div>
      <div className="daily">
        <Daily label="Moments" value={today.moments} goal={DAILY.moments} />
        <Daily label="Puzzles" value={today.puzzles} goal={DAILY.puzzles} />
      </div>
    </div>
  );
}

function Daily({ label, value, goal }: { label: string; value: number; goal: number }) {
  const done = value >= goal;
  return (
    <div className={`daily-item ${done ? "done" : ""}`}>
      <Ring value={value / goal} size={22} stroke={3} tone={done ? "good" : "accent"} />
      <span>
        {label} <b>{Math.min(value, goal)}/{goal}</b>
      </span>
    </div>
  );
}
