import { useEffect, useRef, useState } from "react";
import type { Ability, Kit } from "../../../core/mechanics/kits";
import { isSkillshot } from "../../../core/mechanics/kits";
import { SET_LENGTH, Staircase, stepStair } from "../../../core/mechanics/plan";
import {
  add,
  ARENA,
  cast,
  casterProfile,
  clampToArena,
  dist,
  enemyAim,
  len,
  mover,
  mul,
  norm,
  rng,
  Shot,
  stepShot,
  stepToward,
  sub,
  Vec,
} from "../../../core/mechanics/sim";
import { Kbd } from "../../ui";
import { drawRange, drawShot, drawUnit, toArena, useArena } from "./arena";
import type { SetSummary } from "./types";

const FLASH = { range: 400, cooldown: 12 };
/** Below this level the enemy's spell indicator is shown during its cast time. */
const TELEGRAPH_UNTIL = 8;

interface Live {
  shot: Shot;
  caster: string;
  youVel: Vec;
}

/**
 * Dodging: your lane opponents cast their real skillshots at you. Right-click to
 * move, F or D to flash. The caster leads your movement more as you improve, and
 * stops showing its indicator past the early levels.
 */
export function DodgeDrill({ you, casters, stair, onDone }: { you: Kit; casters: Kit[]; stair: Staircase; onDone: (s: SetSummary) => void }) {
  const pool = casters.flatMap((k) => k.abilities.filter(isSkillshot).map((a) => ({ champion: k.champion, ability: a })));
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef(makeWorld(you.moveSpeed, stair));
  const [hud, setHud] = useState({ casts: 0, hits: 0, level: stair.level, note: "", countdown: 3, flashReady: true, caster: pool[0]?.champion ?? "" });

  useEffect(() => {
    const t = setInterval(() => setHud((h) => (h.countdown > 0 ? { ...h, countdown: h.countdown - 1 } : h)), 700);
    return () => clearInterval(t);
  }, []);
  const running = hud.countdown === 0 && hud.casts < SET_LENGTH.dodge && pool.length > 0;

  const mouse = useArena({
    canvas,
    running,
    tick(dt) {
      const w = world.current;
      stepToward(w.you, dt);
      w.flashCd = Math.max(0, w.flashCd - dt);
      if (w.flashCd === 0 && !w.flashShown) {
        w.flashShown = true;
        setHud((h) => ({ ...h, flashReady: true }));
      }

      // Caster strafes to keep its distance at ~85% of the spell it will cast next.
      const next = w.queued ?? (w.queued = pool[Math.floor(w.rand() * pool.length)]);
      const want = next.ability.range * casterProfile(w.stair.level).range;
      const away = norm(sub(w.caster.pos, w.you.pos));
      const side = { x: -away.y * w.strafe, y: away.x * w.strafe };
      w.caster.dest = clampToArena(add(add(w.you.pos, mul(away, Math.min(want, 950))), mul(side, 160)), 90);
      stepToward(w.caster, dt);
      w.strafeIn -= dt;
      if (w.strafeIn <= 0) {
        w.strafe = -w.strafe;
        w.strafeIn = 1 + w.rand() * 1.5;
      }

      w.castIn -= dt;
      if (w.castIn <= 0 && w.live.length < 2 && w.casts < SET_LENGTH.dodge) {
        const prof = casterProfile(w.stair.level);
        w.castIn = prof.gap[0] + w.rand() * (prof.gap[1] - prof.gap[0]);
        const aim = enemyAim(w.caster.pos, w.you, next.ability, w.stair.level, w.rand);
        w.live.push({ shot: cast("enemy", next.ability, w.caster.pos, aim), caster: next.champion, youVel: { ...w.you.vel } });
        w.casts++;
        w.label = next.champion;
        w.queued = null;
      }

      for (const l of w.live) {
        stepShot(l.shot, dt, w.you.pos);
        if (l.shot.done) resolve(l);
      }
      w.live = w.live.filter((l) => !l.shot.done);
    },
    draw(ctx, pal) {
      const w = world.current;
      const telegraph = w.stair.level < TELEGRAPH_UNTIL;
      for (const l of w.live) drawShot(ctx, l.shot, pal.enemy, telegraph);
      if (w.you.dest) {
        ctx.save();
        ctx.strokeStyle = pal.good;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(w.you.dest.x, w.you.dest.y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      if (w.queued) drawRange(ctx, w.caster.pos, w.queued.ability.range, pal.enemy);
      drawUnit(ctx, w.caster.pos, pal.enemy, w.label.slice(0, 2));
      drawUnit(ctx, w.you.pos, pal.you, "You", len(w.you.vel) ? norm(w.you.vel) : undefined);
    },
  });

  function resolve(l: Live) {
    const w = world.current;
    const dodged = !l.shot.hit;
    w.stair = stepStair(w.stair, dodged);
    w.results.push(dodged);
    let note = "";
    if (!dodged) {
      const speed = len(l.youVel);
      const along = speed ? Math.abs((l.youVel.x * l.shot.dir.x + l.youVel.y * l.shot.dir.y) / speed) : 0;
      note =
        speed < 20
          ? `Hit by ${l.caster} ${l.shot.ability.key}: you were standing still. Keep moving between casts.`
          : along > 0.7
            ? `Hit by ${l.caster} ${l.shot.ability.key}: you ran along its path. Step sideways to it.`
            : `Hit by ${l.caster} ${l.shot.ability.key}: watch the wind-up and move as it starts.`;
    }
    const hits = w.results.filter((r) => !r).length;
    setHud((h) => ({ ...h, casts: w.results.length, hits, level: w.stair.level, note, caster: l.caster }));
    if (w.results.length >= SET_LENGTH.dodge) {
      const dodgedN = w.results.length - hits;
      onDone({
        drill: "dodge",
        score: dodgedN / w.results.length,
        detail: hits,
        stair: w.stair,
        lines: [`${dodgedN} of ${w.results.length} dodged`, `Hit ${hits} time${hits === 1 ? "" : "s"}`, `Difficulty level ${w.stair.level} of 20`],
      });
    }
  }

  useEffect(() => {
    const c = canvas.current;
    if (!c || !running) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      world.current.you.dest = clampToArena(toArena(e, c));
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toUpperCase();
      const w = world.current;
      if ((k === "F" || k === "D") && !e.repeat && w.flashCd === 0) {
        const to = mouse.current;
        const dir = norm(sub(to, w.you.pos));
        w.you.pos = clampToArena(add(w.you.pos, mul(dir, Math.min(FLASH.range, dist(to, w.you.pos)))));
        w.you.dest = null;
        w.flashCd = FLASH.cooldown;
        w.flashShown = false;
        setHud((h) => ({ ...h, flashReady: false }));
      }
    };
    c.addEventListener("mousedown", onDown);
    c.addEventListener("contextmenu", onCtx);
    window.addEventListener("keydown", onKey);
    return () => {
      c.removeEventListener("mousedown", onDown);
      c.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("keydown", onKey);
    };
  }, [running, mouse]);

  if (!pool.length) return <p className="muted">None of these opponents have skillshots to dodge.</p>;

  return (
    <div className="drill">
      <div className="drill-hud">
        <span>
          Cast <b>{Math.min(hud.casts, SET_LENGTH.dodge)}</b>/{SET_LENGTH.dodge}
        </span>
        <span>
          Hit <b>{hud.hits}</b>
        </span>
        <span>
          Level <b>{hud.level}</b>
        </span>
        <span>
          vs <b>{hud.caster}</b>
        </span>
        <span className="drill-keys">
          <span>Right-click to move</span>
          <span className={hud.flashReady ? "" : "muted"}>
            <Kbd>F</Kbd> Flash {hud.flashReady ? "ready" : "on cooldown"}
          </span>
        </span>
      </div>
      <div className="drill-stage">
        <canvas ref={canvas} className="drill-canvas" />
        {hud.countdown > 0 && <div className="drill-count">{hud.countdown}</div>}
        {hud.note && <div className="drill-note">{hud.note}</div>}
      </div>
      <p className="muted small">Watch the caster, not the missile. Move sideways to the line the moment the wind-up starts.</p>
    </div>
  );
}

function makeWorld(moveSpeed: number, stair: Staircase) {
  const start = { x: ARENA.w * 0.35, y: ARENA.h / 2 };
  return {
    you: mover(start, moveSpeed),
    caster: mover({ x: ARENA.w * 0.8, y: ARENA.h / 2 }, 330),
    rand: rng(Date.now() & 0xffff),
    stair,
    live: [] as Live[],
    results: [] as boolean[],
    casts: 0,
    castIn: 1.2,
    queued: null as { champion: string; ability: Ability } | null,
    label: "",
    strafe: 1,
    strafeIn: 1.5,
    flashCd: 0,
    flashShown: true,
  };
}
