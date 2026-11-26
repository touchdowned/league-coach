// Runs the Module 2 engine on a saved scan, no replay needed.
//   npm run build:main && node scripts/module2.js --dir <folder> --match NA1_123 --champion Azir [--json out.json]
// <folder> holds match-<id>.json, timeline-<id>.json and a waves-<id>*.json scan file.
const fs = require("fs");
const path = require("path");
const ws = require("../dist/core/wavestate.js");

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
if (arg("--json")) fs.writeFileSync(arg("--json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
