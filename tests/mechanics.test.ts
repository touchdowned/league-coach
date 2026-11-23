import { describe, expect, it } from "vitest";
import { buildReport } from "../src/core/analysis";
import { guessShape, kitFromDdragon, offlineKit, speedsFromCdragon, type DdChampion } from "../src/core/mechanics/data";
import { CURATED_CHAMPIONS, curatedCombos, curatedKit, defaultCombos } from "../src/core/mechanics/kits";
import { comboTargetMs, gradeCombo, interleave, recordSet, EMPTY_MECHANICS, START, stepStair, suggestedDrill, trainingPool } from "../src/core/mechanics/plan";
import { applyEvent, EMPTY_PROGRESS } from "../src/core/progress";
import { aimErrorDeg, cast, dist, enemyAim, HITBOX, leadPoint, mover, rng, stepDummy, stepShot, Vec } from "../src/core/mechanics/sim";
import { makeGame, ME } from "./fixtures";

const Q = { key: "Q" as const, shape: "line" as const, range: 1000, width: 70, speed: 1500, delay: 0.25 };

function fly(shot: ReturnType<typeof cast>, target: Vec, vel: Vec, seconds = 2) {
  let p = target;
  const dt = 1 / 120;
  for (let t = 0; t < seconds && !shot.done; t += dt) {
    p = { x: p.x + vel.x * dt, y: p.y + vel.y * dt };
    stepShot(shot, dt, p);
  }
  return shot.hit;
}

describe("kits", () => {
  it("parses every curated champion", () => {
    expect(CURATED_CHAMPIONS.length).toBeGreaterThan(60);
    for (const c of CURATED_CHAMPIONS) {
      const k = curatedKit(c)!;
      expect(k.map((a) => a.key)).toEqual(["Q", "W", "E", "R"]);
      for (const a of k) if (a.shape === "line" || a.shape === "circle") expect(a.range).toBeGreaterThan(0);
    }
  });

  it("only uses curated combo inputs the champion has", () => {
    for (const c of CURATED_CHAMPIONS) for (const combo of curatedCombos(c)) expect(combo.inputs.length).toBeGreaterThan(1);
  });

  it("builds fallback combos that lead with the longest skillshot", () => {
    const combos = defaultCombos([
      { key: "Q", shape: "target", range: 600 },
      { key: "W", shape: "self", range: 0 },
      { key: "E", shape: "line", range: 900 },
      { key: "R", shape: "self", range: 0 },
    ]);
    expect(combos[0].inputs[0]).toBe("E");
    expect(combos[1].inputs.at(-1)).toBe("R");
  });
});

describe("data", () => {
  const dd: DdChampion = {
    id: "Ahri",
    name: "Ahri",
    stats: { movespeed: 330 },
    spells: ["Orb of Deception", "Fox-Fire", "Charm", "Spirit Rush"].map((name, i) => ({
      id: `Ahri${i}`,
      name,
      description: "",
      cooldown: [7, 9, 12, 130],
      range: [880, 725, 975, 450],
      image: { full: `Ahri${i}.png` },
    })),
  };

  it("merges Data Dragon names with curated shapes", () => {
    const kit = kitFromDdragon(dd);
    expect(kit.source).toBe("curated");
    expect(kit.moveSpeed).toBe(330);
    expect(kit.abilities[0]).toMatchObject({ key: "Q", name: "Orb of Deception", shape: "line", cooldown: 7, icon: "Ahri0.png" });
    expect(kit.combos[0].name).toBe("Charm combo");
  });

  it("takes Community Dragon speeds only when they are sane", () => {
    const kit = kitFromDdragon(dd, { Q: { speed: 2500 }, E: { speed: 99999 } });
    expect(kit.abilities[0].speed).toBe(2500);
    expect(kit.abilities[2].speed).toBe(1550);
  });

  it("guesses shapes for unknown champions from spell text", () => {
    expect(guessShape("Fires a bolt in a line", 1000).shape).toBe("line");
    expect(guessShape("Dashes to a location", 400).shape).toBe("dash");
    expect(guessShape("Slams the target area", 700).shape).toBe("circle");
    expect(guessShape("Gains movement speed", 25000).shape).toBe("self");
    const kit = kitFromDdragon({ ...dd, id: "Nobody" });
    expect(kit.source).toBe("guessed");
    expect(kit.combos.length).toBeGreaterThan(0);
  });

  it("reads missile speed from a Community Dragon bin", () => {
    const bin = {
      "Characters/Ahri/CharacterRecords/Root": { spellNames: ["AhriOrbofDeception", "AhriFoxFire", "AhriSeduce", "AhriTumble"] },
      "Characters/Ahri/Spells/AhriOrbofDeceptionAbility/AhriOrbofDeception": { mSpell: { missileSpeed: 1750, castRange: [970] } },
      "Characters/Ahri/Spells/AhriSeduceAbility/AhriSeduce": { mSpell: { mMissileSpec: { movementComponent: { mSpeed: 1550 } } } },
    };
    expect(speedsFromCdragon(bin, "Ahri")).toEqual({ Q: { speed: 1750, range: 970 }, E: { speed: 1550, range: undefined } });
    expect(speedsFromCdragon(null, "Ahri")).toEqual({});
    expect(speedsFromCdragon({ junk: 1 }, "Ahri")).toEqual({});
  });

  it("has an offline kit for curated champions only", () => {
    expect(offlineKit("Syndra")?.abilities).toHaveLength(4);
    expect(offlineKit("Nobody")).toBeNull();
  });
});

describe("sim", () => {
  const from = { x: 0, y: 0 };

  it("hits a still target in range and misses one out of range", () => {
    expect(fly(cast("you", Q, from, { x: 800, y: 0 }), { x: 800, y: 0 }, { x: 0, y: 0 })).toBe(true);
    expect(fly(cast("you", Q, from, { x: 1200, y: 0 }), { x: 1200, y: 0 }, { x: 0, y: 0 })).toBe(false);
  });

  it("misses a moving target aimed at directly but hits it with the lead point", () => {
    const target = { x: 800, y: 0 };
    const vel = { x: 0, y: 350 };
    expect(fly(cast("you", Q, from, target), target, vel)).toBe(false);
    const lead = leadPoint(from, target, vel, Q);
    expect(fly(cast("you", Q, from, lead), target, vel)).toBe(true);
  });

  it("resolves area spells where they land after the delay", () => {
    const circle = { key: "Q" as const, shape: "circle" as const, range: 800, width: 200, speed: 0, delay: 0.6 };
    expect(fly(cast("you", circle, from, { x: 600, y: 0 }), { x: 600, y: 0 }, { x: 0, y: 340 })).toBe(true); // moved 204 < 265
    expect(fly(cast("you", circle, from, { x: 600, y: 0 }), { x: 600, y: 0 }, { x: 0, y: 500 })).toBe(false); // moved 300
  });

  it("does not tunnel through a target with a fast missile", () => {
    const fast = { ...Q, speed: 6000, width: 10 };
    expect(fly(cast("you", fast, from, { x: 500, y: 0 }), { x: 500, y: HITBOX }, { x: 0, y: 0 })).toBe(true);
  });

  it("measures signed aim error", () => {
    expect(aimErrorDeg(from, { x: 1, y: 1 }, { x: 1, y: 0 })).toBeCloseTo(45);
    expect(aimErrorDeg(from, { x: 1, y: -1 }, { x: 1, y: 0 })).toBeCloseTo(-45);
  });

  it("keeps the dummy near you and inside the arena", () => {
    const r = rng(1);
    const you = { x: 900, y: 550 };
    const m = mover({ x: 1400, y: 550 }, 340);
    for (let i = 0; i < 120 * 30; i++) stepDummy(m, 1 / 120, you, 10, r, []);
    expect(dist(m.pos, you)).toBeLessThan(1300);
    expect(m.pos.x).toBeGreaterThan(0);
  });

  it("aims better at higher levels", () => {
    const you = mover({ x: 500, y: 500 }, 340);
    you.vel = { x: 0, y: 340 };
    const ideal = leadPoint({ x: 1300, y: 500 }, you.pos, you.vel, Q);
    const err = (level: number) => {
      const r = rng(7);
      let sum = 0;
      for (let i = 0; i < 200; i++) sum += dist(enemyAim({ x: 1300, y: 500 }, you, Q, level, r), ideal);
      return sum / 200;
    };
    expect(err(20)).toBeLessThan(err(1));
  });
});

describe("plan", () => {
  it("converges near 70% success with a 2-down/1-up staircase", () => {
    // Simulated player whose hit rate falls as level rises.
    const r = rng(3);
    let s = START;
    let hits = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const p = 1 - s.level / 22;
      const hit = r() < p;
      hits += hit ? 1 : 0;
      s = stepStair(s, hit);
    }
    expect(hits / n).toBeGreaterThan(0.64);
    expect(hits / n).toBeLessThan(0.77);
  });

  it("grades combos for order, speed and the slowest gap", () => {
    const combo = { name: "x", inputs: ["E", "Q", "W"] as ("E" | "Q" | "W")[], use: "" };
    const target = comboTargetMs(combo, 1);
    expect(target).toBe(900);
    expect(comboTargetMs(combo, 20)).toBeLessThan(target);
    const ok = gradeCombo(combo, { inputs: ["E", "Q", "W"], times: [0, 100, 500] }, 1);
    expect(ok).toMatchObject({ correct: true, withinTarget: true, durationMs: 500, slowestGapAt: 2 });
    const slow = gradeCombo(combo, { inputs: ["E", "Q", "W"], times: [0, 600, 1200] }, 1);
    expect(slow).toMatchObject({ correct: true, withinTarget: false });
    const wrong = gradeCombo(combo, { inputs: ["E", "W"], times: [0, 100] }, 1);
    expect(wrong).toMatchObject({ correct: false, wrongAt: 1 });
  });

  it("interleaves without back-to-back repeats", () => {
    const order = interleave(["a", "b", "c"], 30, rng(2));
    expect(order).toHaveLength(30);
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
  });

  it("picks your most-played mid and top champions with their lane opponents", () => {
    const games = [
      ...Array.from({ length: 4 }, (_, i) => makeGame({ id: `S${i}`, myChamp: "Syndra", myRole: "MIDDLE" })),
      ...Array.from({ length: 2 }, (_, i) => makeGame({ id: `D${i}`, myChamp: "Darius", myRole: "TOP" })),
      ...Array.from({ length: 6 }, (_, i) => makeGame({ id: `J${i}`, myChamp: "LeeSin", myRole: "JUNGLE" })),
    ].map(({ match, timeline }) => buildReport(match, timeline, ME));
    const pool = trainingPool(games);
    expect(pool.map((p) => p.champion)).toEqual(["Syndra", "Darius"]);
    expect(pool[0].opponents.length).toBeGreaterThan(0);
    expect(trainingPool([]).length).toBeGreaterThan(0);
    expect(["aim", "dodge"]).toContain(suggestedDrill(games));
  });

  it("records sets and keeps history bounded", () => {
    let s = EMPTY_MECHANICS;
    for (let i = 0; i < 450; i++) s = recordSet(s, { date: new Date().toISOString(), drill: "aim", champion: "Ahri", score: 0.7, level: 5, detail: 3 }, { level: 5, run: 0 });
    expect(s.history).toHaveLength(400);
    expect(s.stairs["aim:Ahri"].level).toBe(5);
  });

  it("awards XP for a finished set", () => {
    const r = applyEvent(EMPTY_PROGRESS, { type: "drill", score: 1 });
    expect(r.gained).toBe(24);
  });
});
