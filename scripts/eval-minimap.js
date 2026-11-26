// Scores the minimap reader against hand-labelled real frames.
//   npm run build:main && npx electron scripts/eval-minimap.js [fixtureDir] [--json out.json]
// fixtureDir holds the crops (*.png), background.png and labels.json (see tests/fixtures/minimap).
// For each labelled frame: which labelled champions got a ring within 6 px, which of those
// got the right name, rings with no champion under them, and minion dots per lane vs the count.
const { app, nativeImage, net } = require("electron");
const fs = require("fs");
const path = require("path");
const mm = require("../dist/core/minimap.js");
const waves = require("../dist/core/waves.js");

const args = process.argv.slice(2).filter((a) => !a.endsWith(".js") && a !== ".");
const ji = args.indexOf("--json");
const jsonOut = ji >= 0 ? args[ji + 1] : null;
const dir = path.resolve(args.find((a, i) => !a.startsWith("--") && i !== ji + 1) || "tests/fixtures/minimap/NA1_5685324255");
app.on("window-all-closed", () => {});

function load(file) {
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const data = new Uint8ClampedArray(img.toBitmap());
  mm.bgraToRgba(data);
  return { w: width, h: height, data };
}

// The game's ward icons (kinds, control wards): from WARD_ICONS_DIR if set, else CommunityDragon.
async function wardTemplatesFor() {
  const out = [];
  for (const [file, kind] of [["minimap_ward_green_full.png", "stealth"], ["minimap_ward_green_low.png", "stealth_low"], ["minimap_jammer_friendly.png", "control"], ["minimap_jammer_enemy.png", "control"]]) {
    try {
      const buf = process.env.WARD_ICONS_DIR ? fs.readFileSync(path.join(process.env.WARD_ICONS_DIR, file)) : Buffer.from(await (await net.fetch("https://raw.communitydragon.org/latest/game/assets/ux/minimap/icons/" + file)).arrayBuffer());
      const img = nativeImage.createFromBuffer(buf);
      const { width, height } = img.getSize();
      const data = new Uint8ClampedArray(img.toBitmap());
      mm.bgraToRgba(data);
      out.push(mm.wardTemplate(kind, { w: width, h: height, data }));
    } catch {}
  }
  return out;
}

async function refsFor(champs) {
  const v = (await (await net.fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json())[0];
  const out = [];
  for (const [i, c] of champs.entries()) {
    const res = await net.fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/img/champion/${c.name}.png`);
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer())).resize({ width: 48, height: 48 });
    const data = new Uint8ClampedArray(img.toBitmap());
    mm.bgraToRgba(data);
    out.push({ id: i + 1, name: c.name, team: c.team, grid: mm.iconGrid({ w: 48, h: 48, data }) });
  }
  return out;
}

app.whenReady().then(async () => {
  const labels = JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8"));
  const bg = load(path.join(dir, "background.png"));
  // The ten champions, from the labels.
  const names = new Map();
  for (const [k, l] of Object.entries(labels)) if (!k.startsWith("_")) for (const c of l.champs || []) names.set(c.name, c.team);
  const refs = await refsFor([...names].map(([name, team]) => ({ name, team })));
  const wardTemplates = process.env.NO_WARD_ICONS ? [] : await wardTemplatesFor();
  const nameOf = (id) => refs.find((r) => r.id === id)?.name;
  const sweep = (process.env.MIN_COVER || "0.42,0.36,0.3").split(",").map(Number);
  const runs = [];
  const fills = (process.env.MIN_FILL || "0.45").split(",").map(Number);
  for (const minCover of sweep) for (const minFill of fills) {
  const tot = { labelled: 0, ringed: 0, named: 0, wrongName: 0, falseRings: 0, stackedLabelled: 0, stackedRinged: 0, minionErr: [], wardsLabelled: 0, wardsFound: 0, wardsFalse: 0 };
  const frames = [];
  for (const [file, l] of Object.entries(labels)) {
    if (file.startsWith("_")) continue;
    const f = load(path.join(dir, file));
    const rings = mm.findRings(f, bg, { minCover });
    const found = mm.detectChampions(f, refs, 38, rings);
    const px = found.map((c) => ({ ...c, ...mm.gameToPixel(c.x, c.y, f.w) }));
    const used = new Set();
    const rows = [];
    for (const c of l.champs || []) {
      tot.labelled++;
      if (c.stacked) tot.stackedLabelled++;
      let best = -1;
      let bd = 6;
      px.forEach((d, i) => {
        const dd = Math.hypot(d.px - c.px, d.py - c.py);
        if (!used.has(i) && d.team === c.team && dd < bd) {
          bd = dd;
          best = i;
        }
      });
      if (best < 0) {
        rows.push({ champ: c.name, ring: false });
        continue;
      }
      used.add(best);
      tot.ringed++;
      if (c.stacked) tot.stackedRinged++;
      const got = nameOf(px[best].id);
      if (got === c.name) tot.named++;
      else if (got) tot.wrongName++;
      rows.push({ champ: c.name, ring: true, off: Math.round(bd * 10) / 10, named: got || null, score: px[best].score });
    }
    // Frames labelled for minions only: don't score their rings.
    const scoreRings = Array.isArray(l.champs) && l.champs.length > 0;
    const extra = !scoreRings ? [] : px.filter((_, i) => !used.has(i)).map((d) => ({ at: [Math.round(d.px), Math.round(d.py)], team: d.team, named: nameOf(d.id) || null, score: d.score }));
    tot.falseRings += extra.length;
    const isOff = !/team/.test(file);
    let minions = null;
    if (isOff && l.minions) {
      const wardDots = [];
      const dots = mm.detectDots(f, bg, { exclude: rings, minFill, wards: wardDots, wardTemplates });
      if (Array.isArray(l.wards)) {
        const wpx = wardDots.map((d) => ({ team: d.team, kind: d.kind, ...mm.gameToPixel(d.x, d.y, f.w) }));
        const hit = new Set();
        for (const lw of l.wards) {
          tot.wardsLabelled++;
          const i = wpx.findIndex((d, k) => !hit.has(k) && d.team === lw.team && Math.hypot(d.px - lw.px, d.py - lw.py) <= 4);
          if (i >= 0) {
            hit.add(i);
            tot.wardsFound++;
          }
        }
        tot.wardsFalse += wpx.length - hit.size;
        var wardRows = { labelled: l.wards.length, found: hit.size, falseAt: wpx.filter((_, k) => !hit.has(k)).map((d) => [Math.round(d.px), Math.round(d.py), d.team, d.kind]), kinds: wpx.map((d) => d.kind || "-").join(",") };
      }
      const s = waves.sampleFromDots(0, dots);
      // Each blob, for looking at what was counted where.
      var blobs = dots.map((d) => ({ team: d.team, at: Object.values(mm.gameToPixel(d.x, d.y, f.w)).map(Math.round), area: d.area, n: d.n }));
      minions = {};
      for (const [team, k] of [["blue", "b"], ["red", "r"]])
        for (const [lane, L] of [["top", "TOP"], ["mid", "MIDDLE"], ["bot", "BOTTOM"]]) {
          const want = l.minions[team]?.[lane];
          const got = s.lanes[L][k].length;
          minions[`${team}-${lane}`] = `${got}/${want ?? "?"}`;
          if (typeof want === "number") tot.minionErr.push(Math.abs(got - want));
        }
    }
    frames.push({ file, champs: rows, falseRings: extra, minions, wards: typeof wardRows === "undefined" ? undefined : wardRows, blobs: typeof blobs === "undefined" ? undefined : blobs });
    wardRows = undefined;
    blobs = undefined;
  }
  const e = tot.minionErr.sort((a, b) => a - b);
  const summary = {
    minCover,
    minFill,
    frames: frames.length,
    ringRecall: `${tot.ringed}/${tot.labelled}`,
    stackedRingRecall: `${tot.stackedRinged}/${tot.stackedLabelled}`,
    namedRight: `${tot.named}/${tot.ringed}`,
    namedWrong: tot.wrongName,
    falseRings: tot.falseRings,
    wards: `${tot.wardsFound}/${tot.wardsLabelled} found, ${tot.wardsFalse} false`,
    minionCountErr: e.length ? { median: e[e.length >> 1], max: e[e.length - 1], exact: `${e.filter((x) => x === 0).length}/${e.length}`, within1: `${e.filter((x) => x <= 1).length}/${e.length}` } : null,
  };
  runs.push({ summary, frames });
  }
  const report = { summaries: runs.map((r) => r.summary), runs };
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
