/**
 * Small top-down simulation for the aim and dodge trainers, in League units
 * (a champion hitbox is about 65 units across its radius, base move speed ~340/s).
 * Pure and deterministic given an RNG so it can be tested.
 */
import type { Ability } from "./kits";

export interface Vec {
  x: number;
  y: number;
}

export const HITBOX = 65;
export const ARENA = { w: 1800, h: 1100 };

export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec) => len(sub(a, b));
export const norm = (a: Vec): Vec => {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
export const clampToArena = (p: Vec, pad = HITBOX): Vec => ({
  x: Math.max(pad, Math.min(ARENA.w - pad, p.x)),
  y: Math.max(pad, Math.min(ARENA.h - pad, p.y)),
});

export type Rng = () => number;

/** Seeded RNG (mulberry32) so drills can be replayed in tests. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Spells in flight
// ---------------------------------------------------------------------------

export interface Shot {
  id: number;
  owner: "you" | "enemy";
  ability: Pick<Ability, "key" | "shape" | "range" | "width" | "speed" | "delay">;
  origin: Vec;
  /** Line: unit direction. Circle: unused. */
  dir: Vec;
  /** Circle: landing point. Line: end of range. */
  target: Vec;
  /** Seconds since cast. */
  age: number;
  /** Line: distance travelled after the cast time. */
  travelled: number;
  done: boolean;
  hit: boolean;
}

let nextId = 1;

export function cast(owner: Shot["owner"], ability: Shot["ability"], from: Vec, aimAt: Vec): Shot {
  const dir = norm(sub(aimAt, from));
  const reach = Math.min(ability.range, dist(from, aimAt));
  const target = ability.shape === "circle" ? add(from, mul(dir, reach)) : add(from, mul(dir, ability.range));
  return { id: nextId++, owner, ability, origin: from, dir, target, age: 0, travelled: 0, done: false, hit: false };
}

/** Seconds from cast until the spell resolves at a point `d` units away. */
export function timeToReach(a: Shot["ability"], d: number): number {
  return a.delay + (a.speed > 0 ? d / a.speed : 0);
}

/** Where a line missile's tip is now, or null during the cast time. */
export function missileTip(s: Shot): Vec | null {
  if (s.ability.shape !== "line" || s.age < s.ability.delay) return null;
  return add(s.origin, mul(s.dir, s.travelled));
}

/** Distance from point p to segment ab. */
export function segDist(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / Math.max(1e-9, ab.x * ab.x + ab.y * ab.y)));
  return dist(p, add(a, mul(ab, t)));
}

/**
 * Advances one shot by dt and checks it against a unit. Returns true on the frame it hits.
 * Lines sweep the segment travelled this frame so fast missiles can't tunnel.
 */
export function stepShot(s: Shot, dt: number, unit: Vec, radius = HITBOX): boolean {
  if (s.done) return false;
  s.age += dt;
  const a = s.ability;
  if (a.shape === "circle") {
    const land = timeToReach(a, dist(s.origin, s.target));
    if (s.age >= land) {
      s.done = true;
      s.hit = dist(unit, s.target) <= a.width + radius;
      return s.hit;
    }
    return false;
  }
  if (s.age < a.delay) return false;
  const before = s.travelled;
  // Instant lines (speed 0) resolve the whole length the frame the cast finishes.
  s.travelled = a.speed > 0 ? Math.min(a.range, before + a.speed * Math.min(dt, s.age - a.delay)) : a.range;
  const p0 = add(s.origin, mul(s.dir, before));
  const p1 = add(s.origin, mul(s.dir, s.travelled));
  if (segDist(unit, p0, p1) <= a.width / 2 + radius) {
    s.done = true;
    s.hit = true;
    return true;
  }
  if (s.travelled >= a.range) s.done = true;
  return false;
}

/**
 * Where to aim so a spell cast now hits a target moving at constant velocity.
 * Solves |p + v·(delay + t) − from| = speed·t for the travel time t.
 */
export function leadPoint(from: Vec, p: Vec, v: Vec, a: Pick<Ability, "speed" | "delay">): Vec {
  const atCast = add(p, mul(v, a.delay));
  if (a.speed <= 0) return atCast;
  const r = sub(atCast, from);
  const A = v.x * v.x + v.y * v.y - a.speed * a.speed;
  const B = 2 * (r.x * v.x + r.y * v.y);
  const C = r.x * r.x + r.y * r.y;
  let t: number;
  if (Math.abs(A) < 1e-9) t = -C / B;
  else {
    const disc = B * B - 4 * A * C;
    if (disc < 0) return atCast;
    const t1 = (-B - Math.sqrt(disc)) / (2 * A);
    const t2 = (-B + Math.sqrt(disc)) / (2 * A);
    t = Math.min(...[t1, t2].filter((x) => x > 0));
  }
  return Number.isFinite(t) && t > 0 ? add(atCast, mul(v, t)) : atCast;
}

/** Signed angle in degrees between the aim direction and the ideal direction. */
export function aimErrorDeg(from: Vec, aimed: Vec, ideal: Vec): number {
  const a = Math.atan2(aimed.y - from.y, aimed.x - from.x);
  const b = Math.atan2(ideal.y - from.y, ideal.x - from.x);
  let d = ((a - b) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// Moving units
// ---------------------------------------------------------------------------

export interface Mover {
  pos: Vec;
  vel: Vec;
  speed: number;
  dest: Vec | null;
  /** Seconds until the dummy picks a new direction. */
  nextTurn: number;
  /** Seconds until a pending reaction to a spell fires. */
  reactIn: number | null;
}

export function mover(pos: Vec, speed: number): Mover {
  return { pos, vel: { x: 0, y: 0 }, speed, dest: null, nextTurn: 0, reactIn: null };
}

/** Moves toward `dest` (right-click movement). */
export function stepToward(m: Mover, dt: number) {
  if (!m.dest) {
    m.vel = { x: 0, y: 0 };
    return;
  }
  const d = sub(m.dest, m.pos);
  const l = len(d);
  const step = m.speed * dt;
  if (l <= step) {
    m.pos = m.dest;
    m.dest = null;
    m.vel = { x: 0, y: 0 };
  } else {
    m.vel = mul(norm(d), m.speed);
    m.pos = clampToArena(add(m.pos, mul(m.vel, dt)));
  }
}

/** How a target dummy behaves at a difficulty level, 1 (easy) to 20. */
export function dummyProfile(level: number) {
  const k = (Math.max(1, Math.min(20, level)) - 1) / 19;
  return {
    /** Seconds between random direction changes; shorter is jukier. */
    turnEvery: [1.6 - 1.1 * k, 2.6 - 1.6 * k] as [number, number],
    /** Fraction of the time spent standing still. */
    idle: 0.35 * (1 - k),
    /** Chance to side-step a spell aimed at it, and how fast it reacts. */
    dodgeChance: 0.05 + 0.6 * k,
    reaction: 0.45 - 0.2 * k,
    /** Distance from you it keeps. */
    range: [450 + 250 * k, 650 + 300 * k] as [number, number],
    speed: 330 + 40 * k,
  };
}

/**
 * Target dummy for the aim trainer: wanders in random directions inside a band
 * around you and, at higher levels, side-steps spells it sees coming.
 */
export function stepDummy(m: Mover, dt: number, you: Vec, level: number, r: Rng, incoming: Shot[]) {
  const prof = dummyProfile(level);
  m.speed = prof.speed;
  m.nextTurn -= dt;

  const threat = incoming.find((s) => !s.done && s.owner === "you" && s.ability.shape === "line" && s.age < 0.05);
  if (threat && m.reactIn === null && r() < prof.dodgeChance) m.reactIn = prof.reaction;
  if (m.reactIn !== null) {
    m.reactIn -= dt;
    if (m.reactIn <= 0) {
      m.reactIn = null;
      const live = incoming.find((s) => !s.done && s.owner === "you");
      if (live) {
        const side = r() < 0.5 ? 1 : -1;
        const perp = { x: -live.dir.y * side, y: live.dir.x * side };
        m.dest = clampToArena(add(m.pos, mul(perp, 260)));
        m.nextTurn = 0.6;
      }
    }
  }

  if (m.nextTurn <= 0) {
    const [lo, hi] = prof.turnEvery;
    m.nextTurn = lo + r() * (hi - lo);
    if (r() < prof.idle) m.dest = null;
    else {
      const [near, far] = prof.range;
      const ang = r() * Math.PI * 2;
      const want = near + r() * (far - near);
      const cur = dist(m.pos, you);
      // Bias back into the band so it never walks off or onto you.
      const home = add(you, mul(norm(sub(m.pos, you)), want));
      const wander = add(m.pos, { x: Math.cos(ang) * 400, y: Math.sin(ang) * 400 });
      const pull = cur < near || cur > far ? 0.7 : 0.25;
      m.dest = clampToArena(add(mul(wander, 1 - pull), mul(home, pull)), 120);
    }
  }
  stepToward(m, dt);
}

/** How the enemy caster behaves in the dodge trainer, 1 (easy) to 20. */
export function casterProfile(level: number) {
  const k = (Math.max(1, Math.min(20, level)) - 1) / 19;
  return {
    /** Seconds between casts. */
    gap: [2.2 - 1.3 * k, 3.0 - 1.6 * k] as [number, number],
    /** 0 = aims where you stand, 1 = leads your movement perfectly. */
    lead: 0.15 + 0.75 * k,
    /** Random aim error in units at the target. */
    spread: 90 * (1 - k),
    /** Distance the caster keeps from you. */
    range: 0.85,
  };
}

/** Picks where the dodge-trainer enemy aims, given your position and velocity. */
export function enemyAim(from: Vec, you: Mover, a: Shot["ability"], level: number, r: Rng): Vec {
  const prof = casterProfile(level);
  const ideal = leadPoint(from, you.pos, you.vel, a);
  const blend = add(mul(you.pos, 1 - prof.lead), mul(ideal, prof.lead));
  const ang = r() * Math.PI * 2;
  return add(blend, { x: Math.cos(ang) * prof.spread * r(), y: Math.sin(ang) * prof.spread * r() });
}
