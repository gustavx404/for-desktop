import { contextBridge, ipcRenderer } from "electron";

import { version } from "../../package.json";

contextBridge.exposeInMainWorld("native", {
  versions: {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron,
    desktop: () => version,
  },

  minimise: () => ipcRenderer.send("minimise"),
  maximise: () => ipcRenderer.send("maximise"),
  close: () => ipcRenderer.send("close"),

  selectServer: (url: string) => ipcRenderer.send("selectServer", url),

  setBadgeCount: (count: number) => ipcRenderer.send("setBadgeCount", count),

  onceScreenPicker: (
    onScreenPick: (
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
      }[],
    ) => void,
  ) => {
    const eventName = "screenPicker";
    ipcRenderer.removeAllListeners(eventName);
    ipcRenderer.once(eventName, (_, sources) => onScreenPick(sources));
  },
  screenPickerCallback: (idx: number, audio: boolean) =>
    ipcRenderer.send("screenPickerCallback", idx, audio),

  audioSharePickerCallback: (
    mode: { type: "app"; appName: string } | { type: "all" } | { type: "none" },
  ) => ipcRenderer.send("audioSharePickerCallback", mode),

  screenShareEnded: () => ipcRenderer.send("screenShareEnded"),

  // Replaces the `sources[0].id.startsWith("window:")` check the main
  // process used to make on its own from Chromium's desktopCapturer
  // source id -- now that the Rust capture addon (world/screenShareCapture.ts)
  // does its own portal negotiation, only the renderer knows the picked
  // source type (reported via the addon's onReady callback), so it has to
  // tell the main process which decision to make.
  pickScreenShareAudio: (opts: { isWindow: boolean }) =>
    ipcRenderer.invoke("screenShareSourcePicked", opts),

  isWayland: () => ipcRenderer.invoke("getIsWayland"),
});
