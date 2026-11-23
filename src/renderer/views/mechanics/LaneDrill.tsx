import { useEffect, useRef, useState } from "react";
import type { AbilityKey, Kit } from "../../../core/mechanics/kits";
import { isSkillshot } from "../../../core/mechanics/kits";
import {
  byId,
  canCast,
  castAt,
  cooldownFrac,
  createLane,
  enemy,
  flash,
  aimedBehind,
  LaneEvent,
  LaneShot,
  LaneState,
  Mode,
  rightClick,
  Situation,
  step,
  you,
} from "../../../core/mechanics/lane";
import { SET_LENGTH, Staircase, stepStair } from "../../../core/mechanics/plan";
import { rng, Vec } from "../../../core/mechanics/sim";
import { Kbd } from "../../ui";
import { LaneScene } from "./LaneScene";
import { sfx } from "./sfx";
import type { SetSummary } from "./types";
import { spellIcon, useDdVersion } from "./useKit";

const STEP = 1 / 120;
const TRADE_SECONDS = 90;
const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

export interface LaneSettings {
  /** Hold the key to see the indicator, release to cast (League's "quick cast with indicator"). */
  indicator: boolean;
  realCooldowns: boolean;
  sound: boolean;
}

interface Tally {
  shots: number;
  hits: number;
  bySit: Record<Situation, { n: number; hit: number }>;
  dodged: number;
  blocked: number;
  off: number;
  behind: number;
  ahead: number;
  incoming: number;
  takenHits: number;
  /** Auto-attacks the enemy champion started: each one was a window to cast into. */
  windows: number;
}

const emptyTally = (): Tally => ({
  shots: 0,
  hits: 0,
  bySit: { attacking: { n: 0, hit: 0 }, farming: { n: 0, hit: 0 }, free: { n: 0, hit: 0 } },
  dodged: 0,
  blocked: 0,
  off: 0,
  behind: 0,
  ahead: 0,
  incoming: 0,
  takenHits: 0,
  windows: 0,
});

/**
 * One lane, played the way League plays: right-click to move or attack, quick
 * cast at the cursor, minion waves, and an enemy laner that farms, trades and dodges.
 */
export function LaneDrill({
  mode,
  you: youKit,
  enemy: enemyKit,
  stair,
  settings,
  onDone,
}: {
  mode: Mode;
  you: Kit;
  enemy: Kit;
  stair: Staircase;
  settings: LaneSettings;
  onDone: (s: SetSummary) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const abilityRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [hud, setHud] = useState({ count: 0, hits: 0, taken: 0, level: stair.level, note: "", noteKey: 0, timeLeft: TRADE_SECONDS, countdown: 3 });
  const ddv = useDdVersion();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const c = canvas.current!;
    const ov = overlay.current!;
    const scene = new LaneScene(c);
    const s: LaneState = createLane({ mode, you: youKit, enemy: enemyKit, level: stair.level, rand: rng(Date.now() & 0xffff), realCooldowns: settingsRef.current.realCooldowns });
    let st = stair;
    const tally = emptyTally();
    let mouse = { x: 0, y: 0 };
    let held: AbilityKey | null = null;
    let finished = false;
    let countdown = 3;
    let started = false;
    const bars = new Map<number, HTMLDivElement>();
    const sound = sfx(() => settingsRef.current.sound);

    // Exposed on the dev server only, for automated play-testing.
    if (location.hostname === "localhost") (window as unknown as { __lane: unknown }).__lane = { s, scene };
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(c);
    scene.resize();

    const cd = setInterval(() => {
      countdown--;
      setHud((h) => ({ ...h, countdown }));
      if (countdown <= 0) {
        started = true;
        clearInterval(cd);
      }
    }, 650);

    const ground = (): Vec | null => scene.pick(mouse.x, mouse.y);

    const onMove = (e: MouseEvent) => (mouse = { x: e.clientX, y: e.clientY });
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2 || !started) return;
      const p = scene.pick(e.clientX, e.clientY);
      if (!p) return;
      rightClick(s, p);
      if (you(s).target === null) scene.showMoveMarker(p);
    };
    const noMenu = (e: Event) => e.preventDefault();
    const tryCast = (key: AbilityKey) => {
      const p = ground();
      if (!p || !started) return;
      if (castAt(s, key, p)) sound.cast();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      if (e.repeat) return;
      if ((k === "F" || k === "D") && started) {
        const p = ground();
        if (p && flash(s, p)) sound.flash();
        e.preventDefault();
        return;
      }
      if (!KEYS.includes(k as AbilityKey)) return;
      e.preventDefault();
      if (settingsRef.current.indicator) held = k as AbilityKey;
      else tryCast(k as AbilityKey);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase() as AbilityKey;
      if (held === k) {
        held = null;
        tryCast(k);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scene.zoom = Math.max(0.8, Math.min(1.35, scene.zoom + Math.sign(e.deltaY) * 0.05));
    };
    window.addEventListener("mousemove", onMove);
    c.addEventListener("mousedown", onDown);
    c.addEventListener("contextmenu", noMenu);
    c.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function note(text: string | null) {
      if (text) setHud((h) => ({ ...h, note: text, noteKey: h.noteKey + 1 }));
    }

    function onEvent(ev: LaneEvent) {
      if (ev.type === "damage") {
        const u = byId(s, ev.unit);
        if (ev.byChamp || u?.kind === "champ") floatNumber(ov, scene, ev.pos, scene.unitHeight(ev.unit) + 60, Math.round(ev.amount), u?.id === s.you ? "taken" : ev.byChamp ? "dealt" : "minion");
      } else if (ev.type === "resolved") {
        const shot = ev.shot;
        if (ev.team === "blue") {
          if (byId(s, s.enemy)?.dead && ev.outcome !== "hit") return;
          tally.shots++;
          tally.bySit[ev.situation].n++;
          if (ev.outcome === "hit") {
            tally.hits++;
            tally.bySit[ev.situation].hit++;
            sound.hit();
            scene.burst(enemy(s).pos, 0x7fd8ff);
          } else if (ev.outcome === "dodged") tally.dodged++;
          else if (ev.outcome === "blocked") {
            tally.blocked++;
            sound.block();
          } else tally.off++;
          const sh = lastShots.get(shot);
          if (ev.outcome !== "hit" && sh?.ideal && ev.note) {
            scene.showGhost(sh.origin, sh.ideal);
            if (ev.outcome === "missed" && Math.hypot(sh.vel.x, sh.vel.y) > 30) aimedBehind(sh, { vel: sh.vel }) ? tally.behind++ : tally.ahead++;
          }
          st = stepStair(st, ev.outcome === "hit");
          note(ev.note);
        } else {
          tally.incoming++;
          if (ev.outcome === "hit") {
            tally.takenHits++;
            sound.ouch();
            note(ev.note);
          }
          st = stepStair(st, ev.outcome !== "hit");
        }
        s.level = st.level;
        setHud((h) => ({ ...h, count: mode === "dodge" ? tally.incoming : tally.shots, hits: tally.hits, taken: tally.takenHits, level: st.level }));
        checkDone();
      } else if (ev.type === "attack" && ev.from === s.enemy) {
        tally.windows++;
      } else if (ev.type === "flash") {
        scene.burst(ev.from, 0xfff2a8);
        scene.burst(ev.to, 0xfff2a8);
      }
    }

    // Shots are dropped from the state when they resolve; keep their aim for feedback.
    const lastShots = new Map<number, Pick<LaneShot, "origin" | "dir" | "target" | "ideal" | "ability"> & { vel: Vec }>();

    function checkDone() {
      if (finished) return;
      const enough = mode === "aim" ? tally.shots >= SET_LENGTH.aim : mode === "dodge" ? tally.incoming >= SET_LENGTH.dodge : s.t >= TRADE_SECONDS;
      if (!enough) return;
      finished = true;
      doneRef.current(summarize(mode, tally, st, s.t));
    }

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let simStart = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (started && !finished) {
        if (!simStart) simStart = now;
        acc += dt;
        while (acc >= STEP) {
          step(s, STEP);
          for (const sh of s.shots) if (!lastShots.has(sh.id)) lastShots.set(sh.id, { ...sh, vel: { ...enemy(s).vel } });
          for (const ev of s.events) onEvent(ev);
          s.events = [];
          acc -= STEP;
        }
        if (mode === "trade") {
          const left = Math.max(0, Math.ceil(TRADE_SECONDS - s.t));
          setHud((h) => (h.timeLeft !== left ? { ...h, timeLeft: left } : h));
          checkDone();
        }
      }
      const a = held ? youKit.abilities.find((x) => x.key === held) : null;
      scene.setIndicator(a ? you(s).pos : null, a ? ground() : null, a && isSkillshot(a) ? a : null);
      scene.render(s, dt, s.you);
      drawBars(ov, scene, s, bars);
      for (const k of KEYS) {
        const el = abilityRefs.current[k];
        if (!el) continue;
        el.style.setProperty("--cd", String(cooldownFrac(s, k)));
        el.classList.toggle("ready", !!canCast(s, k));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(cd);
      ro.disconnect();
      window.removeEventListener("mousemove", onMove);
      c.removeEventListener("mousedown", onDown);
      c.removeEventListener("contextmenu", noMenu);
      c.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      for (const b of bars.values()) b.remove();
      scene.dispose();
      sound.close();
    };
    // The lane is built once per set; the parent remounts with a new key for the next one.
  }, []);

  const shots = youKit.abilities.filter(isSkillshot);
  const target = mode === "trade" ? null : mode === "aim" ? SET_LENGTH.aim : SET_LENGTH.dodge;

  return (
    <div className="lane">
      <div className="lane-stage">
        <canvas ref={canvas} className="lane-canvas" />
        <div ref={overlay} className="lane-overlay" />
        <div className="lane-hud">
          {mode === "trade" ? (
            <span>
              <b>{hud.timeLeft}s</b>
            </span>
          ) : (
            <span>
              {mode === "aim" ? "Shot" : "Cast"} <b>{Math.min(hud.count, target!)}</b>/{target}
            </span>
          )}
          {mode !== "dodge" && (
            <span>
              Hits <b>{hud.hits}</b>
            </span>
          )}
          {mode !== "aim" && (
            <span>
              Hit by them <b>{hud.taken}</b>
            </span>
          )}
          <span>
            Bot level <b>{hud.level}</b>
          </span>
          <span className="muted">
            vs {enemyKit.champion}
          </span>
        </div>
        {hud.countdown > 0 && <div className="lane-count">{hud.countdown}</div>}
        {hud.note && (
          <div key={hud.noteKey} className="lane-note">
            {hud.note}
          </div>
        )}
        <div className="lane-bar">
          {KEYS.map((k) => {
            const a = youKit.abilities.find((x) => x.key === k);
            const usable = !!a && isSkillshot(a);
            return (
              <div key={k} ref={(el) => void (abilityRefs.current[k] = el)} className={`lane-ability ${usable ? "" : "off"}`} title={a?.name}>
                {a?.icon && ddv ? <img src={spellIcon(ddv, a.icon)} alt="" /> : <span>{k}</span>}
                <i className="cd" />
                <Kbd>{k}</Kbd>
              </div>
            );
          })}
          <div className="lane-ability flash ready">
            <span>F</span>
            <Kbd>F</Kbd>
          </div>
        </div>
      </div>
      <p className="muted small lane-help">
        Right-click to move or attack, {settings.indicator ? "hold and release" : "press"} {shots.map((x) => x.key).join("/") || "Q/W/E/R"} to cast at your cursor, F
        to Flash, scroll to zoom.
        {mode === "aim"
          ? " Their auto-attack wind-up is your window: the orb on their staff lights up."
          : " Watch their cast animation and step sideways to the line."}
      </p>
    </div>
  );
}

function summarize(mode: Mode, t: Tally, stair: Staircase, seconds: number): SetSummary {
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
  const hitRate = t.shots ? t.hits / t.shots : 0;
  const dodgeRate = t.incoming ? 1 - t.takenHits / t.incoming : 1;
  const sit = (k: Situation, label: string) => `${label} ${t.bySit[k].hit}/${t.bySit[k].n}`;
  const lines: string[] = [];
  if (mode !== "dodge") {
    lines.push(`${t.hits} of ${t.shots} skillshots landed (${pct(t.hits, t.shots)})`);
    lines.push(`By moment: ${sit("attacking", "into their auto-attack")} · ${sit("farming", "while they farmed")} · ${sit("free", "free target")}`);
    const misses = [t.dodged && `${t.dodged} dodged`, t.blocked && `${t.blocked} minion-blocked`, t.off && `${t.off} off target`].filter(Boolean);
    if (misses.length) lines.push(`Misses: ${misses.join(", ")}`);
    if (t.behind + t.ahead >= 2) lines.push(t.behind > t.ahead ? `You aimed behind them ${t.behind} times: lead more.` : `You over-led ${t.ahead} times: aim a little closer.`);
    const best = (["attacking", "farming", "free"] as Situation[]).filter((k) => t.bySit[k].n >= 2).sort((a, b) => t.bySit[b].hit / t.bySit[b].n - t.bySit[a].hit / t.bySit[a].n)[0];
    if (best === "attacking") lines.push("Your best window was their auto-attack. Keep waiting for it.");
    else if (t.windows >= 3 && t.bySit.attacking.n < t.shots / 4)
      lines.push(`They auto-attacked ${t.windows} times but only ${t.bySit.attacking.n} of your casts went into a wind-up. That's the easiest window to hit.`);
  }
  if (mode !== "aim") lines.push(`Dodged ${t.incoming - t.takenHits} of ${t.incoming} enemy skillshots (${pct(t.incoming - t.takenHits, t.incoming)})`);
  if (mode === "trade") lines.push(`${Math.round(seconds)}s of laning`);
  lines.push(`Bot level ${stair.level} of 20`);
  const score = mode === "aim" ? hitRate : mode === "dodge" ? dodgeRate : (hitRate + dodgeRate) / 2;
  return { drill: mode, score, detail: mode === "dodge" ? t.takenHits : t.hits, stair, lines };
}

function drawBars(ov: HTMLDivElement, scene: LaneScene, s: LaneState, bars: Map<number, HTMLDivElement>) {
  const live = new Set<number>();
  for (const u of s.units) {
    if (u.dead) continue;
    live.add(u.id);
    let el = bars.get(u.id);
    if (!el) {
      el = document.createElement("div");
      const isChamp = u.kind === "champ";
      el.className = `hp ${u.team} ${isChamp ? "champ" : "minion"} ${u.id === s.you ? "you" : ""}`;
      el.innerHTML = isChamp ? `<i></i><b>${u.team === "blue" ? s.youKit.champion : s.enemyKit.champion}</b>` : `<i></i>`;
      ov.appendChild(el);
      bars.set(u.id, el);
    }
    const p = scene.project(u.pos, scene.unitHeight(u.id) + 35);
    el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
    el.style.display = p.visible ? "" : "none";
    (el.firstChild as HTMLElement).style.transform = `scaleX(${u.hp / u.maxHp})`;
  }
  for (const [id, el] of bars) {
    if (!live.has(id)) {
      el.remove();
      bars.delete(id);
    }
  }
}

function floatNumber(ov: HTMLDivElement, scene: LaneScene, pos: Vec, h: number, n: number, kind: "dealt" | "taken" | "minion") {
  const p = scene.project(pos, h);
  const el = document.createElement("div");
  el.className = `dmg ${kind}`;
  el.textContent = String(n);
  el.style.left = `${p.x + (Math.random() - 0.5) * 30}px`;
  el.style.top = `${p.y}px`;
  ov.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
