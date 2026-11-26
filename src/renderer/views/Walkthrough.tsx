/**
 * Guided walkthrough of one game, VOD-review style.
 *
 * The League replay window is streamed into the app (desktop capture of the game
 * window) and driven through the official Replay API: seek, speed, fog, camera. On top
 * of it sit the coach's layers: chapter card, captions synced to game time, a tactical
 * map, world-space arrows, and the pause-and-call decision. Without an open replay the
 * same walkthrough runs on the animated map from Riot's match data.
 */
import { ArrowRight, Check, ChevronLeft, ChevronRight, Eye, EyeOff, FastForward, Pause, Play, RotateCcw, Rewind, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtTime } from "../../core/analysis";
import { cameraLookingAt, heightToFrame, project, type Cam } from "../../core/camera";
import type { GameReport } from "../../core/types";
import { hasVision, lastSeen, visibleAt } from "../../core/vision";
import { buildChapters, type Beat, type Chapter, type Mark, type Pt } from "../../core/walkthrough";
import { minionsAt } from "../../core/waves";
import { hitMark, useOverlayHits } from "../overlayHits";
import { coach, type Playback, type RenderState } from "../api";
import { ChampIcon } from "../charts";
import { useProgress } from "../progress";
import { Rift, toView } from "../rift";
import { Button, Kbd, Spinner } from "../ui";
import { champName } from "../../core/names";

type Phase = "intro" | "lead" | "decide" | "reveal" | "playout" | "debrief";
type Source = "replay" | "map";

// ---------------------------------------------------------------------------
// Clock: one interface over the League replay and the local animated map.

interface Clock {
  /** Current game time in ms (smoothed between polls). */
  now(): number;
  paused(): boolean;
  speed(): number;
  set(body: { time?: number; paused?: boolean; speed?: number }): void;
}

function makeClock(push?: (body: { time?: number; paused?: boolean; speed?: number }) => void) {
  const ref = { time: 0, paused: true, speed: 1, at: performance.now() };
  const now = () => (ref.paused ? ref.time : ref.time + (performance.now() - ref.at) * ref.speed);
  return {
    ref,
    now,
    paused: () => ref.paused,
    speed: () => ref.speed,
    set: (body: { time?: number; paused?: boolean; speed?: number }) => {
      const t = body.time != null ? body.time * 1000 : now();
      Object.assign(ref, { time: t, paused: body.paused ?? ref.paused, speed: body.speed ?? ref.speed, at: performance.now() });
      push?.(body);
    },
    /** Take the replay's own report (polled). */
    sync: (pb: Playback) => Object.assign(ref, { time: pb.time * 1000, paused: pb.paused, speed: pb.speed ?? ref.speed, at: performance.now() }),
  };
}

function useReplayClock(active: boolean): Clock & { ok: boolean } {
  const clock = useMemo(() => makeClock((body) => void coach().stagePlayback(body)), []);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let lastSet = 0;
    const origSet = clock.set;
    // Ignore polls that raced a command we just sent.
    clock.set = (b) => {
      lastSet = performance.now();
      origSet(b);
    };
    const tick = async () => {
      const r = await coach().stagePlayback();
      if (!alive) return;
      if (r.ok && r.value) {
        if (performance.now() - lastSet > 400) clock.sync(r.value);
        setOk(true);
      } else setOk(false);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => {
      alive = false;
      clearInterval(id);
      clock.set = origSet;
    };
  }, [active, clock]);
  return useMemo(() => Object.assign(clock, { ok }), [clock, ok]);
}

function useLocalClock(): Clock {
  return useMemo(() => makeClock(), []);
}

/** Re-renders every animation frame while `on`, returning the clock's time. */
function useFrameTime(clock: Clock, on: boolean): number {
  const [t, setT] = useState(() => clock.now());
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const loop = () => {
      setT(clock.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on, clock]);
  return t;
}

/** The live camera, polled while world-space marks are on screen. */
function useCamera(active: boolean): Cam | null {
  const [cam, setCam] = useState<Cam | null>(null);
  useEffect(() => {
    if (!active) {
      setCam(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      const r = await coach().stageRender();
      if (!alive || !r.ok || !r.value) return;
      const v = r.value as RenderState;
      if (v.cameraPosition && v.cameraRotation) setCam({ pos: v.cameraPosition, rot: v.cameraRotation, fov: v.fieldOfView ?? 40 });
    };
    tick();
    const id = setInterval(tick, 66);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [active]);
  return cam;
}

// ---------------------------------------------------------------------------

export function Walkthrough({ r, source, onExit, onFinished }: { r: GameReport; source: Source; onExit: () => void; onFinished: () => void }) {
  const chapters = useMemo(() => buildChapters(r), [r]);
  const { award } = useProgress();
  const me = r.metrics.champion;
  const vision = hasVision(r.waves, r.teamId);
  const live = source === "replay";
  const replayClock = useReplayClock(live);
  const localClock = useLocalClock();
  const clock = live ? replayClock : localClock;

  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("intro");
  const [pick, setPick] = useState<number | null>(null);
  const [fogOff, setFogOff] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [score, setScore] = useState<{ good: number; total: number }>({ good: 0, total: 0 });
  const ch = chapters[idx];
  const t = useFrameTime(clock, true);

  // ---- Replay commands ----
  const render = useCallback((body: Record<string, unknown>) => (live ? coach().stageRender(body) : Promise.resolve(null)), [live]);
  // The main process keeps the camera on me while the replay plays (see startFollow).
  const follow = useCallback(() => (live ? coach().replayFollowStart(me) : Promise.resolve(null)), [live, me]);
  useEffect(() => () => void (live && coach().replayFollowStop()), [live]);
  const frame = useCallback(
    (a: Pt, b: Pt | null) => {
      if (!live) return;
      const mid = b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a;
      coach().stageGlide({ ...cameraLookingAt(mid, b ? heightToFrame(a, b) : 2300), fieldOfView: 40 }, 900);
    },
    [live],
  );
  useEffect(() => {
    if (live) render({ fogOfWar: !fogOff });
  }, [fogOff, live, render]);
  // Tidy League's own interface so ours reads first; restore it on the way out.
  useEffect(() => {
    if (!live) return;
    let original: RenderState | null = null;
    coach()
      .stageRender()
      .then((x) => {
        original = x.ok ? x.value : null;
        render({ interfaceChat: false, interfaceTimeline: false, interfaceReplay: false, interfaceTarget: false, interfaceAnnounce: false, interfaceKillCallouts: false, interfaceQuests: false });
      });
    return () => {
      coach().stagePlayback({ paused: true });
      if (original) coach().stageRender(original);
    };
  }, [live, render]);

  useOverlayHits(live);
  // On a question, its answer and the debrief the replay is paused and waiting for you: the
  // overlay takes the whole mouse and the answer keys, so a pick can't fall through to League.
  useEffect(() => {
    if (!live) return;
    const keys = phase === "decide" ? ["1", "2", "3", "4"] : phase === "reveal" || phase === "debrief" ? ["Return"] : null;
    coach().overlayModal?.(!!keys, keys ?? []);
    return () => void coach().overlayModal?.(false, []);
  }, [live, phase, idx]);
  useEffect(() => {
    if (!live) return;
    return coach().onOverlayKey?.((key) => window.dispatchEvent(new KeyboardEvent("keydown", { key: key === "Return" ? "Enter" : key })));
  }, [live]);

  // ---- Chapter flow ----
  const startChapter = useCallback(
    (i: number) => {
      const c = chapters[i];
      if (!c) return;
      setIdx(i);
      setPick(null);
      setFogOff(false);
      setPhase("intro");
      clock.set({ time: c.start / 1000, paused: true, speed: 1 });
      follow();
    },
    [chapters, clock, follow],
  );
  useEffect(() => {
    if (chapters.length) startChapter(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters.length]);

  // Intro card holds for a beat, then the lead-up plays.
  useEffect(() => {
    if (phase !== "intro") return;
    const id = setTimeout(() => {
      setPhase("lead");
      clock.set({ paused: false, speed: 1 });
    }, 2200);
    return () => clearTimeout(id);
  }, [phase, idx, clock]);

  // Freeze on the decision; play out to the end.
  useEffect(() => {
    if (!ch) return;
    if (phase === "lead" && t >= ch.root) {
      clock.set({ time: ch.root / 1000, paused: true });
      setPhase("decide");
      if (live) coach().overlayFocus?.();
    } else if (phase === "playout") {
      // Speed through quiet stretches, real time near the outcome.
      const toOutcome = ch.outcome - t;
      const want = toOutcome > 12_000 ? 2 : 1;
      if (!clock.paused() && Math.abs(clock.speed() - want) > 0.01) clock.set({ speed: want });
      if (t >= ch.end) {
        clock.set({ paused: true });
        setPhase("debrief");
      }
    }
  }, [t, phase, ch, clock, live]);

  const choose = useCallback(
    (i: number) => {
      if (!ch || phase !== "decide") return;
      setPick(i);
      setPhase("reveal");
      const good = ch.choices[i]?.good ?? false;
      setScore((s) => ({ good: s.good + (good ? 1 : 0), total: s.total + 1 }));
      award({ type: "puzzle", right: good });
      // Show what was really there: fog off, frame the better play.
      setFogOff(true);
      if (ch.better.from) frame(ch.better.from, ch.better.to);
    },
    [ch, phase, award, frame],
  );

  const playOut = useCallback(() => {
    if (!ch) return;
    setPhase("playout");
    setFogOff(false);
    follow();
    clock.set({ time: ch.root / 1000, paused: false, speed: 1 });
  }, [ch, clock, follow]);

  const next = useCallback(async () => {
    if (!ch) return;
    setDone((d) => new Set(d).add(ch.id));
    await award({ type: "moment", id: ch.id });
    if (idx + 1 >= chapters.length) {
      clock.set({ paused: true });
      onFinished();
    } else startChapter(idx + 1);
  }, [ch, idx, chapters.length, award, startChapter, clock, onFinished]);

  // Skipping a question moves on without counting it as reviewed (no XP for it).
  const skip = useCallback(() => {
    if (idx + 1 >= chapters.length) {
      clock.set({ paused: true });
      onFinished();
    } else startChapter(idx + 1);
  }, [idx, chapters.length, startChapter, clock, onFinished]);

  const togglePause = useCallback(() => {
    if (phase === "decide" || phase === "reveal" || phase === "intro") return;
    if (phase === "debrief") return startChapter(idx);
    clock.set({ paused: !clock.paused() });
  }, [phase, clock, startChapter, idx]);

  const nudge = useCallback(
    (ms: number) => {
      if (!ch) return;
      const to = Math.max(ch.start, Math.min(ch.end, clock.now() + ms));
      clock.set({ time: to / 1000 });
      if (phase === "debrief" && to < ch.end) setPhase("playout");
    },
    [ch, clock, phase],
  );

  // Keyboard
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (phase === "decide" && /^[1-4]$/.test(e.key)) return choose(Number(e.key) - 1);
      if (e.key === " ") {
        e.preventDefault();
        return togglePause();
      }
      if (e.key === "Enter") {
        if (phase === "reveal") return playOut();
        if (phase === "debrief") return void next();
      }
      if (e.key === "ArrowLeft") return nudge(-5000);
      if (e.key === "ArrowRight") return nudge(5000);
      if (e.key === "f" || e.key === "F") return setFogOff((f) => !f);
      if (e.key === "r" || e.key === "R") return startChapter(idx);
      if (e.key === "Escape") return onExit();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [phase, choose, togglePause, playOut, next, nudge, startChapter, idx, onExit]);

  if (!ch) return null;
  const beat = currentBeat(ch, t, phase);
  const marks = visibleMarks(ch, phase, beat);
  const paused = clock.paused();

  return (
    <div className={`wt ${live ? "overlay" : ""}`}>
      <div className="wt-main">
        <Stage
          r={r}
          ch={ch}
          t={t}
          live={live}
          phase={phase}
          beat={beat}
          marks={marks}
          fogOff={fogOff}
          vision={vision}
          me={me}
          idx={idx}
          count={chapters.length}
        >
          {phase === "decide" && <DecisionCard ch={ch} onPick={choose} onSkip={skip} />}
          {phase === "reveal" && pick !== null && <RevealCard ch={ch} pick={pick} onPlay={playOut} />}
          {phase === "debrief" && <DebriefCard ch={ch} last={idx + 1 >= chapters.length} onReplay={() => startChapter(idx)} onNext={next} />}
        </Stage>

        <div className="wt-scrub-wrap" {...(live ? hitMark : {})}>
          <Scrubber ch={ch} t={t} onSeek={(ms) => clock.set({ time: ms / 1000 })} />
        </div>

        <div className="wt-transport" {...(live ? hitMark : {})}>
          <button className="wt-ctl" onClick={() => nudge(-5000)} title="Back 5s (←)"><Rewind size={16} /></button>
          <button className="wt-ctl primary" onClick={togglePause} disabled={phase === "decide" || phase === "reveal"} title="Play / pause (Space)">
            {paused || phase === "debrief" ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
          </button>
          <button className="wt-ctl" onClick={() => nudge(5000)} title="Forward 5s (→)"><FastForward size={16} /></button>
          <span className="wt-clock">{fmtTime(t)}</span>
          <span className="wt-spacer" />
          {(live || vision) && (
            <button className={`wt-chip ${fogOff ? "on" : ""}`} onClick={() => setFogOff((f) => !f)} title="Your team's vision or everything (F)">
              {fogOff ? <><EyeOff size={14} /> Fog off</> : <><Eye size={14} /> Your vision</>}
            </button>
          )}
          <button className="wt-chip" onClick={() => startChapter(idx)} title="Replay this chapter (R)"><RotateCcw size={14} /> Rewatch</button>
          <span className="hint"><Kbd>Space</Kbd> <Kbd>←</Kbd><Kbd>→</Kbd> <Kbd>F</Kbd></span>
        </div>
      </div>

      <aside className="wt-rail" {...(live ? hitMark : {})}>
        <div className="wt-rail-head">
          <ChampIcon name={me} size={40} />
          <div>
            <strong>{me}{r.metrics.opponentChampion ? <span className="muted"> vs {champName(r.metrics.opponentChampion)}</span> : null}</strong>
            <small className={r.metrics.win ? "win" : "loss"}>{r.metrics.win ? "Victory" : "Defeat"} · {r.metrics.kills}/{r.metrics.deaths}/{r.metrics.assists}</small>
          </div>
          <button className="wt-x" onClick={onExit} title="Close (Esc)"><X size={16} /></button>
        </div>
        <p className="eyebrow">Chapters, costliest first</p>
        <ol className="wt-chapters">
          {chapters.map((c, i) => (
            <li key={c.id}>
              <button className={`wt-chapter ${i === idx ? "on" : ""} ${done.has(c.id) ? "done" : ""}`} onClick={() => startChapter(i)}>
                <span className="wt-num">{done.has(c.id) ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
                <span className="wt-chapter-body">
                  <b>{c.label}</b>
                  <small>{done.has(c.id) || i < idx ? c.headline : kindHint(c)}</small>
                </span>
                <span className={`wt-cost ${c.cost >= 600 ? "hi" : c.cost >= 300 ? "mid" : "lo"}`}>{c.cost.toLocaleString("en-US")}g</span>
              </button>
            </li>
          ))}
        </ol>
        {score.total > 0 && (
          <div className="wt-score">
            <span>Your calls</span>
            <b>{score.good}/{score.total}</b>
          </div>
        )}
        {!vision && (
          <p className="wt-note">
            Vision isn't read for this game yet, so "what you could see" comes from Riot's match data. Read the replay on the review page to get your real minimap.
          </p>
        )}
      </aside>
    </div>
  );
}

function kindHint(c: Chapter): string {
  return { death: "A death, and the call that led to it", recall: "A recall, and when it should have been", objective: "An objective given up", roam: "A roam that didn't pay", farm: "Farm leaking in lane" }[c.kind];
}

function currentBeat(ch: Chapter, t: number, phase: Phase): Beat | null {
  if (phase === "intro") return null;
  const upTo = phase === "decide" || phase === "reveal" ? ch.root : t;
  let b: Beat | null = null;
  for (const x of ch.beats) if (x.t <= upTo + 50) b = x;
  return b;
}

function visibleMarks(ch: Chapter, phase: Phase, beat: Beat | null): Mark[] {
  if (phase === "reveal") {
    const out: Mark[] = [...(ch.beats.find((b) => b.kind === "decision")?.marks ?? []).filter((m) => m.kind !== "path" || m.tone !== "better")];
    if (ch.better.from && ch.better.to) out.push({ kind: "path", from: ch.better.from, to: ch.better.to, tone: "better", label: ch.better.label });
    if (ch.better.to) out.push({ kind: "ring", at: ch.better.to, tone: "better" });
    return out;
  }
  if (phase === "decide") return (beat?.marks ?? []).filter((m) => m.kind === "ghost" || (m.kind === "ring" && m.tone !== "better"));
  return beat?.marks.filter((m) => !(m.kind === "path" && m.tone === "better")) ?? [];
}

// ---------------------------------------------------------------------------
// Stage: video (or map), overlays, caption.

function Stage(props: {
  r: GameReport;
  ch: Chapter;
  t: number;
  live: boolean;
  phase: Phase;
  beat: Beat | null;
  marks: Mark[];
  fogOff: boolean;
  vision: boolean;
  me: string;
  idx: number;
  count: number;
  children?: React.ReactNode;
}) {
  const { r, ch, t, live, phase, beat, marks } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const world = live && (phase === "reveal" || phase === "decide" || phase === "playout" || phase === "lead") && marks.some((m) => m.kind !== "ghost");
  const cam = useCamera(world);

  // The overlay covers the League window edge to edge, so the replay's picture is the stage.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ x: 0, y: 0, w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live]);

  const dim = phase === "decide" || phase === "reveal" || phase === "debrief";
  const tactical = !live || phase === "decide" || phase === "reveal" || phase === "debrief";

  return (
    <div className={`wt-stage ${dim ? "dim" : ""} ${phase}`} ref={boxRef}>
      {!live && <MapStage r={r} t={t} ch={ch} marks={marks} fogOff={props.fogOff} vision={props.vision} big />}

      {live && cam && world && box.w > 0 && (
        <svg className="wt-world" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} viewBox={`0 0 ${box.w} ${box.h}`}>
          <WorldMarks cam={cam} w={box.w} h={box.h} marks={marks} />
        </svg>
      )}

      {/* Top: chapter chip */}
      <div className="wt-top">
        <span className="wt-pill">
          <b>{props.idx + 1}/{props.count}</b> {ch.label}
          <i className={`wt-cost ${ch.cost >= 600 ? "hi" : ch.cost >= 300 ? "mid" : "lo"}`}>≈{ch.cost.toLocaleString("en-US")}g</i>
        </span>
        {live && (
          <span className={`wt-pill ghosty ${props.fogOff ? "warn" : ""}`}>
            {props.fogOff ? <><EyeOff size={13} /> Fog off · what was really there</> : <><Eye size={13} /> Your team's vision</>}
          </span>
        )}
      </div>

      {/* Tactical map, synced to the replay */}
      {live && tactical && (
        <div className="wt-tac">
          <MapStage r={r} t={phase === "decide" || phase === "reveal" ? ch.root : t} ch={ch} marks={marks} fogOff={phase === "reveal" || props.fogOff} vision={props.vision} />
        </div>
      )}

      {phase === "intro" && (
        <div className="wt-intro" key={ch.id}>
          <span className="eyebrow">Chapter {props.idx + 1}</span>
          <h2>{ch.label}</h2>
          <p>Cost you about <b>{ch.cost.toLocaleString("en-US")}g</b>. Watch the lead-up. It stops on the decision that started it.</p>
        </div>
      )}

      {beat && (phase === "lead" || phase === "playout") && (
        <div className={`wt-caption ${beat.kind}`} key={`${ch.id}:${beat.t}`}>
          <span className="wt-caption-kind">{beat.kind === "setup" ? "Setup" : beat.kind === "decision" ? "The decision" : beat.kind === "cue" ? "Cue" : "Result"}</span>
          <span>{beat.caption}</span>
        </div>
      )}

      {props.children && (
        <div className="wt-card-layer">
          <div className="wt-card-hit" {...(live ? hitMark : {})}>{props.children}</div>
        </div>
      )}
    </div>
  );
}

function MapStage({ r, t, ch, marks, fogOff, vision, big }: { r: GameReport; t: number; ch: Chapter; marks: Mark[]; fogOff: boolean; vision: boolean; big?: boolean }) {
  const track = r.track!;
  const me = track.players.find((p) => p.champion === r.metrics.champion && p.teamId === r.teamId);
  const seen = vision && !fogOff ? visibleAt(r.waves, t) : null;
  const fogged = seen ? track.players.filter((p) => p.teamId !== r.teamId && !seen.has(p.id)).map((p) => p.id) : [];
  const ghosts = fogged
    .map((id) => {
      const ls = lastSeen(r.waves, id, t, 120_000);
      const p = track.players.find((x) => x.id === id)!;
      return ls ? { x: ls.x, y: ls.y, champion: p.champion, label: `${Math.round((t - ls.t) / 1000)}s` } : null;
    })
    .filter((g): g is { x: number; y: number; champion: string; label: string } => !!g);
  return (
    <div className={`wt-map ${big ? "big" : ""}`}>
      <Rift
        track={track}
        teamId={r.teamId}
        meId={me?.id}
        t={t}
        size={big ? 620 : 300}
        hidden={fogged}
        ghosts={ghosts}
        minions={minionsAt(r.waves, t)}
        overlay={(size) => <MapMarks marks={marks.filter((m) => m.kind !== "ghost")} size={size} />}
      />
      {big && <span className="wt-map-clock">{fmtTime(t)}</span>}
      {big && <span className="wt-map-note">Map from Riot's match data{vision ? " and your replay's minimap" : ""}. Open the replay to watch it here.</span>}
      {!big && <span className="wt-map-label">{fmtTime(t)} · {ch.label}</span>}
    </div>
  );
}

function MapMarks({ marks, size }: { marks: Mark[]; size: number }) {
  const r = size * 0.04;
  return (
    <g className="wt-mapmarks">
      <defs>
        <marker id="wt-head-better" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head better" />
        </marker>
        <marker id="wt-head-enemy" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head enemy" />
        </marker>
      </defs>
      {marks.map((m, i) => {
        if (m.kind === "path") {
          const [x1, y1] = toView(m.from, size);
          const [x2, y2] = toView(m.to, size);
          return (
            <g key={i} className={`mm-path ${m.tone}`}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={`url(#wt-head-${m.tone === "enemy" ? "enemy" : "better"})`} />
              {m.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - r * 0.6}>{m.label}</text>}
            </g>
          );
        }
        if (m.kind === "ring") {
          const [x, y] = toView(m.at, size);
          return (
            <g key={i} className={`mm-ring ${m.tone}`}>
              <circle cx={x} cy={y} r={r * 1.6} />
              {m.label && <text x={x} y={y - r * 2}>{m.label}</text>}
            </g>
          );
        }
        return null;
      })}
    </g>
  );
}

/** Arrows and rings drawn on the replay's ground, projected through the live camera. */
function WorldMarks({ cam, w, h, marks }: { cam: Cam; w: number; h: number; marks: Mark[] }) {
  const P = (p: Pt) => project(cam, p, w, h);
  return (
    <g>
      <defs>
        <marker id="wt-wh-better" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head better" />
        </marker>
        <marker id="wt-wh-enemy" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="head enemy" />
        </marker>
        <filter id="wt-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {marks.map((m, i) => {
        if (m.kind === "path") {
          // Sample along the ground so the arrow follows perspective.
          const pts: string[] = [];
          for (let k = 0; k <= 16; k++) {
            const q = P({ x: m.from.x + ((m.to.x - m.from.x) * k) / 16, y: m.from.y + ((m.to.y - m.from.y) * k) / 16 });
            if (q) pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
          }
          if (pts.length < 2) return null;
          const end = P(m.to);
          return (
            <g key={i} className={`wm-path ${m.tone}`} filter="url(#wt-glow)">
              <polyline points={pts.join(" ")} markerEnd={`url(#wt-wh-${m.tone === "enemy" ? "enemy" : "better"})`} />
              {m.label && end && <text x={end.x} y={end.y - 18}>{m.label}</text>}
            </g>
          );
        }
        if (m.kind === "ring") {
          const c = P(m.at);
          if (!c) return null;
          // A ground circle, flattened by perspective.
          const pts: string[] = [];
          const R = m.radius ?? 260;
          for (let k = 0; k <= 32; k++) {
            const a = (k / 32) * Math.PI * 2;
            const q = P({ x: m.at.x + Math.cos(a) * R, y: m.at.y + Math.sin(a) * R });
            if (q) pts.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
          }
          return (
            <g key={i} className={`wm-ring ${m.tone}`} filter="url(#wt-glow)">
              <polygon points={pts.join(" ")} />
              {m.label && <text x={c.x} y={c.y - 26}>{m.label}</text>}
            </g>
          );
        }
        return null;
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Cards

function DecisionCard({ ch, onPick, onSkip }: { ch: Chapter; onPick: (i: number) => void; onSkip: () => void }) {
  return (
    <div className="wt-card decide">
      <span className="eyebrow">Your call · {fmtTime(ch.root)}</span>
      <h3>{ch.question}</h3>
      {ch.seen.length > 0 && (
        <ul className="wt-seen">
          {ch.seen.slice(0, 5).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      <div className="wt-choices">
        {ch.choices.map((c, i) => (
          <button key={c.label} className="wt-choice" onClick={() => onPick(i)}>
            <Kbd>{i + 1}</Kbd>
            <span>{c.label}</span>
            <ChevronRight size={16} className="go" />
          </button>
        ))}
      </div>
      <div className="wt-card-actions">
        <button className="wt-skip" onClick={onSkip}>
          Skip this one
        </button>
      </div>
    </div>
  );
}

function RevealCard({ ch, pick, onPlay }: { ch: Chapter; pick: number; onPlay: () => void }) {
  const c = ch.choices[pick];
  const best = ch.choices.find((x) => x.good);
  return (
    <div className={`wt-card reveal ${c.good ? "good" : "bad"}`}>
      <div className="wt-verdict">
        <span className="wt-verdict-icon">{c.good ? <Check size={18} strokeWidth={3} /> : <X size={18} strokeWidth={3} />}</span>
        <div>
          <b>{c.good ? "Good call." : `Not this time. ${best ? `Better: ${best.label.toLowerCase()}.` : ""}`}</b>
          <p>{c.why}</p>
        </div>
      </div>
      <div className="wt-cols">
        {ch.truth.length > 0 && (
          <div>
            <span className="eyebrow">What fog was hiding</span>
            <ul className="wt-truth">
              {ch.truth.slice(0, 4).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <span className="eyebrow better">The better play</span>
          <p>{ch.better.text}</p>
        </div>
      </div>
      <div className="wt-card-actions">
        <Button variant="primary" onClick={onPlay}>
          <Play size={14} fill="currentColor" /> Play it out <Kbd>Enter</Kbd>
        </Button>
      </div>
    </div>
  );
}

function DebriefCard({ ch, last, onReplay, onNext }: { ch: Chapter; last: boolean; onReplay: () => void; onNext: () => void }) {
  const [more, setMore] = useState(false);
  const f = ch.finding;
  return (
    <div className="wt-card debrief">
      <span className="eyebrow">{f ? `Measured at ${f.time}` : "Root cause"}</span>
      <h3>{f ? f.title : ch.headline}</h3>
      {f ? (
        <p className="wt-measured">{f.cost}</p>
      ) : (
        <div className="cost-row">
          <span className="cost-total">≈ {ch.cost.toLocaleString("en-US")}g</span>
          {ch.costParts.map((p) => (
            <span key={p.label} className="cost-part">
              {p.label} <b>{p.gold.toLocaleString("en-US")}g</b>
            </span>
          ))}
        </div>
      )}
      <div className="fix">
        <p className="eyebrow">Do this instead</p>
        <p>{f ? f.fix : ch.leak.nextTime}</p>
      </div>
      {more && (
        <ul className="evidence">
          {f ? f.proof.map((e) => <li key={e}>{e}</li>) : [ch.leak.doing, ...ch.leak.evidence].map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="wt-card-actions">
        <Button variant="ghost" size="sm" onClick={() => setMore((m) => !m)}>{more ? "Less" : f ? "The proof" : "The evidence"}</Button>
        <span className="wt-spacer" />
        <Button variant="ghost" onClick={onReplay}><ChevronLeft size={15} /> Rewatch</Button>
        <Button variant="primary" onClick={onNext}>
          {last ? <><Check size={15} /> Finish game</> : <>Next chapter <ArrowRight size={15} /></>} <Kbd>Enter</Kbd>
        </Button>
      </div>
    </div>
  );
}

function Scrubber({ ch, t, onSeek }: { ch: Chapter; t: number; onSeek: (ms: number) => void }) {
  const span = Math.max(1, ch.end - ch.start);
  const pct = (x: number) => `${Math.max(0, Math.min(100, ((x - ch.start) / span) * 100))}%`;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className="wt-scrub"
      ref={ref}
      onClick={(e) => {
        const b = ref.current!.getBoundingClientRect();
        onSeek(ch.start + ((e.clientX - b.left) / b.width) * span);
      }}
    >
      <div className="wt-scrub-track">
        <div className="wt-scrub-fill" style={{ width: pct(t) }} />
        <div className="wt-scrub-zone" style={{ left: pct(ch.root), width: `calc(${pct(ch.outcome)} - ${pct(ch.root)})` }} />
      </div>
      {ch.beats.map((b) => (
        <span key={`${b.kind}:${b.t}`} className={`wt-tick ${b.kind}`} style={{ left: pct(b.t) }} title={`${fmtTime(b.t)} · ${b.caption}`} />
      ))}
      <span className="wt-head" style={{ left: pct(t) }} />
      <span className="wt-scrub-label start">{fmtTime(ch.start)}</span>
      <span className="wt-scrub-label end">{fmtTime(ch.end)}</span>
    </div>
  );
}
