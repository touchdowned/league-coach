import { useEffect, useMemo, useRef, useState } from "react";
import { AbilityKey, isSkillshot, Kit } from "../../../core/mechanics/kits";
import { SET_LENGTH, Staircase, stepStair } from "../../../core/mechanics/plan";
import { aimErrorDeg, ARENA, cast, dist, HITBOX, leadPoint, mover, norm, rng, Shot, stepDummy, stepShot, Vec } from "../../../core/mechanics/sim";
import { Kbd } from "../../ui";
import { drawGhost, drawRange, drawShot, drawUnit, useArena } from "./arena";
import type { SetSummary } from "./types";

interface Pending {
  shot: Shot;
  aimed: Vec;
  ideal: Vec;
  targetVel: Vec;
}

const MIN_GAP = 0.55; // seconds between your casts, so each shot is a deliberate read

/**
 * Skillshot aim: a dummy wanders and jukes around you; press your ability keys to
 * quick-cast at the cursor. Misses well outside the hit window show where the
 * spell needed to go (bandwidth feedback); hits just count.
 */
export function AimDrill({ kit, stair, onDone }: { kit: Kit; stair: Staircase; onDone: (s: SetSummary) => void }) {
  const shots = useMemo(() => kit.abilities.filter(isSkillshot), [kit]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef(makeWorld(stair));
  const [hud, setHud] = useState({ shots: 0, hits: 0, level: stair.level, note: "" as string, countdown: 3 });
  const longest = Math.max(...shots.map((s) => s.range));

  useEffect(() => {
    const t = setInterval(() => setHud((h) => (h.countdown > 0 ? { ...h, countdown: h.countdown - 1 } : h)), 700);
    return () => clearInterval(t);
  }, []);
  const running = hud.countdown === 0 && hud.shots < SET_LENGTH.aim;

  const mouse = useArena({
    canvas,
    running,
    tick(dt) {
      const w = world.current;
      w.cooldown -= dt;
      w.ghostFor -= dt;
      stepDummy(w.enemy, dt, w.you, w.stair.level, w.rand, w.pending.map((p) => p.shot));
      // Keep the dummy inside your longest skillshot's range.
      const d = dist(w.enemy.pos, w.you);
      if (d > longest * 0.92) w.enemy.dest = { x: w.you.x + (w.enemy.pos.x - w.you.x) * 0.7, y: w.you.y + (w.enemy.pos.y - w.you.y) * 0.7 };
      for (const p of w.pending) {
        stepShot(p.shot, dt, w.enemy.pos);
        if (p.shot.done) resolve(p);
      }
      w.pending = w.pending.filter((p) => !p.shot.done);
    },
    draw(ctx, pal) {
      const w = world.current;
      drawRange(ctx, w.you, longest, pal.you);
      for (const p of w.pending) drawShot(ctx, p.shot, pal.you, true);
      if (w.ghost && w.ghostFor > 0) drawGhost(ctx, w.you, w.ghost, pal.good);
      drawUnit(ctx, w.enemy.pos, pal.enemy, "", w.enemy.vel.x || w.enemy.vel.y ? norm(w.enemy.vel) : undefined);
      drawUnit(ctx, w.you, pal.you, "You");
    },
  });

  function resolve(p: Pending) {
    const w = world.current;
    const hit = p.shot.hit;
    w.stair = stepStair(w.stair, hit);
    w.results.push({ hit, err: Math.abs(aimErrorDeg(w.you, p.aimed, p.ideal)) });
    let note = "";
    if (!hit) {
      // Bandwidth feedback: only explain misses that weren't close.
      const err = aimErrorDeg(w.you, p.aimed, p.ideal);
      const window = (Math.atan((p.shot.ability.width / 2 + HITBOX) / Math.max(1, dist(w.you, p.ideal))) * 180) / Math.PI;
      if (Math.abs(err) > window * 1.5) {
        w.ghost = p.ideal;
        w.ghostFor = 0.9;
        const moving = Math.hypot(p.targetVel.x, p.targetVel.y) > 20;
        const ahead = (p.aimed.x - p.ideal.x) * p.targetVel.x + (p.aimed.y - p.ideal.y) * p.targetVel.y;
        note = !moving ? "They were standing still: aim at them." : ahead < 0 ? "Aim further ahead of where they're walking." : "You led too far: aim a bit closer.";
      }
    }
    const results = w.results;
    setHud((h) => ({ ...h, shots: results.length, hits: results.filter((r) => r.hit).length, level: w.stair.level, note }));
    if (results.length >= SET_LENGTH.aim) {
      const hits = results.filter((r) => r.hit).length;
      onDone({
        drill: "aim",
        score: hits / results.length,
        detail: results.reduce((s, r) => s + r.err, 0) / results.length,
        stair: w.stair,
        lines: [
          `${hits} of ${results.length} hit`,
          `Average aim error ${(results.reduce((s, r) => s + r.err, 0) / results.length).toFixed(1)}°`,
          `Difficulty level ${w.stair.level} of 20`,
        ],
      });
    }
  }

  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase() as AbilityKey;
      const a = shots.find((s) => s.key === key);
      const w = world.current;
      if (!a || e.repeat || w.cooldown > 0 || w.pending.length >= 2) return;
      e.preventDefault();
      w.cooldown = MIN_GAP;
      const aimed = mouse.current;
      const ideal = leadPoint(w.you, w.enemy.pos, w.enemy.vel, a);
      w.pending.push({ shot: cast("you", a, w.you, aimed), aimed, ideal, targetVel: { ...w.enemy.vel } });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, shots, mouse]);

  return (
    <div className="drill">
      <div className="drill-hud">
        <span>
          Shot <b>{Math.min(hud.shots + 1, SET_LENGTH.aim)}</b>/{SET_LENGTH.aim}
        </span>
        <span>
          Hits <b>{hud.hits}</b>
        </span>
        <span>
          Level <b>{hud.level}</b>
        </span>
        <span className="drill-keys">
          {shots.map((s) => (
            <span key={s.key} title={s.name}>
              <Kbd>{s.key}</Kbd> {s.name !== s.key ? s.name : ""}
            </span>
          ))}
        </span>
      </div>
      <div className="drill-stage">
        <canvas ref={canvas} className="drill-canvas" />
        {hud.countdown > 0 && <div className="drill-count">{hud.countdown}</div>}
        {hud.note && <div className="drill-note">{hud.note}</div>}
      </div>
      <p className="muted small">Point at where the target will be and press a key to cast there. Watch their feet, not your cursor.</p>
    </div>
  );
}

function makeWorld(stair: Staircase) {
  const you = { x: ARENA.w / 2, y: ARENA.h / 2 };
  return {
    you,
    enemy: mover({ x: you.x + 550, y: you.y - 120 }, 340),
    rand: rng(Date.now() & 0xffff),
    stair,
    pending: [] as Pending[],
    results: [] as { hit: boolean; err: number }[],
    cooldown: 0,
    ghost: null as Vec | null,
    ghostFor: 0,
  };
}

export const hasSkillshots = (kit: Kit) => kit.abilities.some(isSkillshot);
