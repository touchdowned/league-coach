// Some npm setups skip Electron's postinstall, leaving no electron.exe.
// Download it if it's missing so `npm start` and `npm run dev` work on a fresh clone.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = path.join(__dirname, "..", "node_modules", "electron");
if (!fs.existsSync(path.join(dir, "path.txt"))) {
  console.log("Electron binary missing, downloading it...");
  execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
}
