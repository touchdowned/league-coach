import { describe, expect, it } from "vitest";
import { offlineKit } from "../src/core/mechanics/data";
import { castAt, createLane, enemy, LaneState, rightClick, step, you } from "../src/core/mechanics/lane";
import { rng } from "../src/core/mechanics/sim";

const DT = 1 / 60;
const run = (s: LaneState, sec: number) => {
  for (let t = 0; t < sec; t += DT) step(s, DT);
};

function lane(champ: string, opts: { level?: number; minions?: boolean; seed?: number } = {}) {
  const s = createLane({ mode: "aim", you: offlineKit(champ)!, enemy: offlineKit("Ahri")!, level: opts.level ?? 10, rand: rng(opts.seed ?? 1) });
  if (!opts.minions) s.units = s.units.filter((u) => u.kind === "champ");
  s.nextWave = 1e9;
  return s;
}

/** Freezes the enemy so only the spell decides the result. */
function freeze(s: LaneState) {
  const e = enemy(s);
  e.speed = 0;
  s.bot.reactQueue = [];
}

describe("lane", () => {
  it("minion waves meet and fight", () => {
    const s = createLane({ mode: "aim", you: offlineKit("Ahri")!, enemy: offlineKit("Syndra")!, level: 5, rand: rng(2) });
    const before = s.units.filter((u) => u.kind !== "champ").length;
    run(s, 20);
    expect(before).toBe(12);
    expect(s.units.filter((u) => u.kind !== "champ").length).toBeLessThan(before + 1);
    expect(s.units.some((u) => u.kind !== "champ" && u.hp < u.maxHp)).toBe(true);
  });

  it("blocks a minion-blocked skillshot on the first minion but lets a piercing one through", () => {
    for (const [champ, key, expectHit] of [
      ["Morgana", "Q", false],
      ["Ahri", "Q", true],
    ] as const) {
      const s = lane(champ);
      const me = you(s);
      const e = enemy(s);
      me.pos = { x: 1500, y: 0 };
      e.pos = { x: 2100, y: 0 };
      freeze(s);
      s.units.push({ ...e, id: 999, team: "red", kind: "caster", pos: { x: 1800, y: 0 }, radius: 48, hp: 500, maxHp: 500, dead: false });
      const hp = e.hp;
      castAt(s, key, e.pos);
      run(s, 1.5);
      expect(e.hp < hp).toBe(expectHit);
    }
  });

  it("roots you for the cast time, then resumes your move order", () => {
    const s = lane("Lux");
    const me = you(s);
    me.pos = { x: 1500, y: 0 };
    rightClick(s, { x: 1500, y: 400 });
    run(s, 0.1);
    castAt(s, "Q", { x: 2500, y: 0 });
    const y0 = me.pos.y;
    run(s, 0.2);
    expect(me.pos.y).toBeCloseTo(y0, 5);
    run(s, 0.5);
    expect(me.pos.y).toBeGreaterThan(y0 + 50);
  });

  it("dodges more at higher levels and never during its auto-attack wind-up", () => {
    const dodges = (level: number) => {
      let n = 0;
      for (let i = 0; i < 40; i++) {
        const s = lane("Lux", { level, seed: i + 1 });
        const me = you(s);
        const e = enemy(s);
        me.pos = { x: 1500, y: 0 };
        e.pos = { x: 2500, y: 0 };
        e.dest = null;
        s.bot.nextClick = 1e9;
        const hp = e.hp;
        castAt(s, "Q", e.pos);
        run(s, 1.5);
        if (e.hp === hp) n++;
      }
      return n;
    };
    expect(dodges(20)).toBeGreaterThan(dodges(1));

    const s = lane("Lux", { level: 20 });
    const me = you(s);
    const e = enemy(s);
    me.pos = { x: 1500, y: 0 };
    e.pos = { x: 2500, y: 0 };
    s.bot.nextClick = 1e9;
    e.winding = 2; // locked in an animation for the whole flight
    const hp = e.hp;
    const shot = castAt(s, "Q", e.pos)!;
    expect(shot.situation).toBe("attacking");
    run(s, 1.2);
    expect(e.hp).toBeLessThan(hp);
  });

  it("casts back at you in dodge mode", () => {
    const s = createLane({ mode: "dodge", you: offlineKit("Ahri")!, enemy: offlineKit("Lux")!, level: 10, rand: rng(4) });
    s.units = s.units.filter((u) => u.kind === "champ");
    const hp = you(s).hp;
    let casts = 0;
    for (let t = 0; t < 20; t += DT) {
      step(s, DT);
      casts += s.events.filter((e) => e.type === "cast" && e.team === "red").length;
      s.events = [];
    }
    expect(casts).toBeGreaterThan(2);
    expect(you(s).hp).toBeLessThan(hp);
  });
});

describe("aim feedback", () => {
  it("tells trailing shots from over-led ones", async () => {
    const { aimedBehind } = await import("../src/core/mechanics/lane");
    const ability = { shape: "line" } as never;
    const base = { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, target: { x: 1000, y: 0 }, ability };
    // Target walking +y; it needed the spell at y=+100: we aimed behind.
    expect(aimedBehind({ ...base, ideal: { x: 800, y: 100 } }, { vel: { x: 0, y: 340 } })).toBe(true);
    expect(aimedBehind({ ...base, ideal: { x: 800, y: -100 } }, { vel: { x: 0, y: 340 } })).toBe(false);
  });
});
