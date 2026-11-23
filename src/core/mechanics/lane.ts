/**
 * A single lane, simulated the way League plays it: right-click movement, cast
 * times that root you, minion waves that fight and block skillshots, and an enemy
 * laner that farms, trades and dodges like a person. Pure logic with no rendering,
 * deterministic for a given RNG, so it can be tested and drawn by any renderer.
 *
 * Units are game units. x runs along the lane (your side is low x), y across it.
 */
import type { Ability, AbilityKey, Kit } from "./kits";
import { isSkillshot } from "./kits";
import { add, dist, len, mul, norm, Rng, segDist, sub, timeToReach, Vec } from "./sim";

export const LANE = { x0: 0, x1: 4200, halfWidth: 560, wall: 700 };
export const CHAMP_RADIUS = 65;
const MINION = {
  melee: { hp: 477, ad: 12, range: 110, windup: 0.25, cd: 1.25, radius: 48, speed: 325 },
  caster: { hp: 296, ad: 23, range: 550, windup: 0.3, cd: 1.6, radius: 48, speed: 325 },
};
const WAVE_EVERY = 25;
const SKILLSHOT_DAMAGE = 95;
const CHAMP_HP = 640;

export type Team = "blue" | "red";
export type UnitKind = "champ" | "melee" | "caster";
export type Mode = "aim" | "dodge" | "trade";

export interface Unit {
  id: number;
  team: Team;
  kind: UnitKind;
  pos: Vec;
  facing: Vec;
  radius: number;
  hp: number;
  maxHp: number;
  ad: number;
  speed: number;
  range: number;
  windup: number;
  attackCd: number;
  /** Move order, resumed after a cast or an attack. */
  dest: Vec | null;
  /** Unit we're attacking, if any. */
  target: number | null;
  /** Seconds left in the current attack wind-up; the unit can't move during it. */
  winding: number;
  cdLeft: number;
  /** Seconds left rooted by our own cast time. */
  casting: number;
  dead: boolean;
  respawnIn: number;
  /** Last frame's velocity, for prediction. */
  vel: Vec;
}

export interface LaneShot {
  id: number;
  owner: number;
  team: Team;
  ability: Ability;
  origin: Vec;
  dir: Vec;
  target: Vec;
  age: number;
  travelled: number;
  done: boolean;
  hitIds: number[];
  /** What the shot did, once it resolved. */
  outcome: "pending" | "hit" | "blocked" | "dodged" | "missed";
  /** Situation of the enemy champion when you cast, for coaching. */
  situation: Situation;
  /** Where it needed to go to hit (for feedback on misses). */
  ideal: Vec | null;
  /** Did the enemy start a dodge in response? */
  reacted: boolean;
}

export type Situation = "attacking" | "farming" | "free";

/** Something the renderer should show: damage numbers, sounds, coaching text. */
export type LaneEvent =
  | { type: "damage"; unit: number; amount: number; byChamp: boolean; pos: Vec }
  | { type: "death"; unit: number }
  | { type: "cast"; shot: number; team: Team }
  | { type: "resolved"; shot: number; team: Team; outcome: LaneShot["outcome"]; situation: Situation; note: string | null }
  | { type: "attack"; from: number; to: number }
  | { type: "flash"; unit: number; from: Vec; to: Vec };

/** How the enemy laner plays at a difficulty level, 1 (new player) to 20 (sharp). */
export function botProfile(level: number) {
  const k = (Math.max(1, Math.min(20, level)) - 1) / 19;
  return {
    /** Seconds from your cast starting to them moving. Human visual reaction is ~0.2-0.3 s. */
    reaction: 0.5 - 0.3 * k,
    /** Chance they try to dodge a spell they could dodge. */
    dodgeChance: 0.2 + 0.7 * k,
    /** How often they dodge to their favourite side (habit). Lower is harder to read. */
    habit: 0.85 - 0.3 * k,
    /** Seconds between move clicks while idling (they never fully stand still). */
    clickEvery: [0.55 - 0.25 * k, 1.1 - 0.5 * k] as [number, number],
    /** Distance they keep relative to your longest skillshot when not farming (negative = inside it). */
    spacing: -380 + 440 * k,
    /** Chance per decision to auto a minion just to push, giving you an attack window. Sharp players only last-hit. */
    pushAuto: 0.45 - 0.35 * k,
    /** Chance to Flash a spell they can't walk out of when low. */
    flashChance: 0.15 + 0.6 * k,
    /** Dodge/trade modes: how much they lead your movement when casting, and cast gap. */
    lead: 0.2 + 0.75 * k,
    castGap: [3.2 - 1.8 * k, 4.5 - 2.4 * k] as [number, number],
  };
}

export interface LaneOptions {
  mode: Mode;
  you: Kit;
  enemy: Kit;
  level: number;
  rand: Rng;
  /** Practice-tool style short cooldowns (default) or the real ones. */
  realCooldowns?: boolean;
}

export interface LaneState {
  t: number;
  mode: Mode;
  units: Unit[];
  shots: LaneShot[];
  you: number;
  enemy: number;
  youKit: Kit;
  enemyKit: Kit;
  cooldowns: Record<AbilityKey, number>;
  enemyCooldowns: Record<AbilityKey, number>;
  flashCd: number;
  enemyFlashCd: number;
  level: number;
  rand: Rng;
  realCooldowns: boolean;
  nextWave: number;
  /** Enemy AI scratch. */
  bot: { nextClick: number; favSide: 1 | -1; dodging: number; reactQueue: { shot: number; at: number }[]; nextCast: number; lastHitTarget: number | null };
  events: LaneEvent[];
  nextId: number;
}

function unit(s: LaneState, team: Team, kind: UnitKind, pos: Vec, o: Partial<Unit> = {}): Unit {
  const m = kind === "champ" ? null : MINION[kind];
  const u: Unit = {
    id: s.nextId++,
    team,
    kind,
    pos,
    facing: { x: team === "blue" ? 1 : -1, y: 0 },
    radius: m ? m.radius : CHAMP_RADIUS,
    hp: m ? m.hp : CHAMP_HP,
    maxHp: m ? m.hp : CHAMP_HP,
    ad: m ? m.ad : 60,
    speed: m ? m.speed : 340,
    range: m ? m.range : 525,
    windup: m ? m.windup : 0.3,
    attackCd: m ? m.cd : 1.5,
    dest: null,
    target: null,
    winding: 0,
    cdLeft: 0,
    casting: 0,
    dead: false,
    respawnIn: 0,
    vel: { x: 0, y: 0 },
    ...o,
  };
  s.units.push(u);
  return u;
}

const ZERO_CD: Record<AbilityKey, number> = { Q: 0, W: 0, E: 0, R: 0 };

export function createLane(o: LaneOptions): LaneState {
  const s: LaneState = {
    t: 0,
    mode: o.mode,
    units: [],
    shots: [],
    you: 0,
    enemy: 0,
    youKit: o.you,
    enemyKit: o.enemy,
    cooldowns: { ...ZERO_CD },
    enemyCooldowns: { ...ZERO_CD },
    flashCd: 0,
    enemyFlashCd: 0,
    level: o.level,
    rand: o.rand,
    realCooldowns: !!o.realCooldowns,
    nextWave: 0,
    bot: { nextClick: 0, favSide: o.rand() < 0.5 ? 1 : -1, dodging: 0, reactQueue: [], nextCast: 2.5, lastHitTarget: null },
    events: [],
    nextId: 1,
  };
  const ranged = (k: Kit) => k.attackRange ?? 525;
  s.you = unit(s, "blue", "champ", { x: 1550, y: 120 }, { speed: o.you.moveSpeed, range: ranged(o.you), ad: ranged(o.you) > 300 ? 55 : 68 }).id;
  s.enemy = unit(s, "red", "champ", { x: 2650, y: -80 }, { speed: o.enemy.moveSpeed, range: ranged(o.enemy), ad: 58 }).id;
  spawnWave(s);
  s.nextWave = WAVE_EVERY;
  return s;
}

function spawnWave(s: LaneState) {
  for (const team of ["blue", "red"] as Team[]) {
    const x = team === "blue" ? 700 : LANE.x1 - 700;
    const back = team === "blue" ? -1 : 1;
    for (let i = 0; i < 3; i++) unit(s, team, "melee", { x: x + back * i * 10, y: (i - 1) * 140 });
    for (let i = 0; i < 3; i++) unit(s, team, "caster", { x: x + back * 220, y: (i - 1) * 150 });
  }
}

export const byId = (s: LaneState, id: number | null) => (id === null ? undefined : s.units.find((u) => u.id === id));
export const you = (s: LaneState) => byId(s, s.you)!;
export const enemy = (s: LaneState) => byId(s, s.enemy)!;

const clampLane = (p: Vec, r = CHAMP_RADIUS): Vec => ({
  x: Math.max(LANE.x0 + 150, Math.min(LANE.x1 - 150, p.x)),
  y: Math.max(-LANE.halfWidth + r, Math.min(LANE.halfWidth - r, p.y)),
});

// ---------------------------------------------------------------------------
// Commands from the player
// ---------------------------------------------------------------------------

/** Right-click: attack an enemy unit under the cursor, otherwise move there. */
export function rightClick(s: LaneState, at: Vec): void {
  const me = you(s);
  if (me.dead) return;
  const hit = s.units
    .filter((u) => !u.dead && u.team !== me.team && dist(u.pos, at) <= u.radius + 30)
    .sort((a, b) => dist(a.pos, at) - dist(b.pos, at))[0];
  if (hit) {
    me.target = hit.id;
    me.dest = null;
  } else {
    me.target = null;
    me.dest = clampLane(at);
    // Like the game, a move order cancels an attack that hasn't fired yet.
    me.winding = 0;
  }
}

export function canCast(s: LaneState, key: AbilityKey): Ability | null {
  const a = s.youKit.abilities.find((x) => x.key === key);
  if (!a || !isSkillshot(a) || s.cooldowns[key] > 0) return null;
  const me = you(s);
  if (me.dead || me.casting > 0) return null;
  return a;
}

/** Quick cast at a ground point. Returns the shot, or null if it couldn't be cast. */
export function castAt(s: LaneState, key: AbilityKey, at: Vec): LaneShot | null {
  const a = canCast(s, key);
  if (!a) return null;
  const me = you(s);
  const foe = enemy(s);
  const shot = makeShot(s, me, a, at);
  shot.situation = foe.winding > 0 ? "attacking" : s.bot.lastHitTarget !== null ? "farming" : "free";
  shot.ideal = foe.dead ? null : idealAim(me.pos, foe, a);
  s.cooldowns[key] = s.realCooldowns ? a.cooldown || 6 : Math.max(1.2, (a.cooldown || 6) * 0.25);
  // Queue the enemy's reaction to seeing your cast animation.
  if (!foe.dead) s.bot.reactQueue.push({ shot: shot.id, at: s.t + botProfile(s.level).reaction * (0.85 + 0.3 * s.rand()) });
  return shot;
}

export function flash(s: LaneState, toward: Vec): boolean {
  const me = you(s);
  if (me.dead || s.flashCd > 0) return false;
  const from = me.pos;
  const d = Math.min(400, dist(toward, from));
  me.pos = clampLane(add(from, mul(norm(sub(toward, from)), d)));
  me.dest = null;
  s.flashCd = s.realCooldowns ? 300 : 15;
  s.events.push({ type: "flash", unit: me.id, from, to: me.pos });
  return true;
}

function makeShot(s: LaneState, caster: Unit, a: Ability, at: Vec): LaneShot {
  const dir = norm(sub(at, caster.pos));
  const reach = Math.min(a.range, dist(caster.pos, at));
  const target = a.shape === "circle" ? add(caster.pos, mul(dir, reach)) : add(caster.pos, mul(dir, a.range));
  const shot: LaneShot = {
    id: s.nextId++,
    owner: caster.id,
    team: caster.team,
    ability: a,
    origin: caster.pos,
    dir,
    target,
    age: 0,
    travelled: 0,
    done: false,
    hitIds: [],
    outcome: "pending",
    situation: "free",
    ideal: null,
    reacted: false,
  };
  caster.facing = dir;
  caster.casting = a.delay;
  caster.winding = 0;
  s.shots.push(shot);
  s.events.push({ type: "cast", shot: shot.id, team: caster.team });
  return shot;
}

/** Where a spell must be aimed to hit a unit that keeps its current velocity. */
export function idealAim(from: Vec, u: Unit, a: Pick<Ability, "speed" | "delay" | "shape">): Vec {
  const v = u.winding > 0 ? { x: 0, y: 0 } : u.vel;
  const atCast = add(u.pos, mul(v, a.delay));
  if (a.speed <= 0) return atCast;
  // Two fixed-point iterations are plenty for lane speeds.
  let p = atCast;
  for (let i = 0; i < 3; i++) p = add(atCast, mul(v, dist(from, p) / a.speed));
  return p;
}

// ---------------------------------------------------------------------------
// Simulation step
// ---------------------------------------------------------------------------

export function step(s: LaneState, dt: number): void {
  s.t += dt;
  for (const k of Object.keys(s.cooldowns) as AbilityKey[]) {
    s.cooldowns[k] = Math.max(0, s.cooldowns[k] - dt);
    s.enemyCooldowns[k] = Math.max(0, s.enemyCooldowns[k] - dt);
  }
  s.flashCd = Math.max(0, s.flashCd - dt);
  s.enemyFlashCd = Math.max(0, s.enemyFlashCd - dt);

  s.nextWave -= dt;
  if (s.nextWave <= 0) {
    spawnWave(s);
    s.nextWave = WAVE_EVERY;
  }

  minionAi(s);
  botAi(s, dt);
  if (s.mode !== "aim") botCasts(s);

  for (const u of s.units) moveAndAttack(s, u, dt);
  for (const shot of s.shots) stepLaneShot(s, shot, dt);
  s.shots = s.shots.filter((x) => !x.done);
  respawns(s, dt);
  // Bodies are removed once their death has been reported.
  s.units = s.units.filter((u) => !(u.dead && u.kind !== "champ"));
}

function moveAndAttack(s: LaneState, u: Unit, dt: number) {
  if (u.dead) return;
  const before = u.pos;
  u.cdLeft = Math.max(0, u.cdLeft - dt);
  if (u.casting > 0) {
    u.casting = Math.max(0, u.casting - dt);
    u.vel = { x: 0, y: 0 };
    return;
  }
  if (u.winding > 0) {
    u.winding -= dt;
    if (u.winding <= 0) {
      const t = byId(s, u.target);
      if (t && !t.dead && dist(t.pos, u.pos) <= u.range + t.radius + u.radius + 60) {
        damage(s, t, u.ad, u.kind === "champ" && u.team === "blue");
        s.events.push({ type: "attack", from: u.id, to: t.id });
      }
      u.cdLeft = u.attackCd;
    }
    u.vel = { x: 0, y: 0 };
    return;
  }
  const t = byId(s, u.target);
  if (t && t.dead) u.target = null;
  if (t && !t.dead) {
    const reach = u.range + t.radius + u.radius;
    if (dist(t.pos, u.pos) <= reach) {
      u.facing = norm(sub(t.pos, u.pos));
      if (u.cdLeft <= 0) u.winding = u.windup;
      u.vel = { x: 0, y: 0 };
      return;
    }
    walk(u, t.pos, dt, reach - 10);
  } else if (u.dest) {
    walk(u, u.dest, dt, 0);
    if (dist(u.pos, u.dest) < 1) u.dest = null;
  }
  u.vel = mul(sub(u.pos, before), 1 / dt);
}

function walk(u: Unit, to: Vec, dt: number, stopAt: number) {
  const d = sub(to, u.pos);
  const l = len(d);
  if (l <= stopAt) return;
  u.facing = norm(d);
  const stepLen = Math.min(l - stopAt, u.speed * dt);
  u.pos = clampLane(add(u.pos, mul(u.facing, stepLen)), u.radius);
}

function damage(s: LaneState, t: Unit, amount: number, byChamp: boolean) {
  if (t.dead) return;
  t.hp -= amount;
  s.events.push({ type: "damage", unit: t.id, amount, byChamp, pos: t.pos });
  if (t.hp <= 0) {
    t.dead = true;
    t.hp = 0;
    t.respawnIn = 3;
    t.dest = null;
    t.target = null;
    s.events.push({ type: "death", unit: t.id });
    for (const u of s.units) if (u.target === t.id) u.target = null;
  }
}

function respawns(s: LaneState, dt: number) {
  for (const u of s.units) {
    if (u.kind !== "champ" || !u.dead) continue;
    u.respawnIn -= dt;
    if (u.respawnIn <= 0) {
      u.dead = false;
      u.hp = u.maxHp;
      u.pos = u.team === "blue" ? { x: 1300, y: 0 } : { x: 2900, y: 0 };
      u.casting = 0;
      u.winding = 0;
    }
  }
}

function minionAi(s: LaneState) {
  for (const m of s.units) {
    if (m.kind === "champ" || m.dead) continue;
    const cur = byId(s, m.target);
    if (cur && !cur.dead && dist(cur.pos, m.pos) < 900) continue;
    const foes = s.units.filter((u) => !u.dead && u.team !== m.team);
    const minions = foes.filter((u) => u.kind !== "champ" && dist(u.pos, m.pos) < 750);
    const pool = minions.length ? minions : foes.filter((u) => u.kind === "champ" && dist(u.pos, m.pos) < 500);
    const t = pool.sort((a, b) => dist(a.pos, m.pos) - dist(b.pos, m.pos))[0];
    m.target = t ? t.id : null;
    m.dest = t ? null : { x: m.team === "blue" ? LANE.x1 : LANE.x0, y: m.pos.y * 0.9 };
  }
}

// ---------------------------------------------------------------------------
// The enemy laner
// ---------------------------------------------------------------------------

function botAi(s: LaneState, dt: number) {
  const b = enemy(s);
  const me = you(s);
  if (b.dead) return;
  const prof = botProfile(s.level);
  s.bot.dodging = Math.max(0, s.bot.dodging - dt);

  // 1. React to spells it has "seen" being cast.
  for (const r of s.bot.reactQueue.filter((q) => q.at <= s.t)) {
    const shot = s.shots.find((x) => x.id === r.shot);
    if (!shot || shot.done) continue;
    if (b.winding > 0 || b.casting > 0) {
      // Locked in an animation: it notices, but can only move once it's free.
      r.at = s.t + Math.max(b.winding, b.casting);
      continue;
    }
    s.bot.reactQueue = s.bot.reactQueue.filter((q) => q !== r);
    if (!threatens(shot, b)) continue;
    if (s.rand() > prof.dodgeChance) continue;
    shot.reacted = true;
    const escape = dodgeTarget(s, shot, b, prof.habit);
    if (escape.canWalk) {
      b.dest = escape.to;
      b.target = null;
      s.bot.dodging = 0.6;
    } else if (b.hp < b.maxHp * 0.35 && s.enemyFlashCd <= 0 && s.rand() < prof.flashChance) {
      const from = b.pos;
      b.pos = clampLane(add(b.pos, mul(norm(sub(escape.to, b.pos)), 400)));
      s.enemyFlashCd = 60;
      s.events.push({ type: "flash", unit: b.id, from, to: b.pos });
    } else {
      b.dest = escape.to; // tries anyway
      b.target = null;
      s.bot.dodging = 0.6;
    }
  }
  s.bot.reactQueue = s.bot.reactQueue.filter((q) => s.shots.some((x) => x.id === q.shot && !x.done));
  if (s.bot.dodging > 0 || b.winding > 0 || b.casting > 0) return;

  // 2. Last-hit: walk up and auto a minion that will die to one hit.
  const lastHit = s.units
    .filter((u) => !u.dead && u.team === "blue" && u.kind !== "champ" && u.hp <= b.ad * 1.1 && dist(u.pos, b.pos) < 900)
    .sort((a, b2) => a.hp - b2.hp)[0];
  if (lastHit) {
    s.bot.lastHitTarget = lastHit.id;
    b.target = lastHit.id;
    b.dest = null;
    return;
  }
  s.bot.lastHitTarget = null;
  if (b.target !== null && byId(s, b.target)?.kind !== "champ") b.target = null;

  // 3. Trade: auto you when you walk into its range.
  //    (Pushing autos on minions come after, so walking up is still punished first.)
  if (!me.dead && dist(me.pos, b.pos) <= b.range + 2 * CHAMP_RADIUS + 20 && b.cdLeft <= 0) {
    b.target = me.id;
    return;
  }
  if (b.target === me.id && dist(me.pos, b.pos) > b.range + 2 * CHAMP_RADIUS + 120) b.target = null;

  // 4. Otherwise hold a spot behind its wave and keep clicking; less disciplined bots auto minions to push.
  if (s.t >= s.bot.nextClick) {
    const [lo, hi] = prof.clickEvery;
    s.bot.nextClick = s.t + lo + s.rand() * (hi - lo);
    if (b.cdLeft <= 0 && s.rand() < prof.pushAuto) {
      const m = s.units.filter((u) => !u.dead && u.team === "blue" && u.kind !== "champ" && dist(u.pos, b.pos) < b.range + 150).sort((x, y) => dist(x.pos, b.pos) - dist(y.pos, b.pos))[0];
      if (m) {
        b.target = m.id;
        b.dest = null;
        return;
      }
    }
    const threat = Math.max(...s.youKit.abilities.filter(isSkillshot).map((a) => a.range), me.range) + prof.spacing;
    const front = waveFront(s, "red");
    const holdX = Math.max(front + 200, me.pos.x + Math.max(450, threat));
    const jitter = { x: (s.rand() - 0.5) * 220, y: (s.rand() - 0.5) * 420 };
    b.dest = clampLane({ x: holdX + jitter.x, y: b.pos.y * 0.5 + jitter.y });
  }
}

/** Furthest x of a team's living minions toward the enemy. */
function waveFront(s: LaneState, team: Team): number {
  const ms = s.units.filter((u) => !u.dead && u.team === team && u.kind !== "champ");
  if (!ms.length) return team === "red" ? 2600 : 1600;
  return team === "red" ? Math.min(...ms.map((m) => m.pos.x)) : Math.max(...ms.map((m) => m.pos.x));
}

/** Would this shot hit the unit if it stood still? */
export function threatens(shot: LaneShot, u: Unit): boolean {
  const a = shot.ability;
  if (a.shape === "circle") return dist(u.pos, shot.target) <= a.width + u.radius;
  return segDist(u.pos, shot.origin, shot.target) <= a.width / 2 + u.radius;
}

/** Picks where to walk to get out of a shot, and whether there's time to make it. */
function dodgeTarget(s: LaneState, shot: LaneShot, u: Unit, habit: number): { to: Vec; canWalk: boolean } {
  const a = shot.ability;
  let to: Vec;
  let need: number;
  if (a.shape === "circle") {
    const away = norm(sub(u.pos, shot.target));
    need = a.width + u.radius - dist(u.pos, shot.target) + 25;
    to = add(u.pos, mul(away, need + 40));
  } else {
    // Perpendicular to the missile, toward its favourite side unless that's into a wall.
    const perp = { x: -shot.dir.y, y: shot.dir.x };
    const offset = (u.pos.x - shot.origin.x) * perp.x + (u.pos.y - shot.origin.y) * perp.y;
    let side: number = s.rand() < habit ? s.bot.favSide : -s.bot.favSide;
    const probe = add(u.pos, mul(perp, side * 300));
    if (Math.abs(probe.y) > LANE.halfWidth - 80) side = -side;
    need = a.width / 2 + u.radius - side * offset + 25;
    to = add(u.pos, mul(perp, side * (Math.max(need, 0) + 40)));
  }
  to = clampLane(to);
  const along = a.shape === "circle" ? dist(shot.origin, shot.target) : Math.max(0, (u.pos.x - shot.origin.x) * shot.dir.x + (u.pos.y - shot.origin.y) * shot.dir.y);
  const timeLeft = timeToReach(a, along) - shot.age;
  return { to, canWalk: Math.max(need, 0) / u.speed <= timeLeft };
}

/** Dodge and trade modes: the enemy casts its own skillshots at you. */
function botCasts(s: LaneState) {
  const b = enemy(s);
  const me = you(s);
  if (b.dead || me.dead || b.casting > 0 || b.winding > 0 || s.t < s.bot.nextCast) return;
  const prof = botProfile(s.level);
  const ready = s.enemyKit.abilities.filter((a) => isSkillshot(a) && s.enemyCooldowns[a.key] <= 0 && dist(b.pos, me.pos) <= a.range * 0.95);
  if (!ready.length) {
    // Walk into range of its shortest skillshot if you're too far.
    const shortest = Math.min(...s.enemyKit.abilities.filter(isSkillshot).map((a) => a.range));
    if (Number.isFinite(shortest) && dist(b.pos, me.pos) > shortest) b.dest = clampLane(add(me.pos, mul(norm(sub(b.pos, me.pos)), shortest * 0.85)));
    return;
  }
  const a = ready[Math.floor(s.rand() * ready.length)];
  const ideal = idealAim(b.pos, me, a);
  const aim = add(mul(me.pos, 1 - prof.lead), mul(ideal, prof.lead));
  const spread = 80 * (1 - prof.lead);
  const shot = makeShot(s, b, a, add(aim, { x: (s.rand() - 0.5) * spread, y: (s.rand() - 0.5) * spread }));
  shot.situation = me.winding > 0 ? "attacking" : me.target !== null ? "farming" : "free";
  s.enemyCooldowns[a.key] = Math.max(2, (a.cooldown || 6) * 0.35);
  const [lo, hi] = prof.castGap;
  s.bot.nextCast = s.t + lo + s.rand() * (hi - lo);
}

// ---------------------------------------------------------------------------
// Spells in flight
// ---------------------------------------------------------------------------

function stepLaneShot(s: LaneState, shot: LaneShot, dt: number) {
  if (shot.done) return;
  shot.age += dt;
  const a = shot.ability;
  const foes = s.units.filter((u) => !u.dead && u.team !== shot.team);
  if (a.shape === "circle") {
    if (shot.age < timeToReach(a, dist(shot.origin, shot.target))) return;
    for (const u of foes) if (dist(u.pos, shot.target) <= a.width + u.radius) hitUnit(s, shot, u);
    finish(s, shot);
    return;
  }
  if (shot.age < a.delay) return;
  const before = shot.travelled;
  shot.travelled = a.speed > 0 ? Math.min(a.range, before + a.speed * Math.min(dt, shot.age - a.delay)) : a.range;
  const p0 = add(shot.origin, mul(shot.dir, before));
  const p1 = add(shot.origin, mul(shot.dir, shot.travelled));
  const touched = foes
    .filter((u) => !shot.hitIds.includes(u.id) && segDist(u.pos, p0, p1) <= a.width / 2 + u.radius)
    .sort((x, y) => dist(x.pos, p0) - dist(y.pos, p0));
  for (const u of touched) {
    hitUnit(s, shot, u);
    if (a.stopsAfter && shot.hitIds.length >= a.stopsAfter) {
      shot.travelled = Math.max(0, (u.pos.x - shot.origin.x) * shot.dir.x + (u.pos.y - shot.origin.y) * shot.dir.y);
      finish(s, shot);
      return;
    }
  }
  if (shot.travelled >= a.range) finish(s, shot);
}

function hitUnit(s: LaneState, shot: LaneShot, u: Unit) {
  shot.hitIds.push(u.id);
  damage(s, u, u.kind === "champ" ? SKILLSHOT_DAMAGE : SKILLSHOT_DAMAGE * 1.5, shot.team === "blue");
}

function finish(s: LaneState, shot: LaneShot) {
  shot.done = true;
  const champId = shot.team === "blue" ? s.enemy : s.you;
  const champ = byId(s, champId)!;
  const hitChamp = shot.hitIds.includes(champId);
  const blocked = !hitChamp && shot.hitIds.length > 0 && !!shot.ability.stopsAfter && shot.hitIds.length >= shot.ability.stopsAfter;
  shot.outcome = hitChamp ? "hit" : blocked ? "blocked" : shot.reacted ? "dodged" : "missed";
  s.events.push({ type: "resolved", shot: shot.id, team: shot.team, outcome: shot.outcome, situation: shot.situation, note: coach(shot, champ) });
}

/** One line of coaching for a shot, or null when there's nothing worth saying. */
function coach(shot: LaneShot, target: Unit): string | null {
  const mine = shot.team === "blue";
  if (!mine) {
    if (shot.outcome !== "hit") return null;
    return shot.situation === "attacking"
      ? "Hit while you were auto-attacking. They cast into your wind-up. Trade autos from outside their range."
      : "Walk sideways to the line as soon as you see the cast. Don't run along it.";
  }
  switch (shot.outcome) {
    case "hit":
      return null;
    case "blocked":
      return "Minion block. Wait for a gap in the wave or move to a new angle.";
    case "dodged":
      return shot.situation === "attacking"
        ? null
        : "They saw it coming. Cast while they're locked in an auto-attack, or aim where they dodge to.";
    case "missed": {
      if (!shot.ideal) return null;
      const off = shot.ability.shape === "circle" ? dist(shot.target, shot.ideal) : segDist(shot.ideal, shot.origin, shot.target);
      if (off < shot.ability.width + target.radius) return null; // close: no correction (bandwidth feedback)
      return aimedBehind(shot, target) ? "Behind them. Lead where they're walking, not where they stand." : "Too far ahead. They didn't walk that far: aim a bit closer.";
    }
    default:
      return null;
  }
}

/**
 * Whether a missed shot trailed the target (true) or over-led it (false):
 * the target needed the spell further along its direction of travel.
 */
export function aimedBehind(shot: Pick<LaneShot, "origin" | "dir" | "target" | "ideal" | "ability">, target: Pick<Unit, "vel">): boolean {
  if (!shot.ideal) return false;
  if (shot.ability.shape === "circle") {
    return (shot.ideal.x - shot.target.x) * target.vel.x + (shot.ideal.y - shot.target.y) * target.vel.y > 0;
  }
  const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
  return Math.sign(cross(shot.dir, sub(shot.ideal, shot.origin))) === Math.sign(cross(shot.dir, target.vel));
}

/** Remaining cooldown fraction for the ability bar. */
export function cooldownFrac(s: LaneState, key: AbilityKey): number {
  const a = s.youKit.abilities.find((x) => x.key === key);
  if (!a || s.cooldowns[key] <= 0) return 0;
  const full = s.realCooldowns ? a.cooldown || 6 : Math.max(1.2, (a.cooldown || 6) * 0.25);
  return s.cooldowns[key] / full;
}
