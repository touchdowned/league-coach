/**
 * The same mistake across games. Each leak carries tags (why, where, when); leaks that
 * share them in several recent games are one habit, priced in gold per game.
 */
import type { Leak, LeakKind, LeakTags } from "./engine";
import type { GameReport } from "./types";

export interface Habit {
  key: string;
  kind: LeakKind;
  title: string;
  detail: string;
  count: number;
  games: number;
  perGame: number;
  examples: { matchId: string; t: number; cost: number }[];
}

const CAUSE: Record<string, string> = {
  ganked: "getting ganked by the jungler",
  "collapsed-on": "getting collapsed on by 3 or more",
  "chased-after-kill": "chasing after you'd already won the fight",
  "died-holding-gold": "dying with 1,300g+ unspent",
  "lost-1v1": "losing a 1v1 to your laner",
  "caught-alone": "getting caught with no teammate in reach",
  "lost-fight": "losing a fight next to your team",
  "fought-into-bigger-wave": "fighting into a bigger minion wave",
  "recalled-into-their-wave": "recalling with their wave walking into your tower",
  "recall-cost-farm": "recalls that cost farm",
  "plates-fell-while-recalling": "losing plates while you recall",
  "sat-on-gold": "sitting on item gold instead of backing",
  "objective-lost-while-recalling": "recalling right before an objective",
  "roam-got-nothing": "roams that got nothing",
  "frozen-out": "getting frozen out of the wave",
  "missed-tower-lasthits": "missing last-hits under your tower",
  "lost-cs-in-lane": "losing CS in lane",
  "dragon-given-free": "giving dragon away with no trade",
  "baron-given-free": "giving baron away with no trade",
};
const PHASE: Record<LeakTags["phase"], string> = { early: "before 14:00", mid: "between 14:00 and 25:00", late: "after 25:00" };
const NOUN: Record<LeakKind, [string, string]> = {
  death: ["death", "deaths"],
  recall: ["recall", "recalls"],
  farm: ["stretch", "stretches"],
  roam: ["roam", "roams"],
  objective: ["objective", "objectives"],
};

interface Item {
  leak: Leak & { tags: LeakTags };
  matchId: string;
}

/** Habits in the last `lastN` games, costliest first. A habit needs 3+ cases in 2+ games. */
export function findHabits(games: GameReport[], lastN = 10): Habit[] {
  const recent = [...games].sort((a, b) => b.metrics.gameCreation - a.metrics.gameCreation).slice(0, lastN).filter((g) => g.leaks);
  if (!recent.length) return [];
  const items: Item[] = recent.flatMap((g) => (g.leaks ?? []).filter((l): l is Item["leak"] => !!l.tags && l.tags.cause !== "other" && !/other$/.test(l.tags.cause)).map((leak) => ({ leak, matchId: g.metrics.matchId })));
  const totalByKind = (k: LeakKind) => items.filter((i) => i.leak.kind === k).length;

  // Group at several levels of detail; keep the most specific group that still repeats.
  const levels: ((i: Item) => string | null)[] = [
    (i) => `${i.leak.kind}|${i.leak.tags.cause}|${i.leak.tags.area}|${i.leak.tags.phase}`,
    (i) => `${i.leak.kind}|${i.leak.tags.cause}|${i.leak.tags.area}|`,
    (i) => `${i.leak.kind}|${i.leak.tags.cause}||${i.leak.tags.phase}`,
    (i) => `${i.leak.kind}|${i.leak.tags.cause}||`,
  ];
  const out: Habit[] = [];
  const claimed = new Set<string>(); // kind|cause already reported
  for (const level of levels) {
    const groups = new Map<string, Item[]>();
    for (const i of items) {
      const k = level(i);
      if (k) groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    for (const [key, list] of groups) {
      const [kind, cause, area, phase] = key.split("|") as [LeakKind, string, string, LeakTags["phase"] | ""];
      if (claimed.has(`${kind}|${cause}`)) continue;
      const nGames = new Set(list.map((i) => i.matchId)).size;
      if (list.length < 3 || nGames < 2) continue;
      claimed.add(`${kind}|${cause}`);
      const gold = list.reduce((s, i) => s + i.leak.cost, 0);
      const where = [area ? `in ${area}` : "", phase ? PHASE[phase] : ""].filter(Boolean).join(", ");
      const what = CAUSE[cause] ?? cause.replace(/-/g, " ");
      const total = totalByKind(kind);
      let detail = `${list.length} of your last ${total} ${NOUN[kind][1]}, in ${nGames} of your last ${recent.length} games. About ${Math.round(gold / recent.length).toLocaleString("en-US")}g a game.`;
      if (kind === "death") {
        const seen = list.filter((i) => i.leak.tags.vision === "seen").length;
        const unseen = list.filter((i) => i.leak.tags.vision === "unseen").length;
        if (seen + unseen >= 2)
          detail += ` In the ${seen + unseen} with the replay read, the killer had shown on your minimap first ${seen === 1 ? "once" : `${seen} times`}${unseen ? ` and came from fog ${unseen === 1 ? "once" : `${unseen} times`}` : ""}.`;
      }
      out.push({
        key,
        kind,
        title: `${cap(what)}${where ? `, ${where}` : ""}`,
        detail,
        count: list.length,
        games: nGames,
        perGame: Math.round(gold / recent.length),
        examples: list.map((i) => ({ matchId: i.matchId, t: i.leak.t, cost: i.leak.cost })).sort((a, b) => b.cost - a.cost),
      });
    }
  }
  return out.sort((a, b) => b.perGame - a.perGame);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
