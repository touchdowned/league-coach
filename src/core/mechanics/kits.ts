/**
 * Ability shapes for the mechanics trainers.
 *
 * Riot's Data Dragon gives names, icons, cooldowns and ranges but not how a spell
 * travels. This table fills that gap for common mid and top champions. Numbers are
 * approximate base values in game units; Community Dragon data, when it loads,
 * overrides missile speed and range (see data.ts). Champions not listed here get
 * shapes guessed from their Data Dragon text.
 *
 * Spec per ability: `KEY:kind range width speed delay`
 *   line   width = full missile width, speed in units/s (0 = instant), delay = cast time in s
 *   circle width = radius, speed = travel speed to the target point (0 = lands after delay)
 *   cone   width = arc in degrees
 *   target / self / dash: only range matters
 */

export type AbilityKey = "Q" | "W" | "E" | "R";
export type Shape = "line" | "circle" | "cone" | "target" | "self" | "dash";

export interface Ability {
  key: AbilityKey;
  name: string;
  shape: Shape;
  range: number;
  width: number;
  speed: number;
  delay: number;
  cooldown: number;
  icon?: string; // Data Dragon spell image file
  /** Units the spell can hit before it stops: 1 = blocked by the first minion, 0 = passes through everything. */
  stopsAfter?: number;
}

export interface Kit {
  champion: string;
  moveSpeed: number;
  /** Auto-attack range in game units (melee ~125-175, ranged ~500-650). */
  attackRange?: number;
  abilities: Ability[];
  combos: Combo[];
  /** "curated" when shapes come from this table, "guessed" when inferred from text. */
  source: "curated" | "guessed";
}

/** Inputs a combo can contain. AA is an auto-attack (right-click on the trainer). */
export type ComboInput = AbilityKey | "AA" | "F";

export interface Combo {
  name: string;
  inputs: ComboInput[];
  /** One line on when to use it. */
  use: string;
}

const RAW: Record<string, string> = {
  // ---- Mid ----
  Ahri: "Q:line 880 100 1550 .25|W:self 700|E:line 975 60 1550 .25|R:dash 450",
  Akali: "Q:cone 500 45 0 .25|W:self 250|E:line 825 60 1800 .4|R:dash 675",
  Anivia: "Q:line 1100 110 950 .25|W:circle 1000 200 0 .25|E:target 650|R:circle 750 400 0 .25",
  Annie: "Q:target 625|W:cone 600 50 0 .25|E:self 800|R:circle 600 290 0 .25",
  Aurora: "Q:line 900 90 1450 .25|W:dash 400|E:cone 825 60 0 .25|R:circle 700 300 0 .25",
  Azir: "Q:line 740 70 1600 .25|W:circle 500 200 0 .25|E:dash 1100|R:line 250 400 1400 .5",
  Brand: "Q:line 1050 60 1600 .25|W:circle 900 260 0 .875|E:target 625|R:target 750",
  Cassiopeia: "Q:circle 850 200 0 .4|W:cone 700 80 0 .25|E:target 700|R:cone 825 80 0 .5",
  Diana: "Q:circle 900 185 1900 .25|W:self 200|E:dash 825|R:self 475",
  Ekko: "Q:line 1075 60 1650 .25|W:circle 1600 375 0 3|E:dash 325|R:self 375",
  Fizz: "Q:dash 550|W:self 0|E:circle 400 330 0 .75|R:line 1300 80 1300 .25",
  Galio: "Q:circle 825 150 1150 .25|W:self 350|E:dash 650|R:target 4000",
  Kassadin: "Q:target 650|W:self 0|E:cone 600 80 0 .25|R:dash 500",
  Katarina: "Q:target 625|W:self 0|E:dash 725|R:self 550",
  Leblanc: "Q:target 700|W:dash 600|E:line 865 55 1750 .25|R:self 0",
  Lissandra: "Q:line 725 75 2200 .25|W:self 450|E:line 1050 125 850 .25|R:target 550",
  Lux: "Q:line 1240 70 1200 .25|W:self 1175|E:circle 1100 310 1200 .25|R:line 3400 100 0 1",
  Malzahar: "Q:circle 900 200 0 .5|W:self 0|E:target 650|R:target 700",
  Morgana: "Q:line 1300 70 1200 .25|W:circle 900 275 0 .25|E:self 800|R:self 625",
  Neeko: "Q:circle 800 200 1500 .25|W:self 0|E:line 1000 70 1300 .25|R:self 600",
  Orianna: "Q:line 825 80 1400 0|W:self 225|E:target 1100|R:self 415",
  Ryze: "Q:line 1000 55 1700 .25|W:target 550|E:target 550|R:self 0",
  Swain: "Q:cone 725 60 0 .25|W:circle 5500 325 0 1.5|E:line 850 85 935 .25|R:self 650",
  Sylas: "Q:line 775 70 0 .4|W:target 400|E:line 850 60 1600 .25|R:target 950",
  Syndra: "Q:circle 800 210 0 .6|W:circle 925 220 1450 .25|E:line 800 100 2500 .25|R:target 675",
  Taliyah: "Q:line 1000 100 3600 .25|W:circle 900 225 0 .85|E:cone 800 80 0 .25|R:self 0",
  Talon: "Q:target 575|W:cone 900 40 2500 .25|E:self 0|R:self 550",
  TwistedFate: "Q:line 1450 40 1000 .25|W:target 600|E:self 0|R:self 5500",
  Veigar: "Q:line 950 70 2200 .25|W:circle 900 240 0 1.25|E:circle 725 375 0 .75|R:target 650",
  Velkoz: "Q:line 1050 50 1300 .25|W:line 1050 87 1700 .25|E:circle 850 225 0 .8|R:line 1550 80 0 .25",
  Vex: "Q:line 1200 160 1700 .15|W:self 475|E:circle 800 250 1300 .25|R:line 2000 130 1600 .25",
  Viktor: "Q:target 600|W:circle 800 290 0 1.5|E:line 1025 80 1050 0|R:circle 700 325 0 .25",
  Vladimir: "Q:target 600|W:self 0|E:self 600|R:circle 625 375 0 .25",
  Xerath: "Q:line 1450 100 0 .5|W:circle 1000 275 0 .75|E:line 1125 60 1400 .25|R:circle 5000 200 0 .6",
  Yasuo: "Q:line 475 40 0 .35|W:self 0|E:dash 475|R:target 1400",
  Yone: "Q:line 450 40 0 .35|W:cone 600 80 0 .5|E:self 0|R:line 1000 225 0 .75",
  Zed: "Q:line 925 50 1700 .25|W:dash 650|E:self 290|R:target 625",
  Ziggs: "Q:circle 850 120 1700 .25|W:circle 1000 250 1750 .25|E:circle 900 325 1750 .25|R:circle 5000 525 1500 .375",
  Zoe: "Q:line 800 50 1200 .25|W:self 0|E:line 800 50 1700 .3|R:dash 575",
  // ---- Top ----
  Aatrox: "Q:line 625 180 0 .6|W:line 825 80 1800 .25|E:dash 300|R:self 0",
  Camille: "Q:self 0|W:cone 610 80 0 1.5|E:line 800 60 1900 0|R:target 475",
  Chogath: "Q:circle 950 250 0 1.2|W:cone 650 60 0 .5|E:self 0|R:target 175",
  Darius: "Q:self 425|W:self 0|E:cone 535 50 0 .25|R:target 460",
  Fiora: "Q:dash 400|W:line 750 70 3200 .75|E:self 0|R:target 500",
  Gangplank: "Q:target 625|W:self 0|E:circle 1000 325 0 .25|R:circle 20000 580 0 .25",
  Garen: "Q:self 0|W:self 0|E:self 325|R:target 400",
  Gnar: "Q:line 1100 60 2500 .25|W:self 0|E:dash 475|R:self 475",
  Gragas: "Q:circle 850 250 1000 .25|W:self 0|E:dash 600|R:circle 1000 400 1800 .25",
  Gwen: "Q:cone 450 80 0 .25|W:self 0|E:dash 350|R:line 1200 60 1800 .25",
  Illaoi: "Q:line 850 100 0 .75|W:self 0|E:line 900 50 1900 .25|R:self 450",
  Irelia: "Q:dash 600|W:self 0|E:line 775 70 2000 0|R:line 1000 160 2000 .4",
  Jax: "Q:dash 700|W:self 0|E:self 300|R:self 0",
  Jayce: "Q:line 1050 70 1450 .21|W:self 0|E:target 240|R:self 0",
  Kayle: "Q:line 900 75 1600 .25|W:self 900|E:self 0|R:target 900",
  Kennen: "Q:line 1050 50 1700 .175|W:self 750|E:self 0|R:self 550",
  KSante: "Q:line 465 75 0 .4|W:dash 450|E:dash 250|R:target 350",
  Malphite: "Q:target 625|W:self 0|E:self 400|R:circle 1000 300 1500 0",
  Mordekaiser: "Q:line 625 160 0 .5|W:self 0|E:line 700 100 0 .9|R:target 650",
  Nasus: "Q:self 0|W:target 700|E:circle 650 400 0 .25|R:self 0",
  Olaf: "Q:line 1000 90 1600 .25|W:self 0|E:target 325|R:self 0",
  Ornn: "Q:line 800 65 1800 .3|W:cone 500 50 0 .25|E:dash 800|R:line 2500 200 1200 .5",
  Pantheon: "Q:line 1200 60 2700 .25|W:target 600|E:self 0|R:circle 5500 700 0 2",
  Quinn: "Q:line 1025 60 1550 .25|W:self 0|E:target 675|R:self 0",
  Renekton: "Q:self 325|W:self 0|E:dash 450|R:self 0",
  Riven: "Q:dash 275|W:self 260|E:dash 250|R:line 1100 200 1600 .25",
  Rumble: "Q:cone 600 60 0 0|W:self 0|E:line 890 60 2000 .25|R:line 1700 200 0 .5",
  Sett: "Q:self 0|W:line 790 200 0 .75|E:self 490|R:target 400",
  Shen: "Q:self 0|W:self 0|E:dash 600|R:target 50000",
  Sion: "Q:line 750 200 0 .75|W:self 0|E:line 800 80 1800 .25|R:dash 7500",
  Teemo: "Q:target 680|W:self 0|E:self 0|R:circle 900 200 1000 .25",
  Trundle: "Q:self 0|W:self 0|E:circle 1000 375 0 .25|R:target 650",
  Tryndamere: "Q:self 0|W:self 850|E:dash 660|R:self 0",
  Urgot: "Q:circle 800 180 0 .6|W:self 0|E:dash 450|R:line 2500 80 3200 .4",
  Volibear: "Q:self 0|W:target 325|E:circle 1200 325 0 2|R:dash 700",
  Yorick: "Q:self 0|W:circle 600 300 0 .25|E:line 700 160 1800 .33|R:self 0",
};

/**
 * Line skillshots that stop on the first unit they hit (1) or after two (2).
 * Everything else passes through minions. Only lines are listed; circles never block.
 */
const STOPS: Record<string, Partial<Record<AbilityKey, number>>> = {
  Ahri: { E: 1 },
  Aatrox: { W: 1 },
  Brand: { Q: 1 },
  Illaoi: { E: 1 },
  Jayce: { Q: 1 },
  Kayle: { Q: 1 },
  Kennen: { Q: 1 },
  Lissandra: { Q: 1 },
  Lux: { Q: 2 },
  Morgana: { Q: 1 },
  Quinn: { Q: 1 },
  Rumble: { E: 1 },
  Ryze: { Q: 1 },
  Sion: { E: 1 },
  Sylas: { E: 1 },
  Taliyah: { Q: 1 },
  Veigar: { Q: 2 },
  Velkoz: { Q: 1 },
  Xerath: { E: 1 },
  Zoe: { E: 1 },
};

/** Combos per champion: the key sequences that win trades and all-ins. */
const COMBOS: Record<string, Combo[]> = {
  Ahri: [
    { name: "Charm combo", inputs: ["E", "Q", "W"], use: "Land charm first, then everything hits." },
    { name: "Charm flash", inputs: ["E", "F", "Q", "W"], use: "Flash after casting E to redirect it from a new angle." },
    { name: "All-in", inputs: ["R", "E", "Q", "W", "R"], use: "Dash in so E is short and hard to dodge." },
  ],
  Akali: [
    { name: "Trade", inputs: ["Q", "AA"], use: "Q then the empowered auto, then walk out." },
    { name: "All-in", inputs: ["E", "E", "Q", "AA", "R", "R"], use: "Mark with E, close in, finish with R2 when low." },
  ],
  Darius: [
    { name: "Pull and stack", inputs: ["E", "AA", "W", "Q"], use: "Pull, auto-reset with W, outer Q." },
    { name: "Execute", inputs: ["E", "AA", "W", "Q", "R"], use: "Dunk only at five stacks or when it kills." },
  ],
  Diana: [{ name: "All-in", inputs: ["Q", "E", "W", "R"], use: "E onto the Q mark for the reset." }],
  Ekko: [{ name: "Stun trade", inputs: ["W", "E", "AA", "Q"], use: "Dash into your W to stun, then Q." }],
  Fiora: [{ name: "Vital trade", inputs: ["Q", "AA", "E", "AA"], use: "Q a vital, E resets autos, leave." }],
  Fizz: [{ name: "Fish all-in", inputs: ["R", "Q", "W", "E"], use: "Shark first, Q through, E to dodge the answer." }],
  Garen: [{ name: "Silence spin", inputs: ["Q", "AA", "E", "R"], use: "Silence, spin, execute." }],
  Gragas: [
    { name: "Body slam flash", inputs: ["E", "F", "Q"], use: "Flash during E for a surprise knockup." },
    { name: "Insec", inputs: ["F", "R", "E", "Q"], use: "Get behind, ult them into your team." },
  ],
  Irelia: [{ name: "Stun dash", inputs: ["E", "E", "Q", "W"], use: "Stun first so Q resets on the mark." }],
  Jax: [{ name: "Leap stun", inputs: ["E", "Q", "AA", "W", "E"], use: "Counter Strike before you jump, recast after." }],
  Katarina: [
    { name: "Dagger reset", inputs: ["Q", "E", "W", "R"], use: "E to the Q dagger for the pickup." },
    { name: "Shunpo engage", inputs: ["E", "W", "Q", "R"], use: "W at their feet so the dagger lands on them." },
  ],
  Leblanc: [
    { name: "Burst", inputs: ["W", "Q", "R", "E"], use: "Dash in, double Q mark, chain." },
    { name: "Safe burst", inputs: ["Q", "R", "W", "E"], use: "Mark from range before you commit W." },
  ],
  Lux: [{ name: "Root combo", inputs: ["Q", "E", "AA", "R"], use: "Land Q first. Only fire R into a rooted target." }],
  Malphite: [{ name: "Engage", inputs: ["R", "E", "AA", "W"], use: "Ult in, slam, autos." }],
  Mordekaiser: [{ name: "Pull and Q", inputs: ["E", "Q", "W", "R"], use: "Pull into an isolated Q." }],
  Orianna: [
    { name: "Ball poke", inputs: ["Q", "W"], use: "Ball on them, then speed field." },
    { name: "Shockwave", inputs: ["Q", "R"], use: "Ball into the group, R a beat later." },
  ],
  Renekton: [{ name: "Slice stun", inputs: ["E", "AA", "W", "Q", "E"], use: "Dice back out with the second E." }],
  Riven: [
    { name: "Fast Q", inputs: ["AA", "Q", "AA", "Q", "AA", "Q"], use: "Auto, Q right as it lands. Rhythm is everything." },
    { name: "Shy combo", inputs: ["E", "R", "F", "W", "AA", "R", "Q"], use: "Flash-W the target, R2 the moment they're stunned." },
  ],
  Sett: [{ name: "Pull trade", inputs: ["Q", "AA", "AA", "E", "W"], use: "Punch twice, pull, true damage W." }],
  Sylas: [{ name: "Chain in", inputs: ["E", "E", "Q", "W"], use: "Land E2 before you commit the rest." }],
  Syndra: [
    { name: "Q-E stun", inputs: ["Q", "E"], use: "E right after Q so the sphere stuns on the way." },
    { name: "Flash stun", inputs: ["Q", "E", "F"], use: "Flash just after E to change its angle." },
    { name: "All-in", inputs: ["Q", "E", "W", "R"], use: "R with as many spheres up as you can." },
  ],
  Yasuo: [
    { name: "EQ circle", inputs: ["E", "Q"], use: "Q during the dash for a circle hit." },
    { name: "EQ flash", inputs: ["E", "Q", "F", "R"], use: "With Q3, flash mid-dash, then ult." },
  ],
  Zed: [
    { name: "Shadow poke", inputs: ["W", "E", "Q"], use: "Shadow first so both Qs land." },
    { name: "All-in", inputs: ["R", "AA", "E", "Q", "W"], use: "Ult, autos, then shadows for the mark pop." },
  ],
  Aatrox: [{ name: "Sweet spots", inputs: ["Q", "E", "Q", "W", "Q"], use: "Use E to land each Q on its edge." }],
  Camille: [{ name: "Hook in", inputs: ["E", "E", "W", "Q", "AA", "Q"], use: "Hook stun, outer W, double Q." }],
};

function parseSpec(champion: string, spec: string): Omit<Ability, "name" | "cooldown">[] {
  return spec.split("|").map((part) => {
    const [key, rest] = part.split(":");
    const [shape, ...nums] = rest.split(" ");
    const [range = 0, width = 0, speed = 0, delay = 0] = nums.map(Number);
    if (!"QWER".includes(key) || !SHAPES.includes(shape as Shape)) throw new Error(`Bad kit spec for ${champion}: ${part}`);
    const stopsAfter = STOPS[champion]?.[key as AbilityKey] ?? 0;
    return { key: key as AbilityKey, shape: shape as Shape, range, width, speed, delay, stopsAfter };
  });
}

const SHAPES: Shape[] = ["line", "circle", "cone", "target", "self", "dash"];

/** Curated shapes for one champion, or null when we only have guesses. */
export function curatedKit(champion: string): Omit<Ability, "name" | "cooldown">[] | null {
  const spec = RAW[champion];
  return spec ? parseSpec(champion, spec) : null;
}

export function curatedCombos(champion: string): Combo[] {
  return COMBOS[champion] ?? [];
}

export const CURATED_CHAMPIONS = Object.keys(RAW).sort();

/** Champions whose kit is curated and mostly played mid or top, used when no games are synced. */
export const STARTER_CHAMPIONS = ["Ahri", "Syndra", "Lux", "Zed", "Yasuo", "Darius", "Riven", "Garen"];

export const isSkillshot = (a: Pick<Ability, "shape">) => a.shape === "line" || a.shape === "circle";

/**
 * Fallback combos for a kit without curated ones: lead with your longest-range
 * crowd control or skillshot, follow with the rest, finish with R.
 */
export function defaultCombos(abilities: Pick<Ability, "key" | "shape" | "range">[]): Combo[] {
  const basics = abilities.filter((a) => a.key !== "R");
  const lead = [...basics].sort((a, b) => Number(isSkillshot(b)) - Number(isSkillshot(a)) || b.range - a.range)[0];
  const rest = basics.filter((a) => a !== lead).map((a) => a.key);
  const keys: ComboInput[] = lead ? [lead.key, ...rest] : rest;
  return [
    { name: "Basic rotation", inputs: keys, use: "Open with your longest-range ability so the rest can follow." },
    { name: "All-in", inputs: [...keys.slice(0, 2), "AA", ...keys.slice(2), "R"], use: "Weave an auto between spells, then R." },
  ];
}
