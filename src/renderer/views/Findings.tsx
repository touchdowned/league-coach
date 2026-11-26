import { Crosshair } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { fmtTime } from "../../core/analysis";
import type { Focus } from "../../core/focus";
import type { Finding } from "../../core/synth";
import { coach } from "../api";

const KIND: Record<Finding["kind"], string> = { recall: "Recall", exposure: "Jungler", fight: "Fight", objective: "Objective", death: "Death" };

/**
 * Module 3's findings for one game: the moment, the telemetry behind it, what it cost and
 * the fix, each with a button that seeks the open replay to a few seconds before it.
 */
export function Findings({ findings, matchId, replayOpen, onNeedReplay, focus }: { findings: Finding[]; matchId?: string; replayOpen: boolean; onNeedReplay: () => Promise<boolean>; focus?: Focus | null }) {
  const [open, setOpen] = useState<string | null>(findings[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const jump = async (f: Finding) => {
    setBusy(f.id);
    try {
      if (!replayOpen && !(await onNeedReplay())) return;
      const res = await coach().replaySeek(f.jump.t / 1000, true);
      if (!res.ok || !res.value) return void toast.error("Couldn't move the replay", { description: res.ok ? "The replay window didn't answer. Is the replay still open?" : res.error });
      await coach().replayFollow(f.jump.follow);
      // The app steps aside and the finding rides along on the replay.
      const shown = matchId ? await coach().overlayFinding?.(matchId, f.id) : null;
      if (!shown?.ok) toast.success(`Replay at ${fmtTime(f.jump.t)}, paused`, { description: `The moment is at ${f.time}. Press space in the replay to play.` });
    } finally {
      setBusy(null);
    }
  };
  // This game against the focus: graded if it was played after the focus was set, else one of the games it came from.
  const mine = focus ? findings.filter((f) => f.kind === focus.key).sort((a, b) => a.t - b.t) : [];
  const grade = focus?.graded.find((g) => g.matchId === matchId) ?? null;
  const minions = findings.reduce((a, f) => a + f.minions, 0);
  const gold = findings.reduce((a, f) => a + f.gold, 0);
  const xp = findings.reduce((a, f) => a + f.xp, 0);
  return (
    <section className="findings">
      <header className="findings-head">
        <div>
          <span className="eyebrow accent">Read from your replay</span>
          <h2>{findings.length} findings</h2>
        </div>
        <p className="muted">
          Counted across them: {Math.round(minions)} minions, {xp} XP, {gold} gold. Costliest first.
        </p>
      </header>
      {focus && (grade || mine.length > 0) && (
        <div className={`focus-grade ${grade ? (grade.held ? "held" : "broke") : ""}`}>
          <div>
            <span className="eyebrow accent">Your focus: {focus.title}</span>
            <strong>
              {grade
                ? grade.held
                  ? `Held this game: ${grade.count} counted, the pass line is ${focus.target}.`
                  : `Not held this game: ${grade.count} counted, the pass line is ${focus.target}.`
                : `${mine.length} of the cases that made this your focus ${mine.length === 1 ? "is" : "are"} in this game.`}
            </strong>
            <p className="muted">{focus.rule}</p>
          </div>
          {mine.length > 0 && (
            <div className="focus-grade-jumps">
              {mine.map((f) => (
                <button key={f.id} className="finding-jump" onClick={() => (setOpen(f.id), jump(f))} disabled={busy === f.id}>
                  <Crosshair size={14} /> {f.time}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <ol className="findings-list">
        {findings.map((f) => {
          const on = open === f.id;
          return (
            <li key={f.id} className={on ? "finding on" : "finding"}>
              <div className="finding-row">
                <button className="finding-toggle" onClick={() => setOpen(on ? null : f.id)} aria-expanded={on}>
                  <span className="finding-time">{f.time}</span>
                  <span className={`finding-kind k-${f.kind}`}>{KIND[f.kind]}</span>
                  <span className="finding-title">{f.title}</span>
                </button>
                <button className="finding-jump" onClick={() => jump(f)} disabled={busy === f.id} title={`Seek the replay to ${fmtTime(f.jump.t)}`}>
                  <Crosshair size={14} /> {busy === f.id ? "Opening" : `Jump to ${fmtTime(f.jump.t)}`}
                </button>
              </div>
              {on && (
                <div className="finding-body">
                  <div>
                    <span className="eyebrow">Proof</span>
                    <ul>
                      {f.proof.map((p, i) => (
                        <li key={i}>{p}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <span className="eyebrow">Cost</span>
                    <p className="finding-cost">{f.cost}</p>
                    <span className="eyebrow accent">Do this instead</span>
                    <p className="finding-fix">{f.fix}</p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
