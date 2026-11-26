// Runs the Module 2 engine on a saved scan, no replay needed.
//   npm run build:main && node scripts/module2.js --dir <folder> --match NA1_123 --champion Azir [--json out.json]
// <folder> holds match-<id>.json, timeline-<id>.json and a waves-<id>*.json scan file.
const fs = require("fs");
const path = require("path");
const ws = require("../dist/core/wavestate.js");
const tempo = require("../dist/core/tempo.js");

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const dir = path.resolve(arg("--dir") || ".");
const id = arg("--match");
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const match = read(`match-${id}.json`);
const timeline = read(`timeline-${id}.json`);
const wavesName = arg("--waves") || fs.readdirSync(dir).find((f) => f.startsWith(`waves-${id}`) && f.endsWith(".json"));
const waves = read(wavesName);
const champ = (arg("--champion") || "").toLowerCase();
const me = match.info.participants.find((p) => p.championName.toLowerCase() === champ);
if (!me) throw new Error(`No ${champ} in this match: ${match.info.participants.map((p) => p.championName).join(", ")}`);
const events = timeline.info.frames.flatMap((f) => f.events || []);
const until = waves.scanInfo?.lastFrame || Infinity;
const geo = ws.laneGeometry(events);
const fmt = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null);

const report = { match: id, me: { champion: me.championName, teamId: me.teamId, role: me.teamPosition }, scan: wavesName, samples: waves.samples.length };
report.check = ws.checkWaveStates(waves, events, until);
const lanes = {};
for (const lane of ["TOP", "MIDDLE", "BOTTOM"]) {
  const s = ws.laneSeries(waves, lane, me.teamId, geo);
  const speeds = s.map((_, i) => ws.frontSpeed(s, i)).filter((v) => v !== null);
  const zones = {};
  for (const r of s) zones[r.zone ?? "none"] = (zones[r.zone ?? "none"] || 0) + 1;
  const gaps = s.filter((r) => r.leadMine !== null && r.leadTheirs !== null).map((r) => r.leadTheirs - r.leadMine);
  lanes[lane] = {
    zones,
    contactShare: Math.round((s.filter((r) => r.contact).length / Math.max(1, s.length)) * 100) / 100,
    // Calibration: what the raw numbers look like on this scan.
    groupMine: { p50: q(s.map((r) => r.mine), 0.5), p90: q(s.map((r) => r.mine), 0.9), max: q(s.map((r) => r.mine), 1) },
    groupTheirs: { p50: q(s.map((r) => r.theirs), 0.5), p90: q(s.map((r) => r.theirs), 0.9), max: q(s.map((r) => r.theirs), 1) },
    allMine: { p50: q(s.map((r) => r.mineAll), 0.5), p90: q(s.map((r) => r.mineAll), 0.9), max: q(s.map((r) => r.mineAll), 1) },
    leadGap: { p10: q(gaps, 0.1), p50: q(gaps, 0.5), p90: q(gaps, 0.9) },
    frontSpeedAbs: { p50: Math.round(q(speeds.map(Math.abs), 0.5)), p90: Math.round(q(speeds.map(Math.abs), 0.9)), p99: Math.round(q(speeds.map(Math.abs), 0.99)) },
    events: ws.waveEvents(s, lane).map((e) => `${fmt(e.t0)}-${fmt(e.t1)} ${e.kind} (${e.side}) size ${e.size} vs ${e.against}, at ${Math.round(e.at)}, value ${e.value}`),
  };
}
report.lanes = lanes;
// Only the player's own lane in full; the others as counts.
const myLane = { TOP: "TOP", MIDDLE: "MIDDLE", BOTTOM: "BOTTOM", UTILITY: "BOTTOM" }[me.teamPosition];
for (const lane of Object.keys(lanes)) {
  const kinds = {};
  for (const e of lanes[lane].events) kinds[e.split(" ")[1]] = (kinds[e.split(" ")[1]] || 0) + 1;
  lanes[lane].eventCounts = kinds;
  if (lane !== myLane && !arg("--all")) delete lanes[lane].events;
}

// Tempo: schedule, ledger and base visits against ground truth, then the player's trips.
report.readRatio = tempo.countRatio(waves);
report.checks = [report.check, tempo.checkWaveSchedule(waves, until), tempo.checkLedger(waves, match, timeline, until), tempo.checkBaseVisits(waves, match, timeline, until)];
const input = { track: waves, match, timeline, id: me.participantId };
const trips = tempo.trips(input);
report.trips = trips.map((v) => ({
  kind: v.kind,
  start: fmt(v.start),
  arrive: fmt(v.arrive),
  leave: v.leave === null ? null : fmt(v.leave),
  away: fmt(v.away),
  back: v.back === null ? null : fmt(v.back),
  until: fmt(v.until),
  from: v.from && { x: Math.round(v.from.x), y: Math.round(v.from.y) },
  channelSeen: v.channelSeen,
  teleportedOut: v.teleportedOut,
  state: v.state && { zone: v.state.zone, mine: v.state.mine, theirs: v.state.theirs, front: v.state.front === null ? null : Math.round(v.state.front) },
  loss: v.loss && { minions: v.loss.minions, waves: v.loss.waves, xp: v.loss.xp, gold: v.loss.gold, cannonWaves: v.loss.cannonWaves, byWave: v.loss.byWave.map((w) => `wave ${w.wave} (${fmt(w.spawnedAt)}): ${w.minions}`) },
  objectives: v.objectives.map((o) => `${o.type} up ${fmt(o.spawn)}${o.taken === null ? "" : `, taken ${fmt(o.taken)} by ${o.by}`}`),
  flags: v.flags,
}));
report.objectives = tempo.objectiveSync(input, trips).map((o) => ({ type: o.type, spawn: fmt(o.spawn), taken: o.taken === null ? null : fmt(o.taken), by: o.by, lastBase: o.lastBase === null ? null : fmt(o.lastBase), gold: o.gold, distanceAtTake: o.distanceAtTake, away: o.away, unspent: o.unspent }));
if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
