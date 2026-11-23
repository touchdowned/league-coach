// Dev probe 2: which capture path gives live frames of the League replay, does a
// transparent always-on-top window show over it, and how does camera follow work?
// Run with a replay open:  npx electron scripts/probe-replay-2.js <outDir> [gdi]
// "gdi" turns off Windows Graphics Capture for windows (Chromium falls back to GDI).
const { app, BrowserWindow, desktopCapturer, ipcMain, screen } = require("electron");
const https = require("https");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith(".js") && a !== ".");
const out = path.resolve(args[0] || "probe-out");
const gdi = args.includes("gdi");
if (gdi) app.commandLine.appendSwitch("disable-features", "WebRtcAllowWgcWindowCapturer,WebRtcAllowWgcScreenCapturer");
fs.mkdirSync(out, { recursive: true });
app.on("window-all-closed", () => {});
const agent = new https.Agent({ rejectUnauthorized: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = gdi ? "gdi" : "wgc";

function api(method, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(`https://127.0.0.1:2999${route}`, { method, agent, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on("error", (e) => resolve({ status: 0, data: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

// Streams a source in a hidden-ish window for 4s; reports fps, size, and mean brightness of the last frame.
async function streamTest(src, name) {
  const win = new BrowserWindow({ width: 640, height: 360, x: 0, y: 0, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadURL(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0;background:#000"><video id=v autoplay muted style="width:100%;height:100%"></video><canvas id=c style="display:none"></canvas><script>
      const { ipcRenderer } = require('electron');
      (async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: '${src.id}', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } } });
          const v = document.getElementById('v'); v.srcObject = s; await v.play();
          let n = 0; const t0 = performance.now();
          const cb = () => {
            n++;
            if (performance.now() - t0 < 4000) return v.requestVideoFrameCallback(cb);
            const c = document.getElementById('c'); c.width = v.videoWidth; c.height = v.videoHeight;
            const g = c.getContext('2d'); g.drawImage(v, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 400) sum += d[i] + d[i+1] + d[i+2];
            ipcRenderer.send('fps', { fps: n / 4, w: v.videoWidth, h: v.videoHeight, mean: sum / (d.length / 400) / 3, png: c.toDataURL('image/png') });
          };
          v.requestVideoFrameCallback(cb);
        } catch (e) { ipcRenderer.send('fps', { error: String(e) }); }
      })();
    </script></body>`),
  );
  const res = await new Promise((r) => {
    ipcMain.once("fps", (_e, v) => r(v));
    setTimeout(() => r({ error: "timeout (no frames)" }), 9000);
  });
  if (res.png) {
    fs.writeFileSync(path.join(out, `${tag}-${name}.png`), Buffer.from(res.png.split(",")[1], "base64"));
    delete res.png;
  }
  win.destroy();
  return res;
}

app.whenReady().then(async () => {
  const report = { tag, display: (() => { const d = screen.getPrimaryDisplay(); return { size: d.size, scale: d.scaleFactor, bounds: d.bounds }; })() };
  const srcs = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 1, height: 1 } });
  const league = srcs.find((s) => /League of Legends \(TM\) Client/i.test(s.name));
  const scr = srcs.find((s) => s.id.startsWith("screen"));
  report.sources = { league: league && league.id, screen: scr && scr.id };
  await api("POST", "/replay/playback", { paused: false, speed: 1 });
  if (league) report.windowStream = await streamTest(league, "window");
  if (scr) report.screenStream = await streamTest(scr, "screen");
  await api("POST", "/replay/playback", { paused: true });

  if (!gdi) {
    // Overlay: transparent, click-through, always on top, covering the primary display.
    const d = screen.getPrimaryDisplay();
    const ov = new BrowserWindow({ ...d.bounds, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, hasShadow: false, backgroundColor: "#00000000", webPreferences: {} });
    ov.setAlwaysOnTop(true, "screen-saver");
    ov.setIgnoreMouseEvents(true);
    await ov.loadURL(
      "data:text/html," +
        encodeURIComponent(`<body style="margin:0;background:transparent;overflow:hidden"><div style="position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);padding:18px 28px;border-radius:14px;background:rgba(10,12,18,.85);color:#fff;font:600 28px system-ui;box-shadow:0 0 0 2px #3ddc97">OVERLAY TEST: if you can read this over League, the overlay works</div>
        <svg style="position:absolute;inset:0" width="100%" height="100%"><line x1="30%" y1="70%" x2="60%" y2="55%" stroke="#3ddc97" stroke-width="10" stroke-linecap="round"/></svg></body>`),
    );
    ov.showInactive();
    await sleep(1500);
    const shot = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1920, height: 1080 } });
    if (shot[0]) fs.writeFileSync(path.join(out, "overlay-screen.png"), shot[0].thumbnail.toPNG());
    report.overlayVisibleOnTop = ov.isAlwaysOnTop();
    ov.destroy();

    // Camera follow: which selectionName works?
    const all = (await api("GET", "/liveclientdata/allgamedata")).data;
    const players = (all && all.allPlayers) || [];
    report.players = players.map((p) => ({ championName: p.championName, riotIdGameName: p.riotIdGameName, summonerName: p.summonerName, riotId: p.riotId, team: p.team }));
    const p0 = players[0] || {};
    const tries = [p0.championName, p0.riotIdGameName, p0.summonerName, p0.riotId].filter(Boolean);
    report.follow = [];
    for (const name of [...new Set(tries)]) {
      await api("POST", "/replay/render", { cameraMode: "top", selectionName: name, cameraAttached: true });
      await sleep(800);
      const r = (await api("GET", "/replay/render")).data;
      report.follow.push({ tried: name, selectionName: r && r.selectionName, cameraAttached: r && r.cameraAttached, cameraPosition: r && r.cameraPosition });
    }
    // Fog: fogOfWar true with a selected champion — capture to see whose fog.
    await api("POST", "/replay/render", { fogOfWar: true });
    await sleep(800);
    const fogShot = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1920, height: 1080 } });
    const lw = fogShot.find((s) => /League of Legends \(TM\) Client/i.test(s.name));
    if (lw) fs.writeFileSync(path.join(out, "fog-on.png"), lw.thumbnail.toPNG());
  }
  fs.writeFileSync(path.join(out, `probe-${tag}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
