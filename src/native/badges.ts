import dbus from "@homebridge/dbus-native";

import { NativeImage, app, ipcMain, nativeImage } from "electron";

import { getStrings } from "./i18n";
import { mainWindow } from "./window";

// internal state
const nativeIcons: Record<number, NativeImage> = {};
let sessionBus: dbus.MessageBus | null;

export async function setBadgeCount(count: number) {
  const t = getStrings().accessibility;

  switch (process.platform) {
    case "win32":
    case "linux": {
      if (count === 0) {
        mainWindow.setOverlayIcon(null, t.noNotifications);
        break;
      }

      // Cache key must match the asset actually loaded (clamped to 10),
      // not the raw count -- keying by count would grow this cache
      // without bound as unread counts climb over a long session (each
      // distinct count above 10 would cache its own redundant copy of
      // the exact same "10.ico" bitmap instead of reusing one).
      const iconKey = Math.min(count, 10);
      if (!nativeIcons[iconKey])
        nativeIcons[iconKey] = nativeImage.createFromDataURL(
          await import(`../../assets/desktop/badges/${iconKey}.ico?asset`).then(
            (asset) => asset.default,
          ),
        );

      mainWindow.setOverlayIcon(
        nativeIcons[iconKey],
        count === -1 ? t.unreadMessages : t.notificationsCount(count),
      );

      break;
    }
    // @ts-expect-error this is `linux` block
    case "_": // todo: try to get this to work
      // send D-Bus message
      // @ts-expect-error undocumented API
      if (!sessionBus) sessionBus = dbus.sessionBus();

      // @ts-expect-error undocumented API
      sessionBus.connection.message({
        // @ts-expect-error undocumented API
        type: dbus.messageType.signal,
        serial: 1,
        path: "/",
        interface: "com.canonical.Unity.LauncherEntry",
        member: "Update",
        signature: "sa{sv}",
        body: [
          process.env.container === "1"
            ? "application://chat.stoat.StoatDesktop.desktop" // flatpak handling
            : "application://stoat-desktop.desktop",
          [
            ["count", ["x", Math.min(count, 0)]],
            ["count-visible", ["b", count !== 0]],
          ],
        ],
      });

      break;
    case "darwin":
      app.dock.setBadge(
        count === -1 ? "•" : count === 0 ? "" : count.toString(),
      );

      break;
  }
}

ipcMain.on("setBadgeCount", (_event, count: number) => setBadgeCount(count));
