import { app, Notification } from "electron";
import { autoUpdater } from "electron-updater";

const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Keeps the installed app up to date from this repo's GitHub Releases. Every push to the
 * release branch builds a new installer in CI; this downloads it in the background and
 * installs it the next time the app closes (or right away if you click the notification).
 * Settings, the API key and saved games live in the user data folder, which updates never touch.
 */
export function startAutoUpdates(): void {
  // `npm start` / `npm run dev` run from source: nothing to update.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  let notified = false;
  autoUpdater.on("update-downloaded", (info) => {
    if (notified || !Notification.isSupported()) return;
    notified = true;
    const n = new Notification({
      title: "League Coach update ready",
      body: `Version ${info.version} installs when you close the app. Click to restart now.`,
    });
    n.on("click", () => autoUpdater.quitAndInstall(true, true));
    n.show();
  });
  autoUpdater.on("error", (err) => console.warn("Update check failed:", err?.message ?? err));

  const check = () => autoUpdater.checkForUpdates().catch(() => undefined);
  check();
  setInterval(check, CHECK_EVERY_MS).unref?.();
}
