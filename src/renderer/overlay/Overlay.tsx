import { Brain, Crosshair, Move, Skull } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { challengeDefs, ChallengeState, deathLesson, mmss } from "../../core/mind";
import { coach, LivePayload } from "../api";
import { ChampIcon } from "../charts";

/**
 * Drawn over League in a transparent, click-through window. Three layers:
 *   the goal panel (always, small, wherever you dragged it),
 *   a nudge line under it for a few seconds when something relevant happens,
 *   and the reset card while you're dead.
 */
export function OverlayApp() {
  const [p, setP] = useState<LivePayload | null>(null);
  useEffect(() => {
    document.body.classList.add("overlay-body");
    return coach().onMindLive(setP);
  }, []);
  if (!p || p.hidden) return p?.editing ? <EditHint /> : null;
  return (
    <div className={`ov-root ${p.editing ? "editing" : ""}`}>
      <GoalPanel p={p} />
      {p.view.isDead && p.view.lastDeath && <ResetCard p={p} />}
      {p.editing && <EditHint />}
    </div>
  );
}

function EditHint() {
  return (
    <div className="ov-edit-hint">
      <Move size={16} aria-hidden /> Drag the panel where it doesn't cover your HUD. <b>Ctrl+Shift+E</b> when done.
      <button className="ov-edit-done" onClick={() => coach().mindEndPreview()}>
        Done
      </button>
    </div>
  );
}

function useDrag(pos: { x: number; y: number } | null | undefined, editing: boolean) {
  const [local, setLocal] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ mx: number; my: number; x: number; y: number } | null>(null);
  const cur = local ?? pos ?? { x: 0.835, y: 0.3 };
  function onPointerDown(e: React.PointerEvent) {
    if (!editing) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { mx: e.clientX, my: e.clientY, x: cur.x, y: cur.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    const s = start.current;
    if (!s) return;
    const x = Math.max(0, Math.min(0.95, s.x + (e.clientX - s.mx) / window.innerWidth));
    const y = Math.max(0, Math.min(0.92, s.y + (e.clientY - s.my) / window.innerHeight));
    setLocal({ x, y });
  }
  function onPointerUp() {
    if (start.current && local) coach().mindSetOverlayPos(local);
    start.current = null;
  }
  return { cur, handlers: { onPointerDown, onPointerMove, onPointerUp } };
}

function GoalPanel({ p }: { p: LivePayload }) {
  const { cur, handlers } = useDrag(p.pos, !!p.editing);
  const v = p.view;
  return (
    <div className="ov-anchor" style={{ left: `min(${cur.x * 100}%, calc(100% - 284px))`, top: `min(${cur.y * 100}%, calc(100% - 320px))` }} {...handlers}>
      <div className="ov-panel">
        <div className="ov-head">
          <FocusDial value={v.focus} />
          <div className="ov-head-text">
            <span className="ov-eyebrow">Focus · {mmss(v.gameTime)}</span>
            <span className="ov-intention">{p.intention || "One goal. Play for it."}</span>
          </div>
          {v.champion && <ChampIcon name={v.champion} size={28} />}
        </div>
        <ChallengeRow c={v.skill} icon="skill" />
        <ChallengeRow c={v.mental} icon="mental" />
        {v.nextObjective && v.nextObjective.inSec <= 90 && (
          <div className="ov-obj">
            {v.nextObjective.name} spawns in <b>{Math.max(0, Math.round(v.nextObjective.inSec))}s</b>
          </div>
        )}
      </div>
      {p.nudges !== false && (
        <div className="ov-nudges">
          {v.nudges.slice(-2).map((n) => (
            <div key={n.key} className={`ov-nudge ${n.tone}`}>
              {n.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<ChallengeState["status"], string> = { pending: "Waiting", "on-track": "On track", "at-risk": "At risk", failed: "Missed", passed: "Done" };

function ChallengeRow({ c, icon }: { c: ChallengeState; icon: "skill" | "mental" }) {
  const Icon = icon === "skill" ? Crosshair : Brain;
  return (
    <div className={`ov-ch ${c.status}`}>
      <div className="ov-ch-top">
        <Icon size={13} strokeWidth={2.2} aria-hidden />
        <span className="ov-ch-title">{c.title}</span>
        <span className="ov-ch-value">{c.value}</span>
      </div>
      <div className="ov-bar">
        <div className="ov-bar-fill" style={{ transform: `scaleX(${c.progress})` }} />
      </div>
      <div className="ov-ch-foot">
        <span className="ov-ch-status">{STATUS_LABEL[c.status]}</span>
        <span className="ov-ch-detail">{c.detail}</span>
      </div>
    </div>
  );
}

function FocusDial({ value }: { value: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const tone = value >= 70 ? "good" : value >= 45 ? "warn" : "bad";
  return (
    <span className={`ov-dial ${tone}`}>
      <svg width={38} height={38}>
        <circle cx={19} cy={19} r={r} className="ov-dial-track" />
        <circle cx={19} cy={19} r={r} className="ov-dial-fill" strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} transform="rotate(-90 19 19)" />
      </svg>
      <span>{value}</span>
    </span>
  );
}

/** While you're dead: what happened, the one fix, a breath, and a focus check-in. */
function ResetCard({ p }: { p: LivePayload }) {
  const v = p.view;
  const d = v.lastDeath!;
  const defs = challengeDefs({ role: v.role, games: 0, cs10: null, deathsPre14: null, visionPerMin: null, killParticipation: null });
  const lesson = deathLesson(d, defs, p.rules?.skillId ?? "deaths14");
  const [picked, setPicked] = useState<number | null>(d.checkIn);
  useEffect(() => setPicked(d.checkIn), [d.checkIn, d.t]);
  return (
    <div className="ov-reset">
      <div className="ov-reset-top">
        <Skull size={16} aria-hidden />
        <span className="ov-reset-cause">{lesson.cause}</span>
        <span className="ov-reset-timer">{v.respawnIn}s</span>
      </div>
      <p className="ov-reset-fix">{lesson.fix}</p>
      <div className="ov-reset-meta">
        {d.killerChamp && d.killerChamp !== "Tower" ? <ChampIcon name={d.killerChamp} size={20} /> : null}
        <span>
          {d.helpers ? `+${d.helpers} helping` : "Solo kill"} · holding {Math.round(d.gold).toLocaleString("en-US")}g{d.jungler ? " · their jungler" : ""}
        </span>
      </div>
      <div className="ov-breath">
        <span className="ov-breath-orb" />
        <span className="ov-breath-text" />
      </div>
      {p.rules && <p className="ov-reset-rule">Next: {p.rules.mental}</p>}
      <div className="ov-checkin">
        <span>How's your head?</span>
        <div className="ov-checkin-keys">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={`ov-key ${picked === n ? "on" : ""}`}>
              {n}
            </span>
          ))}
        </div>
        <small>Ctrl+Shift+number · 1 tilted, 5 locked in</small>
      </div>
    </div>
  );
}
