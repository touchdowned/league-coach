import { ArrowLeft, ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "../../core/analysis";
import type { Finding } from "../../core/synth";
import { coach } from "../api";

const KIND: Record<Finding["kind"], string> = { recall: "Recall", exposure: "Jungler", fight: "Fight", objective: "Objective", death: "Death" };

/**
 * One finding drawn over the League replay, in the transparent overlay window. Jump puts the
 * replay a few seconds before the moment, paused; this card says what to watch for, and steps
 * to the other findings of the game without going back to the app.
 */
export function FindingOverlay({ matchId, findingId }: { matchId: string; findingId: string }) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [id, setId] = useState(findingId);
  const [pb, setPb] = useState<{ time: number; paused: boolean } | null>(null);
  const [small, setSmall] = useState(false);
  const hits = useRef(0);

  useEffect(() => {
    document.body.classList.add("overlay-body");
    coach()
      .listGames()
      .then((gs) => setFindings(gs.find((g) => g.metrics.matchId === matchId)?.findings ?? []));
  }, [matchId]);

  // The replay's clock, so the card can say how far the moment is and what Play will do.
  useEffect(() => {
    const tick = async () => {
      const res = await coach().stagePlayback();
      if (res.ok && res.value) setPb({ time: res.value.time * 1000, paused: res.value.paused });
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, []);

  const f = findings.find((x) => x.id === id);
  const at = findings.findIndex((x) => x.id === id);

  const jump = useCallback(async (x: Finding) => {
    await coach().replaySeek(x.jump.t / 1000, true);
    await coach().replayFollow(x.jump.follow);
    setId(x.id);
  }, []);

  // Space and the arrows work while the mouse is over the card (the window is click-through elsewhere).
  const hit = (on: boolean) => {
    hits.current = Math.max(0, hits.current + (on ? 1 : -1));
    coach().overlayInteractive?.(hits.current > 0);
  };
  const hitProps = { onMouseEnter: () => hit(true), onMouseLeave: () => hit(false) };

  if (!f) return null;
  const until = pb ? f.t - pb.time : null;
  const status = until === null ? "" : until > 1500 ? `The moment is in ${Math.ceil(until / 1000)} s` : until > -8000 ? "This is the moment" : `${fmtTime(f.t)} has passed`;

  return (
    <div className="fo-root">
      <div className={`fo-card ${small ? "small" : ""}`} {...hitProps}>
        <header className="fo-head">
          <span className="fo-time">{f.time}</span>
          <span className={`finding-kind k-${f.kind}`}>{KIND[f.kind]}</span>
          <span className="fo-status">{status}</span>
          <button className="fo-icon" onClick={() => setSmall((v) => !v)} title={small ? "Show the details" : "Hide the details"}>
            {small ? "More" : "Less"}
          </button>
        </header>
        <h3>{f.title}</h3>
        {!small && (
          <>
            <ul className="fo-proof">
              {f.proof.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <p className="fo-cost">{f.cost}</p>
            <div className="fo-fix">
              <span className="eyebrow accent">Do this instead</span>
              <p>{f.fix}</p>
            </div>
          </>
        )}
        <footer className="fo-actions">
          <button className="fo-btn primary" onClick={() => coach().stagePlayback({ paused: !(pb?.paused ?? true) })}>
            {pb?.paused === false ? <><Pause size={14} /> Pause</> : <><Play size={14} fill="currentColor" /> Play</>}
          </button>
          <button className="fo-btn" onClick={() => jump(f)} title={`Back to ${fmtTime(f.jump.t)}, paused`}>
            <RotateCcw size={14} /> From {fmtTime(f.jump.t)}
          </button>
          <span className="fo-spacer" />
          <button className="fo-btn" disabled={at <= 0} onClick={() => jump(findings[at - 1])} title="Previous finding">
            <ChevronLeft size={15} />
          </button>
          <span className="fo-count">
            {at + 1} of {findings.length}
          </span>
          <button className="fo-btn" disabled={at >= findings.length - 1} onClick={() => jump(findings[at + 1])} title="Next finding">
            <ChevronRight size={15} />
          </button>
          <button className="fo-btn" onClick={() => coach().overlayClose(false)}>
            <ArrowLeft size={14} /> League Coach
          </button>
        </footer>
      </div>
    </div>
  );
}
