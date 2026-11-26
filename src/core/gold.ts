/**
 * Gold between the timeline's one-minute frames.
 *
 * Riot gives each player's currentGold and totalGold once a minute. In between:
 *   current(t) = current(f0) + earned(f0..t) - spent(f0..t)
 *  - earned: kill bounties land at the kill, to the millisecond. Everything else
 *    (minions, monsters, assists, plates, passive income) is the rest of the minute's
 *    totalGold change, spread evenly over the minute.
 *  - spent: each purchase's price, from Data Dragon. Buying an item with its components
 *    in your inventory costs the price minus those components (they show up as
 *    ITEM_DESTROYED at the same moment). Sells give back the sell price; undos give back
 *    what the event says.
 * It's an estimate, labelled as one, and checked against the next frame (see checkGold).
 */
import type { TimelineDto, TimelineEvent } from "./types";

export interface ItemInfo {
  total: number;
  sell: number;
  from?: number[];
}
export type ItemTable = Record<number, ItemInfo>;

/** Data Dragon's item.json (`data`) to prices and recipes. */
export function itemTable(ddragon: { data: Record<string, { gold: { total: number; sell: number }; from?: string[] }> }): ItemTable {
  const out: ItemTable = {};
  for (const [id, it] of Object.entries(ddragon.data)) out[Number(id)] = { total: it.gold.total, sell: it.gold.sell, from: it.from?.map(Number) };
  return out;
}

const events = (tl: TimelineDto) => tl.info.frames.flatMap((f) => f.events ?? []).sort((a, b) => a.timestamp - b.timestamp);

/** Gold one player spent (positive) or got back (negative) on one item event. */
export function spendOf(e: TimelineEvent, all: TimelineEvent[], items: ItemTable): number {
  if (e.type === "ITEM_PURCHASED") {
    const it = items[e.itemId!];
    if (!it) return 0;
    // Components used up by this purchase: destroyed at the same moment, and part of its recipe.
    const recipe = [...(it.from ?? [])];
    let credit = 0;
    for (const d of all) {
      if (d.type !== "ITEM_DESTROYED" || d.participantId !== e.participantId || Math.abs(d.timestamp - e.timestamp) > 50) continue;
      const k = recipe.indexOf(d.itemId!);
      // Built items can also eat a part Data Dragon's recipe doesn't list (seen on a real
      // replay: a jungle item's Glowing Mote); anything else destroyed at the same moment
      // as a built item counts as used up by it. Plain buys (a ward, a potion) never do.
      if (k < 0 && !it.from?.length) continue;
      if (k >= 0) recipe.splice(k, 1);
      credit += items[d.itemId!]?.total ?? 0;
    }
    return it.total - credit;
  }
  if (e.type === "ITEM_SOLD") return -(items[e.itemId!]?.sell ?? 0);
  if (e.type === "ITEM_UNDO") return -(e.goldGain ?? 0);
  return 0;
}

/** Bounty gold that lands on one player at one event. */
function eventGold(e: TimelineEvent, pid: number): number {
  if (e.type === "CHAMPION_KILL" && e.killerId === pid) return (e.bounty ?? 0) + (e.shutdownBounty ?? 0);
  return 0;
}

export interface GoldModel {
  /** Estimated current gold of participant `pid` at game time t (ms). */
  at(pid: number, t: number): number;
}

export function goldModel(tl: TimelineDto, items: ItemTable): GoldModel {
  const frames = tl.info.frames;
  const all = events(tl);
  return {
    at(pid, t) {
      let i = 0;
      while (i + 1 < frames.length && frames[i + 1].timestamp <= t) i++;
      const f0 = frames[i];
      const f1 = frames[i + 1];
      const p0 = f0.participantFrames[pid];
      if (!p0) return 0;
      const inMinute = all.filter((e) => e.timestamp > f0.timestamp && e.timestamp <= (f1?.timestamp ?? Infinity));
      const bounty = (upTo: number) => inMinute.filter((e) => e.timestamp <= upTo).reduce((s, e) => s + eventGold(e, pid), 0);
      const spent = (upTo: number) => inMinute.filter((e) => e.participantId === pid && e.timestamp <= upTo).reduce((s, e) => s + spendOf(e, all, items), 0);
      let rate = 0;
      if (f1) {
        const p1 = f1.participantFrames[pid];
        rate = (p1.totalGold - p0.totalGold - bounty(f1.timestamp)) / (f1.timestamp - f0.timestamp);
      }
      return Math.round(p0.currentGold + bounty(t) + rate * (t - f0.timestamp) - spent(t));
    },
  };
}

/**
 * Two checks against Riot's own numbers:
 *  - spend: frame f0's currentGold, plus the minute's totalGold change, minus what the
 *    model says was spent, should equal frame f1's currentGold. This tests the purchase,
 *    recipe, sell and undo accounting exactly.
 *  - income shape: the gold earned by mid-minute, predicted from the previous minute's
 *    rate, vs the actual next frame. This bounds the "spread evenly" assumption.
 */
export function checkGold(tl: TimelineDto, items: ItemTable, until: number) {
  const frames = tl.info.frames.filter((f) => f.timestamp <= until);
  const all = events(tl);
  const spendErr: number[] = [];
  const incomeErr: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const f0 = frames[i - 1];
    const f1 = frames[i];
    for (const id in f1.participantFrames) {
      const p0 = f0.participantFrames[id];
      const p1 = f1.participantFrames[id];
      if (!p0 || !p1) continue;
      const pid = Number(id);
      const spent = all.filter((e) => e.participantId === pid && e.timestamp > f0.timestamp && e.timestamp <= f1.timestamp).reduce((s, e) => s + spendOf(e, all, items), 0);
      spendErr.push(Math.abs(p0.currentGold + (p1.totalGold - p0.totalGold) - spent - p1.currentGold));
      if (i >= 2) {
        const fm = frames[i - 2];
        const pm = fm.participantFrames[id];
        if (pm) incomeErr.push(Math.abs(p0.totalGold + (p0.totalGold - pm.totalGold) - p1.totalGold));
      }
    }
  }
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
  };
  const within50 = spendErr.filter((x) => x <= 50).length;
  return {
    name: "gold: spend accounting vs next frame's currentGold",
    measured: `${spendErr.length ? Math.round((within50 / spendErr.length) * 1000) / 10 : 0}% within 50g (${within50}/${spendErr.length}), median ${q(spendErr, 0.5)}g, 90th pct ${q(spendErr, 0.9)}g; a whole minute's income guessed from the minute before is off by median ${q(incomeErr, 0.5)}g`,
    bar: "within 50g on 90% of frames",
    pass: spendErr.length > 0 && within50 / spendErr.length >= 0.9,
    n: spendErr.length,
    detail: { spendErr },
  };
}
