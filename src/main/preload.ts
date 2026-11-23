import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("coach", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s: unknown) => ipcRenderer.invoke("settings:set", s),
  sync: () => ipcRenderer.invoke("games:sync"),
  listGames: () => ipcRenderer.invoke("games:list"),
  onProgress: (cb: (p: { done: number; total: number; label: string }) => void) => {
    const h = (_e: unknown, p: { done: number; total: number; label: string }) => cb(p);
    ipcRenderer.on("sync:progress", h);
    return () => ipcRenderer.removeListener("sync:progress", h);
  },
});
