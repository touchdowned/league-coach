import { contextBridge, ipcRenderer } from "electron";

type Cb<T> = (p: T) => void;
const on = <T>(channel: string, cb: Cb<T>) => {
  const h = (_e: unknown, p: T) => cb(p);
  ipcRenderer.on(channel, h);
  return () => {
    ipcRenderer.removeListener(channel, h);
  };
};
const call = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("coach", {
  getSettings: call("settings:get"),
  setSettings: call("settings:set"),
  sync: call("games:sync"),
  listGames: call("games:list"),
  onProgress: (cb: Cb<unknown>) => on("sync:progress", cb),

  getProgress: call("progress:get"),
  progressEvent: call("progress:event"),

  replayState: call("replay:state"),
  replayDownload: call("replay:download"),
  replayWatch: call("replay:watch"),
  replaySeek: call("replay:seek"),
  replayFollow: call("replay:follow"),
  replayEnableApi: call("replay:enableApi"),
  clipsList: call("clips:list"),
  clipsRecord: call("clips:record"),
  clipsCancel: call("clips:cancel"),
  onClipsProgress: (cb: Cb<unknown>) => on("clips:progress", cb),

  vodFind: call("vod:find"),
  vodPick: call("vod:pick"),
  folderPick: call("folder:pick"),
});
