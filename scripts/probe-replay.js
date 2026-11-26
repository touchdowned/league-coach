// Dev probe: can we stream the League replay window into an Electron window, and how
// does the Replay API camera map world points to the screen?
// Run with a replay open:  npx electron scripts/probe-replay.js  [outDir]
// Writes PNGs + probe.json to outDir (default ./probe-out). Restores the camera after.
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require("electron");
const https = require("https");
const fs = require("fs");
const path = require("path");

const out = path.resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("-") && !a.endsWith(".js")) || "probe-out");
fs.mkdirSync(out, { recursive: true });
const agent = new https.Agent({ rejectUnauthorized: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      `https://127.0.0.1:2999${route}`,
      { method, agent, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, data: raw });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, data: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

async function grab(name, sourceId) {
  const srcs = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 1920, height: 1080 } });
  const s = srcs.find((x) => x.id === sourceId) || srcs.find((x) => /League of Legends/i.test(x.name));
  if (!s) return null;
  fs.writeFileSync(path.join(out, `${name}.png`), s.thumbnail.toPNG());
  return s.thumbnail.getSize();
}

app.whenReady().then(async () => {
  const report = { started: new Date().toISOString() };
  const srcs = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 320, height: 180 } });
  report.sources = srcs.map((s) => ({ id: s.id, name: s.name }));
  const league = srcs.find((s) => /League of Legends \(TM\) Client/i.test(s.name)) || srcs.find((s) => /League of Legends/i.test(s.name) && s.id.startsWith("window"));
  report.leagueSource = league ? { id: league.id, name: league.name } : null;

  report.playback = (await api("GET", "/replay/playback")).data;
  const original = (await api("GET", "/replay/render")).data;
  report.renderOriginal = original;
  report.game = (await api("GET", "/replay/game")).data;
  report.liveclient = (await api("GET", "/liveclientdata/allgamedata")).data;
  if (report.liveclient && typeof report.liveclient === "object") {
    // Keep it short: players' names/champs/positions if any, no full item lists.
    report.liveclient = { gameData: report.liveclient.gameData, players: (report.liveclient.allPlayers || []).map((p) => ({ championName: p.championName, team: p.team, position: p.position })) };
  }

  // 1. Live stream of the League window into our own window, measured for fps.
  if (league) {
    const win = new BrowserWindow({ width: 960, height: 600, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => cb({ video: league }));
    await win.loadURL(
      "data:text/html," +
        encodeURIComponent(`<body style="margin:0;background:#000"><video id=v autoplay muted style="width:100%;height:100%"></video><script>
        const { ipcRenderer } = require('electron');
        (async () => {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: '${league.id}', maxWidth: 1920, maxHeight: 1080, maxFrameRate: 60 } } });
            const v = document.getElementById('v'); v.srcObject = s; await v.play();
            let n = 0; const t0 = performance.now();
            const cb = () => { n++; if (performance.now() - t0 < 4000) v.requestVideoFrameCallback(cb); else ipcRenderer.send('fps', { fps: n / 4, w: v.videoWidth, h: v.videoHeight, settings: s.getVideoTracks()[0].getSettings() }); };
            v.requestVideoFrameCallback(cb);
          } catch (e) { ipcRenderer.send('fps', { error: String(e) }); }
        })();
      </script></body>`),
    );
    // Play the replay so frames actually change while we measure.
    await api("POST", "/replay/playback", { paused: false, speed: 1 });
    report.stream = await new Promise((res) => {
      ipcMain.once("fps", (_e, v) => res(v));
      setTimeout(() => res({ error: "timeout" }), 12000);
    });
    await api("POST", "/replay/playback", { paused: true });
    await sleep(500);
    fs.writeFileSync(path.join(out, "stream-window.png"), (await win.webContents.capturePage()).toPNG());
    win.close();
  }

  // 2. Camera conventions. Paused; set the camera ourselves and capture.
  const shots = [
    { name: "cam-a", body: { cameraAttached: false, cameraMode: "fps", cameraPosition: { x: 10504, y: 1911, z: 1029 - 1289 }, cameraRotation: { x: 0, y: 56, z: 0 }, fieldOfView: 40 } },
    { name: "cam-b", body: { cameraAttached: false, cameraMode: "fps", cameraPosition: { x: 7400, y: 3000, z: 7400 - 2000 }, cameraRotation: { x: 0, y: 56, z: 0 }, fieldOfView: 40 } },
    { name: "cam-c", body: { cameraAttached: false, cameraMode: "fps", cameraPosition: { x: 7400, y: 3000, z: 7400 - 2000 }, cameraRotation: { x: 30, y: 45, z: 0 }, fieldOfView: 40 } },
    { name: "cam-d", body: { cameraAttached: false, cameraMode: "top", cameraPosition: { x: 7400, y: 3000, z: 7400 - 2000 }, cameraRotation: { x: 0, y: 56, z: 0 }, fieldOfView: 40 } },
  ];
  report.shots = [];
  await api("POST", "/replay/render", { interfaceAll: false });
  for (const s of shots) {
    const set = await api("POST", "/replay/render", s.body);
    await sleep(1200);
    const after = (await api("GET", "/replay/render")).data;
    const size = await grab(s.name, league && league.id);
    report.shots.push({ name: s.name, sent: s.body, status: set.status, after: after && { cameraMode: after.cameraMode, cameraPosition: after.cameraPosition, cameraRotation: after.cameraRotation, fieldOfView: after.fieldOfView, cameraAttached: after.cameraAttached }, size });
  }

  // 3. Sequence API: does it accept a smooth camera move?
  const pb = (await api("GET", "/replay/playback")).data;
  const t = pb && pb.time ? pb.time : 600;
  const seq = {
    cameraPosition: [
      { time: t, value: { x: 7400, y: 3000, z: 5400 }, blend: "smoothStep" },
      { time: t + 3, value: { x: 9000, y: 3000, z: 5400 }, blend: "smoothStep" },
    ],
    cameraRotation: [
      { time: t, value: { x: 0, y: 56, z: 0 }, blend: "smoothStep" },
      { time: t + 3, value: { x: 0, y: 56, z: 0 }, blend: "smoothStep" },
    ],
  };
  report.sequencePost = await api("POST", "/replay/sequence", seq);
  report.sequenceGet = (await api("GET", "/replay/sequence")).data;
  await api("POST", "/replay/sequence", {}); // clear

  // Restore.
  if (original && typeof original === "object") await api("POST", "/replay/render", original);
  report.renderRestored = (await api("GET", "/replay/render")).data?.cameraMode;
  fs.writeFileSync(path.join(out, "probe.json"), JSON.stringify(report, null, 2));
  console.log("probe written to", out);
  app.quit();
});
