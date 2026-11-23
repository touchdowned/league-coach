import { Ability, AbilityKey, curatedCombos, curatedKit, defaultCombos, Kit, Shape } from "./kits";

/** The part of a Data Dragon `champion/{id}.json` entry we read. */
export interface DdChampion {
  id: string;
  name: string;
  stats: { movespeed: number; attackrange?: number };
  spells: {
    id: string;
    name: string;
    description: string;
    cooldown: number[];
    range: number[];
    image: { full: string };
  }[];
}

const KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

/** Guess a spell's shape from its Data Dragon text, for champions without curated data. */
export function guessShape(description: string, range: number): Pick<Ability, "shape" | "width" | "speed" | "delay"> {
  const d = description.toLowerCase();
  if (range >= 25000 || range <= 0) return { shape: "self", width: 0, speed: 0, delay: 0 };
  if (/\b(dash|leap|lunge|blink|jump|teleport)/.test(d)) return { shape: "dash", width: 0, speed: 0, delay: 0 };
  if (/\b(fires?|throws?|hurls?|launch(es)?|sends?|missile|bolt|line|spear|skillshot)\b/.test(d))
    return { shape: "line", width: 70, speed: 1500, delay: 0.25 };
  if (/\b(area|zone|location|ground|circle|target area)\b/.test(d)) return { shape: "circle", width: 225, speed: 0, delay: 0.5 };
  if (/\b(enemy|target)\b/.test(d)) return { shape: "target", width: 0, speed: 0, delay: 0 };
  return { shape: "self", width: 0, speed: 0, delay: 0 };
}

/** Builds a kit from Data Dragon, using curated shapes where we have them. */
export function kitFromDdragon(dd: DdChampion, extra?: Partial<Record<AbilityKey, { speed?: number; range?: number }>>): Kit {
  const curated = curatedKit(dd.id);
  const abilities: Ability[] = dd.spells.slice(0, 4).map((s, i) => {
    const key = KEYS[i];
    const range = s.range[0] ?? 0;
    const shape = curated?.find((c) => c.key === key) ?? { key, range, stopsAfter: 0, ...guessShape(s.description, range) };
    const a: Ability = {
      ...shape,
      key,
      name: s.name,
      cooldown: s.cooldown[0] ?? 0,
      icon: s.image.full,
    };
    const x = extra?.[key];
    if (x && (a.shape === "line" || a.shape === "circle")) {
      if (x.speed && x.speed >= 300 && x.speed <= 6000 && a.speed > 0) a.speed = x.speed;
      if (x.range && x.range >= 200 && x.range <= 6000 && Math.abs(x.range - a.range) / a.range < 0.5) a.range = x.range;
    }
    return a;
  });
  const combos = curatedCombos(dd.id);
  return {
    champion: dd.id,
    moveSpeed: dd.stats.movespeed || 340,
    attackRange: dd.stats.attackrange || 525,
    abilities,
    combos: combos.length ? combos : defaultCombos(abilities),
    source: curated ? "curated" : "guessed",
  };
}

/** Kit with no network: curated shapes and placeholder names. */
export function offlineKit(champion: string): Kit | null {
  const curated = curatedKit(champion);
  if (!curated) return null;
  const abilities = curated.map((c) => ({ ...c, name: c.key, cooldown: 0 }));
  const combos = curatedCombos(champion);
  return { champion, moveSpeed: 340, abilities, combos: combos.length ? combos : defaultCombos(abilities), source: "curated" };
}

/**
 * Reads missile speed and cast range from a Community Dragon `{champion}.bin.json`.
 * The file maps paths like `Characters/Ahri/Spells/AhriOrbofDeceptionAbility/AhriOrbofDeception`
 * to objects with an `mSpell` block; the champion record lists the four spell names in order.
 * The format isn't documented, so anything unexpected yields no data rather than an error.
 */
export function speedsFromCdragon(bin: unknown, champion: string): Partial<Record<AbilityKey, { speed?: number; range?: number }>> {
  const out: Partial<Record<AbilityKey, { speed?: number; range?: number }>> = {};
  if (!bin || typeof bin !== "object") return out;
  const entries = Object.entries(bin as Record<string, unknown>);
  const root = entries.find(([k]) => k.toLowerCase() === `characters/${champion.toLowerCase()}/characterrecords/root`)?.[1] as
    | { spellNames?: string[] }
    | undefined;
  const names = root?.spellNames;
  if (!Array.isArray(names)) return out;

  names.slice(0, 4).forEach((name, i) => {
    const suffix = `/${String(name).toLowerCase()}`;
    const hit = entries.find(([k, v]) => k.toLowerCase().endsWith(suffix) && !!v && typeof v === "object" && "mSpell" in v);
    const spell = (hit?.[1] as { mSpell?: Record<string, unknown> } | undefined)?.mSpell;
    if (!spell) return;
    const num = (v: unknown) => (typeof v === "number" ? v : Array.isArray(v) && typeof v[0] === "number" ? v[0] : undefined);
    const movement = (spell.mMissileSpec as { movementComponent?: { mSpeed?: unknown } } | undefined)?.movementComponent;
    const speed = num(spell.missileSpeed) ?? num(movement?.mSpeed);
    const range = num(spell.castRange);
    if (speed || range) out[KEYS[i]] = { speed, range };
  });
  return out;
}

export const SKILLSHOT_SHAPES: Shape[] = ["line", "circle"];
