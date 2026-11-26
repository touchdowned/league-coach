/**
 * Guided walkthrough: turns a game's leaks into chapters a coach would walk you through.
 *
 * A death is rarely the mistake. The mistake is the decision 10 to 60 seconds earlier:
 * staying in lane after the jungler showed, walking past the river with three enemies
 * missing, skipping the recall window, chasing after the kill. Each chapter starts a
 * few seconds before that decision, stops on it so you can call it, then plays out
 * what it cost. Chapters are ordered by gold cost, biggest first.
 *
 * Everything here is computed from the saved report (leaks, track, wave/vision read),
 * so old reports get chapters without a re-sync.
 */
import { fmtTime } from "./analysis";
import type { Leak } from "./engine";
import { describeSpot, dist, positionAt, type Track } from "./track";
import type { GameReport } from "./types";
import { hasVision, lastSeen, truthAt, visibleAt } from "./vision";
import { laneOf, pointOnLane, waveAt, type Lane, type WaveRead } from "./waves";
import { champName } from "./names";

export type Pt = { x: number; y: number };

/** Something drawn on the map/replay at a beat. */
export type Mark =
  | { kind: "path"; from: Pt; to: Pt; tone: "better" | "actual" | "enemy"; label?: string }
  | { kind: "ring"; at: Pt; tone: "danger" | "better" | "info"; label?: string; radius?: number }
  | { kind: "ghost"; at: Pt; champion: string; label: string };

export interface Beat {
  /** Game time, ms. */
  t: number;
  kind: "setup" | "cue" | "decision" | "outcome";
  /** One line, shown as the caption on the replay. */
  caption: string;
  /** Champion the camera should sit on at this beat. */
  follow?: string;
  /** Or a map point to frame instead. */
  look?: Pt;
  marks: Mark[];
}

export interface Choice {
  label: string;
  good: boolean;
  /** Why, in one or two sentences, shown after you pick. */
  why: string;
}

export interface Chapter {
  id: string;
  kind: Leak["kind"];
  /** "Death at 9:42", "Recall at 6:10", ... */
  label: string;
  /** The root cause in one line. */
  headline: string;
  cost: number;
  costParts: Leak["costParts"];
  /** Playback window, ms. Starts a few seconds before the root cause. */
  start: number;
  end: number;
  /** The decision that started it. */
  root: number;
  /** When the cost landed (the death, the recall, the objective). */
  outcome: number;
  beats: Beat[];
  question: string;
  choices: Choice[];
  /** What was on your screen and minimap at the decision. */
  seen: string[];
  /** What was true (fog off) that you couldn't see. */
  truth: string[];
  /** The better play, in a sentence, and where it would have put you. */
  better: { text: string; from: Pt | null; to: Pt | null; label: string };
  /** Full engine write-up, for the "why" panel. */
  leak: Leak;
}

const LEAD = 6000; // start this long before the root cause
const TAIL = 3500; // keep playing this long after the outcome
const MAX_LOOKBACK = 75_000;
const SEC = 1000;
const LANE_END = 14 * 60_000;

const FOUNTAIN: Record<number, Pt> = { 100: { x: 400, y: 400 }, 200: { x: 14340, y: 14390 } };
const PIT = { dragon: { x: 9866, y: 4414 }, baron: { x: 5007, y: 10471 } };

interface G {
  r: GameReport;
  track: Track;
  meId: number;
  me: string;
  team: number;
  lane: Lane | null;
  enemies: Track["players"];
  allies: Track["players"];
  jungler: Track["players"][number] | undefined;
  vision: boolean;
}

const spot = (g: G, p: Pt) => describeSpot(p, g.team);
const bare = (s: string) => s.replace(/^in /, "");
const enemyHalf = (g: G, p: Pt) => (g.team === 100 ? p.x + p.y > 15400 : p.x + p.y < 14300);

function pos(g: G, id: number, t: number): Pt | null {
  const p = positionAt(g.track, id, t);
  return p && !p.dead ? { x: p.x, y: p.y } : null;
}

/** A spot `back` of the way from where you are toward your own side of the lane. */
function safeLaneSpot(g: G, at: Pt, wave: WaveRead | null): Pt {
  if (!g.lane) return towardBase(g, at, 1800);
  // 0 = your base. Stand behind your own wave, or just in front of your tower.
  const s = wave ? Math.max(0.2, wave.front - 0.1) : 0.32;
  return pointOnLane(g.lane, g.team === 100 ? s : 1 - s);
}

function towardBase(g: G, at: Pt, units: number): Pt {
  const f = FOUNTAIN[g.team];
  const d = dist(at, f) || 1;
  const k = Math.min(1, units / d);
  return { x: at.x + (f.x - at.x) * k, y: at.y + (f.y - at.y) * k };
}

function nearestAlly(g: G, t: number, from: Pt): { champion: string; at: Pt } | null {
  let best: { champion: string; at: Pt; d: number } | null = null;
  for (const a of g.allies) {
    const q = pos(g, a.id, t);
    if (!q) continue;
    const d = dist(q, from);
    if (!best || d < best.d) best = { champion: a.champion, at: q, d };
  }
  return best && { champion: best.champion, at: best.at };
}

/** The last moment before `t` that you stepped from your half into theirs. */
function crossedAt(g: G, t: number): number | null {
  for (let s = t; s > t - MAX_LOOKBACK; s -= 2 * SEC) {
    const p = pos(g, g.meId, s);
    if (p && !enemyHalf(g, p)) return s + 2 * SEC < t ? s + 2 * SEC : null;
  }
  return null;
}

function myWave(g: G, t: number): WaveRead | null {
  return g.lane && t < LANE_END + 2 * 60_000 ? waveAt(g.r.waves, t, g.lane, g.team) : null;
}

/** What was on your minimap at t, and what fog hid. */
function sight(g: G, t: number): { seen: string[]; truth: string[]; missing: Track["players"] } {
  const seen: string[] = [];
  const truth: string[] = [];
  if (!g.vision) return { seen, truth, missing: [] };
  const shown = visibleAt(g.r.waves, t);
  if (!shown) return { seen, truth, missing: [] };
  const visible = g.enemies.filter((p) => shown.has(p.id));
  const missing = g.enemies.filter((p) => !shown.has(p.id));
  seen.push(visible.length ? `On your minimap: ${visible.map((p) => p.champion).join(", ")}.` : "No enemies on your minimap.");
  for (const p of missing) {
    const ls = lastSeen(g.r.waves, p.id, t, 180_000);
    seen.push(ls ? `${champName(p.champion)}: last seen ${Math.round((t - ls.t) / SEC)}s ago ${spot(g, ls)}.` : `${champName(p.champion)}: not seen for 3+ minutes.`);
    const tr = truthAt(g.r.waves, p.id, t);
    if (tr) truth.push(`${champName(p.champion)} was ${spot(g, tr)} (${(dist(tr, pos(g, g.meId, t) ?? tr) / 1000).toFixed(1)}k units from you).`);
  }
  return { seen, truth, missing };
}

function ghosts(g: G, t: number): Mark[] {
  if (!g.vision) return [];
  const shown = visibleAt(g.r.waves, t);
  if (!shown) return [];
  const out: Mark[] = [];
  for (const p of g.enemies) {
    if (shown.has(p.id)) continue;
    const ls = lastSeen(g.r.waves, p.id, t, 120_000);
    if (ls) out.push({ kind: "ghost", at: ls, champion: p.champion, label: `${Math.round((t - ls.t) / SEC)}s ago` });
  }
  return out;
}

// ---------------------------------------------------------------------------

export function buildChapters(r: GameReport, max = 6): Chapter[] {
  if (!r.leaks?.length || !r.track) return [];
  const me = r.track.players.find((p) => p.champion === r.metrics.champion && p.teamId === r.teamId);
  if (!me) return [];
  const g: G = {
    r,
    track: r.track,
    meId: me.id,
    me: me.champion,
    team: r.teamId,
    lane: laneOf(r.metrics.role),
    enemies: r.track.players.filter((p) => p.teamId !== r.teamId),
    allies: r.track.players.filter((p) => p.teamId === r.teamId && p.id !== me.id),
    jungler: r.track.players.find((p) => p.teamId !== r.teamId && p.role === "JUNGLE"),
    vision: hasVision(r.waves, r.teamId),
  };
  const out: Chapter[] = [];
  for (const l of r.leaks) {
    const c = chapterFor(g, l);
    if (!c) continue;
    // Two leaks with the same root decision are one chapter: keep the costlier.
    if (out.some((o) => Math.abs(o.root - c.root) < 8 * SEC)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function chapterFor(g: G, l: Leak): Chapter | null {
  switch (l.kind) {
    case "death":
      return deathChapter(g, l);
    case "recall":
      return recallChapter(g, l);
    case "objective":
      return objectiveChapter(g, l);
    case "roam":
      return roamChapter(g, l);
    case "farm":
      return farmChapter(g, l);
  }
}

function finish(g: G, l: Leak, c: Omit<Chapter, "id" | "kind" | "cost" | "costParts" | "start" | "end" | "leak">): Chapter {
  const start = Math.max(0, c.root - LEAD);
  const end = Math.max(c.outcome + TAIL, c.root + 8 * SEC);
  const beats = [...c.beats].sort((a, b) => a.t - b.t);
  return { ...c, beats, id: `${g.r.metrics.matchId}:${l.kind}:${l.t}`, kind: l.kind, cost: l.cost, costParts: l.costParts, start, end, leak: l };
}

// ---------- deaths ----------

function deathChapter(g: G, l: Leak): Chapter {
  const t = l.deathMs ?? l.t;
  const at = l.focus ?? pos(g, g.meId, t - 2 * SEC) ?? { x: 7400, y: 7400 };
  const cause = l.tags?.cause ?? "other";
  const kill = g.track.kills.find((k) => k.t === t && k.victim === g.meId);
  const killers = kill ? [kill.killer, ...kill.assists].map((id) => g.track.players.find((p) => p.id === id)).filter((p): p is Track["players"][number] => !!p && p.teamId !== g.team) : [];
  const killerNames = killers.map((p) => p.champion);
  const jg = killers.find((p) => p.role === "JUNGLE") ?? (cause === "ganked" ? g.jungler : undefined);
  const outcomeBeat: Beat = {
    t,
    kind: "outcome",
    caption: `You die to ${killerNames.join(" + ") || "the enemy"}. ${l.costParts.map((p) => p.label).slice(0, 2).join(", ")}.`,
    follow: g.me,
    marks: [{ kind: "ring", at, tone: "danger", label: "death" }],
  };
  const beats: Beat[] = [outcomeBeat];
  let root = t - 8 * SEC;
  let headline = l.title;
  let question = "What's about to go wrong here?";
  let choices: Choice[];
  let better: Chapter["better"];

  const passedWindow = (g.r.recallWindows ?? []).filter((w) => !w.taken && w.end < t - 5 * SEC && w.t > t - 150 * SEC).pop();
  const ls = jg && g.vision ? lastSeen(g.r.waves, jg.id, t - 2 * SEC, 150_000) : null;
  const seenRecently = ls && t - ls.t <= 45 * SEC;

  if (cause === "chased-after-kill") {
    const k = g.track.kills.filter((x) => x.t < t && t - x.t < 25 * SEC && (x.killer === g.meId || x.assists.includes(g.meId))).pop();
    root = k ? k.t + SEC : t - 10 * SEC;
    const victim = k ? g.track.players.find((p) => p.id === k.victim)?.champion : null;
    const from = pos(g, g.meId, root) ?? at;
    const ally = nearestAlly(g, root, from);
    const to = ally?.at ?? towardBase(g, from, 2500);
    headline = `The ${victim ?? "kill"} was the win. Chasing on gave it back.`;
    question = `You just got ${victim ?? "the kill"}. What now?`;
    choices = [
      { label: "Keep chasing the next one", good: false, why: `That's what happened: ${killerNames.join(" and ") || "they"} turned on you ${Math.round((t - root) / SEC)}s later.` },
      { label: "Walk out and reset", good: true, why: `The kill is already the profit. Walk ${ally ? `to ${champName(ally.champion)}` : "toward your tower"}, then back or take a plate with the tempo.` },
      { label: "Hit the closest tower", good: true, why: "Fine if no one else on their team is showing nearby. Turning a kill into a plate is the classic trade." },
    ];
    better = { text: `Take the kill and walk ${ally ? `toward ${champName(ally.champion)}` : "out"}: the shutdown you gave back was worth more than anything left in that fight.`, from, to, label: "walk out" };
    beats.push({ t: root, kind: "decision", caption: `Kill secured. Everything after this is a decision.`, follow: g.me, marks: [{ kind: "path", from, to, tone: "better", label: "walk out" }] });
  } else if (jg && seenRecently && ls) {
    root = ls.t;
    const from = pos(g, g.meId, root) ?? at;
    const w = myWave(g, root);
    const to = t < LANE_END ? safeLaneSpot(g, from, w) : (nearestAlly(g, root, from)?.at ?? towardBase(g, from, 2500));
    const walk = Math.round(dist(ls, at) / 380);
    headline = `${champName(jg.champion)} showed ${bare(spot(g, ls))} ${Math.round((t - ls.t) / SEC)}s before. That was the cue to step back.`;
    question = `${champName(jg.champion)} just showed on your minimap. What do you do?`;
    choices = [
      { label: "Finish the wave first", good: false, why: `${champName(jg.champion)} was ~${walk}s away. You stayed ${Math.max(0, Math.round((t - ls.t) / SEC) - walk)}s past that clock.` },
      { label: t < LANE_END ? "Step back behind your wave" : "Group with your team", good: true, why: `Start a ${walk}s clock the moment they show. When it runs out, be somewhere a gank can't reach.` },
      { label: "Look for a trade", good: false, why: `Trading with a jungler ${walk}s away is fighting 1v2 by the time the trade ends.` },
    ];
    better = { text: `${champName(jg.champion)} was ${walk}s of walking away. Back off toward ${t < LANE_END ? "your tower" : "your team"} as soon as they show, and come back when they appear somewhere else.`, from, to, label: "safe spot" };
    beats.push({
      t: root,
      kind: "decision",
      caption: `${champName(jg.champion)} shows on your minimap ${bare(spot(g, ls))}.`,
      follow: g.me,
      marks: [{ kind: "ring", at: ls, tone: "danger", label: jg.champion }, { kind: "path", from: ls, to: at, tone: "enemy", label: `~${walk}s` }],
    });
  } else if (passedWindow && (cause === "died-holding-gold" || cause === "ganked" || cause === "lost-1v1" || cause === "fought-into-bigger-wave")) {
    root = passedWindow.t;
    const from = pos(g, g.meId, root) ?? at;
    headline = `The recall window at ${fmtTime(passedWindow.t)} was the play. Staying in lane with ${passedWindow.gold.toLocaleString("en-US")}g led here.`;
    question = `Your wave is crashing into their tower and you have ${passedWindow.gold.toLocaleString("en-US")}g. What now?`;
    choices = [
      { label: "Recall now", good: true, why: "Wave crashing + item gold is the free recall. Their next wave walks to your tower, and you're back before it does much." },
      { label: "Stay for another wave", good: false, why: `That's what happened. You died ${Math.round((t - root) / SEC)}s later still holding the gold.` },
      { label: "Roam", good: false, why: "Possible with a plan, but you'd still be holding the gold. Spend it first." },
    ];
    better = { text: `Recall on that crash. You'd have fought the next one with an item instead of dying with the gold.`, from, to: FOUNTAIN[g.team], label: "recall" };
    beats.push({ t: root, kind: "decision", caption: `Your wave crashes into their tower. You have ${passedWindow.gold.toLocaleString("en-US")}g.`, follow: g.me, marks: [] });
  } else if (cause === "fought-into-bigger-wave") {
    root = t - 7 * SEC;
    const w = myWave(g, root);
    const from = pos(g, g.meId, root) ?? at;
    const to = safeLaneSpot(g, from, w);
    headline = `You fought with ${w ? `${w.mine} minions against ${w.theirs}` : "the smaller wave"}. The minions won it for them.`;
    question = w ? `${w.mine} of your minions vs ${w.theirs} of theirs. Trade?` : "Their wave is bigger. Trade?";
    choices = [
      { label: "Go in", good: false, why: "Early on, a big wave hits as hard as a champion. You lost the fight to minion damage." },
      { label: "Wait for the wave to flip", good: true, why: "Let their wave push to your tower, then the tower is your extra hit." },
      { label: "Trade only with a spell, then walk back", good: true, why: "A quick poke is fine. A full trade isn't." },
    ];
    better = { text: "Back off and let their wave come to your tower. Fight when the minions and tower are on your side.", from, to, label: "back off" };
    beats.push({ t: root, kind: "decision", caption: w ? `${w.mine} vs ${w.theirs} minions, ${w.where}.` : "Their wave is bigger here.", follow: g.me, marks: [{ kind: "path", from, to, tone: "better", label: "back off" }] });
  } else {
    // Walked into an unsafe spot: the root is when you crossed into their half.
    const crossed = crossedAt(g, t);
    root = crossed ?? t - 10 * SEC;
    const from = pos(g, g.meId, root) ?? at;
    const s = sight(g, root);
    const missing = s.missing.length;
    const ally = nearestAlly(g, root, from);
    const to = t < LANE_END ? safeLaneSpot(g, from, myWave(g, root)) : (ally?.at ?? towardBase(g, from, 2500));
    const n = killers.length;
    headline =
      cause === "collapsed-on"
        ? `${n} of them collapsed on you ${bare(spot(g, at))}. The mistake was walking there with ${missing || "several"} enemies off the map.`
        : cause === "lost-1v1"
          ? `You took the 1v1 with ${killerNames[0] ?? "your laner"} and lost it.`
          : cause === "died-holding-gold"
            ? `You walked ${bare(spot(g, at))} holding item gold.`
            : `You walked ${bare(spot(g, at))} without the information to be there.`;
    question = crossed ? `You're stepping into their half${missing ? ` with ${missing} enemies off your minimap` : ""}. Keep going?` : "What's about to go wrong?";
    choices =
      cause === "lost-1v1"
        ? [
            { label: "Take the fight", good: false, why: "You lost it. Check their cooldowns and the gold gap before committing." },
            { label: "Back off and farm", good: true, why: "Without a clear edge (cooldowns, level, wave) there's no reason to take an even fight." },
          ]
        : [
            { label: "Keep going", good: false, why: `That's what happened. ${n >= 2 ? `${n} of them were waiting.` : "It got you killed."}` },
            { label: ally ? `Walk toward ${champName(ally.champion)}` : "Turn back", good: true, why: `With ${missing || "enemies"} unaccounted for, only go where your team or a ward covers you.` },
            { label: "Ward first, then go", good: true, why: "A ward on the way in would have shown the collapse coming." },
          ];
    better = {
      text:
        cause === "collapsed-on"
          ? `${n} came to you, so the rest of the map was open. Walk toward ${ally ? champName(ally.champion) : "your team"} and ping your team to take something on the other side.`
          : `Stay on your side until ${missing ? `the ${missing} missing enemies show` : "you know where they are"}, or go with a teammate.`,
      from,
      to,
      label: ally && t >= LANE_END ? ally.champion : "safe spot",
    };
    beats.push({
      t: root,
      kind: "decision",
      caption: crossed ? `You cross into their half ${bare(spot(g, from))}.` : `${fmtTime(root)}: last chance to change this.`,
      follow: g.me,
      marks: ghosts(g, root),
    });
  }

  // A cue between the decision and the death: the enemy appearing, when we can see it.
  if (jg && g.vision && root < t - 6 * SEC) {
    const shownAt = firstShown(g, jg.id, root, t);
    if (shownAt && shownAt.t > root + 2 * SEC && shownAt.t < t - SEC)
      beats.push({ t: shownAt.t, kind: "cue", caption: `${champName(jg.champion)} appears ${bare(spot(g, shownAt))}. Too late now.`, follow: g.me, marks: [{ kind: "ring", at: shownAt, tone: "danger", label: jg.champion }] });
  }
  beats.push({ t: Math.max(0, root - LEAD), kind: "setup", caption: setupLine(g, root), follow: g.me, marks: [] });
  const s = sight(g, root);
  return finish(g, l, {
    label: `Death at ${fmtTime(t)}`,
    headline,
    root,
    outcome: t,
    beats,
    question,
    choices,
    seen: s.seen.length ? s.seen : l.evidence.slice(0, 2),
    truth: s.truth,
    better,
  });
}

function firstShown(g: G, id: number, from: number, to: number): (Pt & { t: number }) | null {
  for (const s of g.r.waves?.champs ?? []) {
    if (s.fog !== "team" || s.t <= from || s.t >= to) continue;
    const a = s.at.find((x) => x.id === id);
    if (a) return { t: s.t, x: a.x, y: a.y };
  }
  return null;
}

function setupLine(g: G, root: number): string {
  const w = myWave(g, root);
  const where = pos(g, g.meId, root);
  const bits = [`${fmtTime(root)}`];
  if (where) bits.push(`you're ${bare(spot(g, where))}`);
  if (w) bits.push(`wave ${w.mine} vs ${w.theirs}, ${w.where}`);
  return bits.join(" · ");
}

// ---------- recalls ----------

function recallChapter(g: G, l: Leak): Chapter {
  const left = l.t;
  const from = l.focus ?? pos(g, g.meId, left) ?? FOUNTAIN[g.team];
  const cause = l.tags?.cause ?? "recall-other";
  const w = myWave(g, left);
  const passed = (g.r.recallWindows ?? []).filter((x) => !x.taken && x.end < left - 5 * SEC && x.t > left - 180 * SEC).pop();
  const beats: Beat[] = [{ t: left, kind: "outcome", caption: `You recall ${bare(spot(g, from))}${w ? ` with ${w.theirs} of their minions ${w.where}` : ""}.`, follow: g.me, marks: [] }];
  let root = left - 4 * SEC;
  let question = "You're about to recall. Is this the moment?";
  let choices: Choice[];
  let better: Chapter["better"];
  let headline = l.title;

  if (passed) {
    root = passed.t;
    const at = pos(g, g.meId, root) ?? from;
    headline = `The recall window was at ${fmtTime(passed.t)}. You backed ${Math.round((left - passed.t) / SEC)}s later, into a worse wave.`;
    question = `Wave crashing into their tower, ${passed.gold.toLocaleString("en-US")}g in your pocket. Now?`;
    choices = [
      { label: "Recall now", good: true, why: "This is the free recall: the crash buys you the trip." },
      { label: "One more wave", good: false, why: `You backed at ${fmtTime(left)} instead, and it cost ${l.cost.toLocaleString("en-US")}g.` },
      { label: "Push the tower", good: false, why: "Plates are tempting, but the next wave arrives before you take much. Spend the gold." },
    ];
    better = { text: `Back at ${fmtTime(passed.t)} on the crash. You'd have bought the same items ${Math.round((left - passed.t) / SEC)}s sooner and lost nothing.`, from: at, to: FOUNTAIN[g.team], label: "recall here" };
    beats.push({ t: root, kind: "decision", caption: `Your wave crashes into their tower. ${passed.gold.toLocaleString("en-US")}g.`, follow: g.me, marks: [] });
  } else if (cause === "recalled-into-their-wave" || (w && w.theirs >= w.mine + 2)) {
    const waveAtFront = g.lane && w ? pointOnLane(g.lane, g.team === 100 ? w.front : 1 - w.front) : from;
    headline = `You recalled with ${w ? `${w.theirs} of their minions` : "their wave"} walking into your tower.`;
    question = w ? `${w.theirs} of their minions vs ${w.mine} of yours, ${w.where}. Recall?` : "Their wave is pushing at you. Recall?";
    choices = [
      { label: "Recall now", good: false, why: "Every one of those minions dies to your tower with you gone." },
      { label: "Clear the wave, then recall", good: true, why: `About 20 seconds to kill it and shove yours. Then the crash buys the trip.` },
      { label: "Let it freeze", good: false, why: "Freezing with no gold plan just delays the same problem." },
    ];
    better = { text: "Kill their wave, push yours into their tower, and recall as it crashes.", from, to: waveAtFront, label: "clear first" };
    beats.push({ t: root, kind: "decision", caption: w ? `Wave: ${w.mine} yours vs ${w.theirs} theirs, ${w.where}.` : "You start to recall.", follow: g.me, marks: [{ kind: "path", from, to: waveAtFront, tone: "better", label: "clear first" }] });
  } else if (cause === "objective-lost-while-recalling") {
    const pit = from.x - from.y > 0 ? PIT.dragon : PIT.baron;
    headline = `You recalled right before an objective, and the enemy took it.`;
    question = "An objective spawns soon. Recall now?";
    choices = [
      { label: "Recall now", good: false, why: "You'd be walking back as it dies." },
      { label: "Back 60–90s earlier, or after it", good: true, why: "Recall timing is set by the objective timer, not by your gold." },
    ];
    better = { text: "Stay and walk to the pit with your team, then recall after.", from, to: pit, label: "objective" };
    beats.push({ t: root, kind: "decision", caption: "You start to recall with an objective coming.", follow: g.me, marks: [{ kind: "path", from, to: pit, tone: "better" }] });
  } else {
    question = "Is this a good time to recall?";
    choices = [
      { label: "Yes, recall", good: false, why: l.nextTime },
      { label: "No, time it to a crash", good: true, why: "Push first, back as the wave hits their tower." },
    ];
    better = { text: l.nextTime, from, to: FOUNTAIN[g.team], label: "recall" };
    beats.push({ t: root, kind: "decision", caption: "You start to recall.", follow: g.me, marks: [] });
  }
  beats.push({ t: Math.max(0, root - LEAD), kind: "setup", caption: setupLine(g, root), follow: g.me, marks: [] });
  const s = sight(g, root);
  return finish(g, l, { label: `Recall at ${fmtTime(left)}`, headline, root, outcome: left + 8 * SEC, beats, question, choices, seen: s.seen.length ? s.seen : l.evidence.slice(0, 2), truth: s.truth, better });
}

// ---------- objectives ----------

function objectiveChapter(g: G, l: Leak): Chapter {
  const killAt = l.t + 40 * SEC;
  const isDragon = /dragon/i.test(l.title);
  const pit = isDragon ? PIT.dragon : PIT.baron;
  const root = killAt - 55 * SEC;
  const from = pos(g, g.meId, root) ?? l.focus ?? pit;
  const nm = isDragon ? "Dragon" : "Baron";
  const beats: Beat[] = [
    { t: root, kind: "decision", caption: `${nm} is about to be contested. You're ${bare(spot(g, from))}.`, follow: g.me, marks: [{ kind: "ring", at: pit, tone: "info", label: nm }] },
    { t: killAt, kind: "outcome", caption: `They take ${nm}. Nothing taken in return.`, look: pit, marks: [{ kind: "ring", at: pit, tone: "danger", label: nm }] },
    { t: Math.max(0, root - LEAD), kind: "setup", caption: setupLine(g, root), follow: g.me, marks: [] },
  ];
  const s = sight(g, root);
  return finish(g, l, {
    label: `${nm} at ${fmtTime(killAt)}`,
    headline: `${nm} went for free: you were neither at the pit nor taking something on the other side.`,
    root,
    outcome: killAt,
    beats,
    question: `${nm} in under a minute. Where should you be?`,
    choices: [
      { label: "Keep farming where you are", good: false, why: "That's what happened. It went for free." },
      { label: `Walk to ${nm} now`, good: true, why: `Arriving with your team turns it into a 5v5 you can contest.` },
      { label: "Hit the tower on the other side", good: true, why: "A cross-map trade is fine, as long as you actually take something." },
    ],
    seen: s.seen.length ? s.seen : l.evidence.slice(0, 2),
    truth: s.truth,
    better: { text: l.nextTime, from, to: pit, label: nm },
  });
}

// ---------- roams and farm ----------

function roamChapter(g: G, l: Leak): Chapter {
  const root = l.t - 20 * SEC;
  const from = pos(g, g.meId, root) ?? l.focus ?? { x: 7400, y: 7400 };
  const lanePt = g.lane ? pointOnLane(g.lane, 0.5) : from;
  const s = sight(g, root);
  return finish(g, l, {
    label: `Roam at ${fmtTime(l.t)}`,
    headline: l.title,
    root,
    outcome: l.t + 20 * SEC,
    beats: [
      { t: Math.max(0, root - LEAD), kind: "setup", caption: setupLine(g, root), follow: g.me, marks: [] },
      { t: root, kind: "decision", caption: "You leave lane.", follow: g.me, marks: [{ kind: "path", from, to: lanePt, tone: "better", label: "shove first" }] },
      { t: l.t + 20 * SEC, kind: "outcome", caption: "No kill, no objective. The wave you left is gone.", follow: g.me, marks: [] },
    ],
    question: "You're leaving lane. Is it worth it?",
    choices: [
      { label: "Roam now", good: false, why: "Nothing came of it and you lost the wave." },
      { label: "Shove first, then roam", good: true, why: "A roam starts with the wave crashing into their tower, so you lose nothing while you're gone." },
      { label: "Stay and farm", good: true, why: "If the wave isn't shoved, staying is fine." },
    ],
    seen: s.seen.length ? s.seen : l.evidence.slice(0, 2),
    truth: s.truth,
    better: { text: l.nextTime, from, to: lanePt, label: "shove first" },
  });
}

function farmChapter(g: G, l: Leak): Chapter {
  const root = l.t - 60 * SEC;
  const from = pos(g, g.meId, root) ?? l.focus ?? { x: 7400, y: 7400 };
  const s = sight(g, root);
  const frozen = l.tags?.cause === "frozen-out";
  const underMine = l.tags?.cause === "missed-tower-lasthits";
  return finish(g, l, {
    label: `Farm, ${fmtTime(root)}–${fmtTime(root + 120 * SEC)}`,
    headline: l.title,
    root,
    outcome: root + 30 * SEC,
    beats: [
      { t: Math.max(0, root - LEAD), kind: "setup", caption: setupLine(g, root), follow: g.me, marks: [] },
      { t: root, kind: "decision", caption: frozen ? "The wave is frozen outside their tower." : underMine ? "The wave is under your tower." : "Watch your last-hits from here.", follow: g.me, marks: [] },
      { t: root + 30 * SEC, kind: "outcome", caption: "Count the minions you miss.", follow: g.me, marks: [] },
    ],
    question: frozen ? "They're freezing outside their tower. What's your move?" : underMine ? "Wave under your tower. How do you last-hit it?" : "You're losing farm here. Why?",
    choices: frozen
      ? [
          { label: "Stand in front and wait", good: false, why: "That's the freeze working for them." },
          { label: "Break it with your jungler", good: true, why: "Two of you can hit the wave and zone their laner." },
          { label: "Trade when they're on cooldown", good: true, why: "Make them pay for standing in front of the wave." },
        ]
      : underMine
        ? [
            { label: "Just auto the minions", good: false, why: "You'll miss most of the tower last-hits." },
            { label: "Melee: 2 shots + auto. Caster: 1 shot + auto", good: true, why: "Tower last-hitting is a pattern. Learn it in the lane lab." },
          ]
        : [
            { label: "Trading too much", good: true, why: "Casters die while you trade. Watch for it." },
            { label: "Nothing, it's fine", good: false, why: l.evidence[0] ?? "The numbers say otherwise." },
          ],
    seen: l.evidence.slice(0, 2),
    truth: [],
    better: { text: l.nextTime, from, to: null, label: "" },
  });
}
