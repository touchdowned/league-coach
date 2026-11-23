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
  replayRead: call("replay:read"),
  benchGet: call("bench:get"),
  onBenchUpdated: (cb: Cb<unknown>) => on("bench:updated", cb),
  replayReadCancel: call("replay:readCancel"),
  onScanProgress: (cb: Cb<unknown>) => on("scan:progress", cb),
  clipsList: call("clips:list"),
  clipsRecord: call("clips:record"),
  clipsCancel: call("clips:cancel"),
  onClipsProgress: (cb: Cb<unknown>) => on("clips:progress", cb),

  vodFind: call("vod:find"),
  vodPick: call("vod:pick"),
  folderPick: call("folder:pick"),

  postGameStatus: call("postgame:status"),
  onPostGameStatus: (cb: Cb<unknown>) => on("postgame:status", cb),
  onPostGameOpen: (cb: Cb<unknown>) => on("postgame:open", cb),

  mindGet: call("mind:get"),
  mindDraftInfo: call("mind:draftInfo"),
  mindLockPlan: call("mind:lockPlan"),
  mindNextPlan: call("mind:nextPlan"),
  mindCloseDraft: call("mind:closeDraft"),
  mindSaveDebrief: call("mind:saveDebrief"),
  mindSkipDebrief: call("mind:skipDebrief"),
  mindCheckIn: call("mind:checkIn"),
  mindPreview: call("mind:preview"),
  mindEndPreview: call("mind:endPreview"),
  mindWindowMode: call("mind:windowMode"),
  mindSetOverlayPos: call("mind:setOverlayPos"),
  onMindDraft: (cb: Cb<unknown>) => on("mind:draft", cb),
  onMindLive: (cb: Cb<unknown>) => on("mind:live", cb),
  onMindPlan: (cb: Cb<unknown>) => on("mind:plan", cb),
  onMindDebrief: (cb: Cb<unknown>) => on("mind:debrief", cb),
});
