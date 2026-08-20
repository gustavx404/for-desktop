import { Menu, Tray, nativeImage } from "electron";

import trayIconAsset from "../../assets/desktop/icon.png?asset";
import macOsTrayIconAsset from "../../assets/desktop/iconTemplate.png?asset";
import { version } from "../../package.json";

import { getStrings } from "./i18n";
import {
  changeServer,
  getCurrentServerUrl,
  getFavoriteServerUrl,
  isDefaultServerUrl,
  mainWindow,
  quitApp,
  useFavoriteServer,
  useOfficialServer,
} from "./window";

// internal tray state
let tray: Tray = null;

// Create and resize tray icon for macOS
function createTrayIcon() {
  if (process.platform === "darwin") {
    const image = nativeImage.createFromDataURL(macOsTrayIconAsset);
    const resized = image.resize({ width: 20, height: 20 });
    resized.setTemplateImage(true);
    return resized;
  } else {
    return nativeImage.createFromDataURL(trayIconAsset);
  }
}

export function initTray() {
  const trayIcon = createTrayIcon();
  tray = new Tray(trayIcon);
  updateTrayMenu();
  tray.setToolTip("Stoat for Desktop");
  tray.setImage(trayIcon);
  tray.on("click", () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

export function updateTrayMenu() {
  // tray may not exist yet the first time the window loads a server
  if (!tray) {
    return;
  }

  const currentServerUrl = getCurrentServerUrl();
  const isOnDefaultServer =
    currentServerUrl !== null && isDefaultServerUrl(currentServerUrl);

  const favoriteServerUrl = getFavoriteServerUrl();
  const isOnFavoriteServer =
    favoriteServerUrl !== null &&
    currentServerUrl !== null &&
    new URL(currentServerUrl).origin === new URL(favoriteServerUrl).origin;

  const t = getStrings().tray;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Stoat for Desktop", type: "normal", enabled: false },
      {
        label: t.version,
        type: "submenu",
        submenu: Menu.buildFromTemplate([
          {
            label: version,
            type: "normal",
            enabled: false,
          },
        ]),
      },
      { type: "separator" },
      {
        label: t.server,
        type: "submenu",
        submenu: Menu.buildFromTemplate([
          {
            label: t.officialServer,
            type: "radio",
            checked: isOnDefaultServer,
            click: useOfficialServer,
          },
          ...(favoriteServerUrl
            ? [
                {
                  label: new URL(favoriteServerUrl).host,
                  type: "radio" as const,
                  checked: isOnFavoriteServer,
                  click: useFavoriteServer,
                },
              ]
            : []),
          // current server matches neither preset above (e.g. a one-off
          // --force-server) -- call it out so the radio group isn't
          // misleading
          ...(currentServerUrl && !isOnDefaultServer && !isOnFavoriteServer
            ? [
                {
                  label: t.other(new URL(currentServerUrl).host),
                  type: "normal" as const,
                  enabled: false,
                },
              ]
            : []),
          { type: "separator" },
          {
            label: t.changeServer,
            type: "normal",
            click: changeServer,
          },
        ]),
      },
      { type: "separator" },
      {
        label: mainWindow.isVisible() ? t.hideApp : t.showApp,
        type: "normal",
        click() {
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
          }
        },
      },
      {
        label: t.quitApp,
        type: "normal",
        click: quitApp,
      },
    ]),
  );
}
