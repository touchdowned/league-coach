// Dev probe 3: faster capture paths for the replay scan.
//  A) Riot's own Replay API recorder writing PNG frames (no screen capture at all).
//  B) Screen stream with Windows Graphics Capture switched off (Chromium's DXGI path).
//  C) desktopCapturer screenshot cost at full and reduced thumbnail sizes.
// Run with a replay open:  npx electron scripts/probe-replay-3.js <outDir>
const { app, BrowserWindow, desktopCapturer, ipcMain } = require("electron");
app.commandLine.appendSwitch("disable-features", "AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcZeroHz,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer");
const https = require("https");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && !a.endsWith(".js") && a !== ".");
const out = path.resolve(args[0] || "probe-out");
fs.mkdirSync(out, { recursive: true });
app.on("window-all-closed", () => {});
const agent = new https.Agent({ rejectUnauthorized: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, route, body, timeout = 4000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(`https://127.0.0.1:2999${route}`, { method, agent, timeout, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
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
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, data: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

async function streamTest(src) {
  const win = new BrowserWindow({ width: 480, height: 270, x: 0, y: 0, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadURL(
    "data:text/html," +
      encodeURIComponent(`<body style="margin:0;background:#000"><video id=v autoplay muted style="width:100%;height:100%"></video><canvas id=c style="display:none"></canvas><script>
      const { ipcRenderer } = require('electron');
      (async () => {
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: '${src.id}', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } } });
          const v = document.getElementById('v'); v.srcObject = s; await v.play();
          let n = 0; const t0 = performance.now();
          const cb = () => { n++; if (performance.now() - t0 < 4000) return v.requestVideoFrameCallback(cb);
            const c = document.getElementById('c'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 400) sum += d[i] + d[i+1] + d[i+2];
            ipcRenderer.send('fps', { fps: n / 4, w: v.videoWidth, h: v.videoHeight, mean: sum / (d.length / 400) / 3, png: c.toDataURL('image/png') }); };
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
    fs.writeFileSync(path.join(out, `dxgi-screen.png`), Buffer.from(res.png.split(",")[1], "base64"));
    delete res.png;
  }
  win.destroy();
  return res;
}

app.whenReady().then(async () => {
  const report = {};
  // C) screenshot cost
  report.screenshot = [];
  for (const size of [{ width: 1920, height: 1080 }, { width: 960, height: 540 }]) {
    const ms = [];
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      ms.push(Date.now() - t0);
    }
    report.screenshot.push({ size, ms });
  }
  // B) DXGI stream
  const srcs = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  await api("POST", "/replay/playback", { paused: false, speed: 1 });
  report.dxgiStream = srcs[0] ? await streamTest(srcs[0]) : { error: "no screen source" };
  await api("POST", "/replay/playback", { paused: true });

  // A) Riot recorder, PNG frames: 30 game seconds at 2 fps, played at 4x.
  const pb = (await api("GET", "/replay/playback")).data;
  report.playbackBefore = pb;
  const start = 300;
  const end = 330;
  const dir = path.join(out, "recorder-png");
  fs.mkdirSync(dir, { recursive: true });
  await api("POST", "/replay/playback", { time: start, paused: true });
  await sleep(1500);
  const t0 = Date.now();
  const rec = await api("POST", "/replay/recording", { recording: true, codec: "png", path: dir, startTime: start, endTime: end, currentTime: start, framesPerSecond: 2, enforceFrameRate: true, lossless: true, replaySpeed: 4 });
  report.recorderPost = rec;
  await api("POST", "/replay/playback", { time: start, paused: false, speed: 4 });
  let st = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    st = (await api("GET", "/replay/recording")).data;
    if (st && st.recording === false) break;
  }
  report.recorderWallMs = Date.now() - t0;
  report.recorderState = st;
  const files = fs.readdirSync(dir);
  report.recorderFiles = { count: files.length, first: files.slice(0, 3), last: files.slice(-3) };
  // and a webm of the same window, for decoding frames in the app instead
  const dir2 = path.join(out, "recorder-webm");
  fs.mkdirSync(dir2, { recursive: true });
  await api("POST", "/replay/playback", { time: start, paused: true });
  await sleep(1000);
  const t1 = Date.now();
  report.recorderWebmPost = await api("POST", "/replay/recording", { recording: true, codec: "webm", path: dir2, startTime: start, endTime: end, currentTime: start, framesPerSecond: 10, enforceFrameRate: true, lossless: false, replaySpeed: 8 });
  await api("POST", "/replay/playback", { time: start, paused: false, speed: 8 });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const s2 = (await api("GET", "/replay/recording")).data;
    if (s2 && s2.recording === false) break;
  }
  report.recorderWebmWallMs = Date.now() - t1;
  report.recorderWebmFiles = fs.readdirSync(dir2).map((f) => ({ f, bytes: fs.statSync(path.join(dir2, f)).size }));
  await api("POST", "/replay/playback", { paused: true });
  report.playbackAfter = (await api("GET", "/replay/playback")).data;
  fs.writeFileSync(path.join(out, "probe-capture.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
});
