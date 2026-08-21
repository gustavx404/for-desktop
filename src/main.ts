import { IUpdateInfo, updateElectronApp } from "update-electron-app";

import { BrowserWindow, Notification, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { getStrings } from "./native/i18n";
import { initTray } from "./native/tray";
import { initVirtualMic } from "./native/virtualMic";
import {
  createMainWindow,
  isNavigationAllowed,
  mainWindow,
} from "./native/window";

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
} else if (process.platform === "linux") {
  // Rendering hardware acceleration (the toggle above) and WebRTC's
  // hardware *video encoding* are separate Chromium switches -- having
  // the former on doesn't turn on the latter. Without this, screen-share
  // video (1080p+ especially) gets encoded entirely in software, which
  // can't keep up in real time on a lot of hardware -- confirmed live as
  // the actual bottleneck once the capture pipeline itself stopped being
  // one (frames arriving fine, but the encoder falling behind and
  // dropping most of them before they ever reach the network). VA-API is
  // the Linux hardware video accel API (Mesa on AMD/Intel, proprietary
  // driver on Nvidia); VaapiIgnoreDriverChecks covers drivers Chromium
  // doesn't have on its own allowlist but that do work.
  //
  // AcceleratedVideoEncoder: Chromium renamed/added this as the real
  // gate for hardware video ENCODE as of Chromium 131 -- VaapiVideoEncoder
  // alone (this Electron's Chromium is 150) was confirmed live to NOT be
  // enough on its own: with only VaapiVideoEncoder set, a real screen
  // share fell back to software OpenH264 even though `ffmpeg -c:v
  // h264_vaapi` confirmed the driver itself works and can hardware encode
  // H264/HEVC on this exact GPU. Adding this flag was confirmed live to
  // fix it: real outbound-rtp stats went from
  // encoderImplementation:"OpenH264" to
  // encoderImplementation:"VaapiVideoEncodeAccelerator",
  // powerEfficientEncoder:true, and renderer CPU during an active share
  // dropped from ~300% (software VP8) to ~160% (hardware H264) at the
  // same 2560x1440 resolution.
  app.commandLine.appendSwitch(
    "enable-features",
    "VaapiVideoEncoder,VaapiVideoDecoder,VaapiIgnoreDriverChecks,AcceleratedVideoEncoder",
  );
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

const onNotifyUser = (_info: IUpdateInfo) => {
  const t = getStrings().notifications;

  const notification = new Notification({
    title: t.updateAvailableTitle,
    body: t.updateAvailableBody,
    silent: true,
  });

  notification.show();
};

if (acquiredLock) {
  // start auto update logic
  updateElectronApp({ onNotifyUser });

  // create and configure the app when electron is ready
  app.on("ready", () => {
    // create window and application contexts
    createMainWindow();

    // save first launch state
    if (config.firstLaunch) {
      // Doesn't do anything right now. Used to enable auto start, but that behaviour was removed.
      // Left in case it gets used in the future.
      config.firstLaunch = false;
    }

    initTray();
    initDiscordRpc();
    initVirtualMic();

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.stoat.notifications");
    }
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // prevent navigation out of build URL origin
    contents.on("will-navigate", (event, navigationUrl) => {
      if (!isNavigationAllowed(navigationUrl)) {
        event.preventDefault();
      }
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
