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

// Vulnerability: loadouts check, exposure to the enemy jungler, fights.
const vuln = require("../dist/core/vulnerability.js");
const gold = require("../dist/core/gold.js");
const itemFile = arg("--items") || fs.readdirSync(dir).find((f) => /^item-.*\.json$/.test(f));
if (itemFile) {
  const items = gold.itemTable(read(itemFile));
  const vin = { ...input, items };
  report.checks.push(vuln.checkLoadouts(match, timeline, items, waves.live, until));
  const ex = vuln.exposures(vin);
  report.checks.push(vuln.checkExposures(vin, ex));
  const name = (pid) => match.info.participants.find((p) => p.participantId === pid)?.championName;
  report.exposures = ex.map((x) => ({ ...x, t0: fmt(x.t0), t1: fmt(x.t1), depthAt: fmt(x.depthAt), closestAt: x.closestAt === null ? null : fmt(x.closestAt), arrived: x.arrived === null ? null : fmt(x.arrived), died: x.died === null ? null : fmt(x.died), unseenFor: Math.round(x.unseenFor / 1000), lastSeen: x.lastSeen && { t: fmt(x.lastSeen.t), x: Math.round(x.lastSeen.x), y: Math.round(x.lastSeen.y) } }));
  report.fights = vuln.fights(vin).map((f) => ({ ...f, t0: fmt(f.t0), t1: fmt(f.t1), died: f.died === null ? null : fmt(f.died), me: { level: f.me.level, itemGold: f.me.itemGold, legendaries: f.me.legendaries }, allies: f.allies.map(name), killed: f.killed.map(name) }));
  report.viewTeam = waves.viewTeam;
  const out = require("../dist/core/synth.js").synthesize(vin);
  report.findings = out.findings.map((f) => ({ time: f.time, kind: f.kind, title: f.title, proof: f.proof, cost: f.cost, fix: f.fix, jump: `${fmt(f.jump.t)} on ${f.jump.follow}`, score: Math.round(f.score) }));
  report.rejected = out.rejected;
}

// --diag: the reads around each shop stop the base-visit check missed.
if (process.argv.includes("--diag")) {
  const missed = report.checks.find((c) => c.name.startsWith("tempo: every shop stop"))?.detail || [];
  const fountain = (team) => (team === 200 ? { x: 14340, y: 14390 } : { x: 400, y: 420 });
  report.diag = missed.map((m) => {
    const team = match.info.participants.find((p) => p.participantId === m.id).teamId;
    const f = fountain(team);
    const rows = (list) => (list || []).filter((s) => s.fog === "off" && s.t >= m.t - 20000 && s.t <= m.t + 10000).map((s) => {
      const a = s.at.find((x) => x.id === m.id);
      return a ? `${Math.round((s.t - m.t) / 100) / 10}:${Math.round(Math.hypot(a.x - f.x, a.y - f.y))}${a.inferred ? "i" : ""}` : `${Math.round((s.t - m.t) / 100) / 10}:-`;
    }).join(" ");
    // Each entry is "seconds from the purchase : distance from own fountain" (i = filled in, - = no read).
    return { champion: m.champion, t: fmt(m.t), tracked: rows(waves.champs), raw: waves.champsRaw ? rows(waves.champsRaw) : "no champsRaw in this scan", unnamedInFountain: (waves.champs || []).filter((s) => s.fog === "off" && Math.abs(s.t - m.t) <= 5000).map((s) => (s.unk || []).filter((u) => u.team === team && Math.hypot(u.x - f.x, u.y - f.y) <= 1500).length).join("") };
  });
}
if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
