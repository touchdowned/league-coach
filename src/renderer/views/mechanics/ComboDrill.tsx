import { useEffect, useMemo, useRef, useState } from "react";
import type { Combo, ComboInput, Kit } from "../../../core/mechanics/kits";
import { ComboResult, comboTargetMs, gradeCombo, interleave, SET_LENGTH, Staircase, stepStair } from "../../../core/mechanics/plan";
import { rng } from "../../../core/mechanics/sim";
import { ProgressBar } from "../../ui";
import { spellIcon, useDdVersion } from "./useKit";
import type { SetSummary } from "./types";

const LABEL: Record<ComboInput, string> = { Q: "Q", W: "W", E: "E", R: "R", AA: "Auto", F: "Flash" };

/**
 * Combos: press the shown sequence as fast as you cleanly can. Right-click is an
 * auto-attack, F or D is Flash. The target time tightens as you hit it.
 */
export function ComboDrill({ kit, stair, onDone }: { kit: Kit; stair: Staircase; onDone: (s: SetSummary) => void }) {
  const order = useMemo(() => interleave(kit.combos, SET_LENGTH.combo, rng(Date.now() & 0xffff)), [kit]);
  const v = useDdVersion();
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState<{ input: ComboInput; t: number }[]>([]);
  const [result, setResult] = useState<ComboResult | null>(null);
  const [level, setLevel] = useState(stair.level);
  const s = useRef({ stair, results: [] as ComboResult[], durations: [] as number[] });
  const combo: Combo | undefined = order[i];
  const target = combo ? comboTargetMs(combo, level) : 0;
  const pad = useRef<HTMLDivElement>(null);

  useEffect(() => pad.current?.focus(), []);

  useEffect(() => {
    if (!combo || result) return;
    let typedNow: { input: ComboInput; t: number }[] = [];
    let over = false;
    const push = (input: ComboInput) => {
      if (over) return;
      typedNow = [...typedNow, { input, t: performance.now() }];
      setTyped(typedNow);
      const wrong = typedNow.some((n, k) => n.input !== combo.inputs[k]);
      if (wrong || typedNow.length === combo.inputs.length) {
        over = true;
        finish(typedNow);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toUpperCase();
      if (k === "Q" || k === "W" || k === "E" || k === "R") push(k);
      else if (k === "F" || k === "D") push("F");
      else return;
      e.preventDefault();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 2) push("AA");
    };
    const noMenu = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("contextmenu", noMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("contextmenu", noMenu);
    };
    // finish is stable enough: it only reads refs and the current combo.
  }, [combo, result]);

  function finish(attempt: { input: ComboInput; t: number }[]) {
    if (!combo) return;
    const r = gradeCombo(combo, { inputs: attempt.map((a) => a.input), times: attempt.map((a) => a.t) }, s.current.stair.level);
    s.current.stair = stepStair(s.current.stair, r.withinTarget);
    s.current.results.push(r);
    if (r.correct) s.current.durations.push(r.durationMs);
    setResult(r);
    setTimeout(() => {
      const done = s.current.results.length >= order.length;
      if (done) {
        const clean = s.current.results.filter((x) => x.withinTarget).length;
        const correct = s.current.results.filter((x) => x.correct).length;
        const d = s.current.durations;
        const avg = d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0;
        onDone({
          drill: "combo",
          score: clean / s.current.results.length,
          detail: avg,
          stair: s.current.stair,
          lines: [
            `${clean} of ${s.current.results.length} clean and on time`,
            `${correct} in the right order`,
            avg ? `Average ${Math.round(avg)} ms per combo` : "No complete combos yet",
            `Difficulty level ${s.current.stair.level} of 20`,
          ],
        });
        return;
      }
      setLevel(s.current.stair.level);
      setTyped([]);
      setResult(null);
      setI((n) => n + 1);
    }, r.correct ? 900 : 1300);
  }

  if (!combo) return <p className="muted">No combos for this champion yet.</p>;
  const ability = (k: ComboInput) => kit.abilities.find((a) => a.key === k);

  return (
    <div className="drill" ref={pad} tabIndex={-1}>
      <div className="drill-hud">
        <span>
          Combo <b>{i + 1}</b>/{order.length}
        </span>
        <span>
          Level <b>{level}</b>
        </span>
        <span>
          Target <b>{target} ms</b>
        </span>
      </div>
      <div className="combo-stage">
        <p className="eyebrow accent">{combo.name}</p>
        <p className="muted">{combo.use}</p>
        <div className="combo-row">
          {combo.inputs.map((input, k) => {
            const got = typed[k];
            const state = !got ? "" : got.input === input ? "ok" : "bad";
            const a = ability(input);
            const gap = k > 0 && got && typed[k - 1] ? Math.round(got.t - typed[k - 1].t) : null;
            const slow = result?.slowestGapAt === k && result.correct;
            return (
              <div key={k} className={`combo-key ${state} ${k === typed.length && !result ? "next" : ""}`}>
                {a?.icon && v ? <img src={spellIcon(v, a.icon)} alt="" /> : <span className="combo-glyph">{input === "AA" ? "AA" : input === "F" ? "F" : input}</span>}
                <span className="combo-label">{a && a.name !== a.key ? a.name : LABEL[input]}</span>
                {gap !== null && <span className={`combo-gap ${slow ? "slow" : ""}`}>+{gap} ms</span>}
              </div>
            );
          })}
        </div>
        {result ? (
          <p className={result.withinTarget ? "pos" : "neg"}>
            {!result.correct
              ? `Wrong input at step ${result.wrongAt + 1}: expected ${LABEL[combo.inputs[result.wrongAt]]}.`
              : result.withinTarget
                ? `Clean: ${Math.round(result.durationMs)} ms.`
                : `Right order, ${Math.round(result.durationMs - target)} ms over target. Biggest pause before step ${result.slowestGapAt + 1}.`}
          </p>
        ) : (
          <p className="muted small">The timer starts on your first input. Right-click for an auto, F or D for Flash.</p>
        )}
        {result?.correct && <ProgressBar value={Math.min(1, target / Math.max(1, result.durationMs))} tone={result.withinTarget ? "good" : "accent"} thin />}
      </div>
    </div>
  );
}
