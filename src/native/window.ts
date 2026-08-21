import { join } from "node:path";

import {
  BrowserWindow,
  Menu,
  MenuItem,
  app,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
} from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";

import {
  type PickerTheme,
  buildAudioSharePickerHtml,
} from "./audioSharePicker";
import { config } from "./config";
import { getStrings } from "./i18n";
import { buildServerPickerHtml } from "./serverPicker";
import { updateTrayMenu } from "./tray";
import {
  AudioCaptureMode,
  getActiveAudioApps,
  isWayland,
  setAudioCaptureMode,
} from "./virtualMic";

// global reference to main window
export let mainWindow: BrowserWindow;

// official server used when no self-hosted server has been picked
export const DEFAULT_SERVER_URL = "https://stoat.chat/app";

// server currently loaded in the main window, used to guard cross-origin
// navigation and to report state to the tray menu; `null` while the
// server picker screen itself is showing
let activeServerUrl: string | null = null;

// internal window state
let shouldQuit = false;

// how many times the current server load has been auto-retried after
// mounting nothing; reset on every new navigation so each attempt gets
// its own retry budget
let rootMountRetryCount = 0;
const MAX_ROOT_MOUNT_RETRIES = 3;

/**
 * Server forced via `--force-server=<url>`, bypassing the picker screen
 * and taking priority over any previously saved server.
 */
function getForcedServerUrl(): string | undefined {
  return app.commandLine.hasSwitch("force-server")
    ? app.commandLine.getSwitchValue("force-server")
    : undefined;
}

/**
 * The server currently loaded in the main window, or `null` while the
 * server picker screen is showing.
 */
export function getCurrentServerUrl() {
  return activeServerUrl;
}

/**
 * The last self-hosted (non-official) server the user connected to, kept
 * around as a "favourite" even after switching to the official server or
 * elsewhere, so it stays one click away.
 */
export function getFavoriteServerUrl() {
  return config.favoriteServerUrl || null;
}

export function isDefaultServerUrl(url: string) {
  return new URL(url).origin === new URL(DEFAULT_SERVER_URL).origin;
}

/**
 * Whether navigation to the given URL should be allowed to happen
 * in-window, rather than being blocked (external links are handled
 * separately via `setWindowOpenHandler`).
 */
export function isNavigationAllowed(navigationUrl: string) {
  return (
    activeServerUrl !== null &&
    new URL(navigationUrl).origin === new URL(activeServerUrl).origin
  );
}

/**
 * Strip characters that shouldn't be part of a URL but can sneak in when
 * pasting from chat apps and the like (e.g. a zero-width space some apps
 * insert after links to allow wrapping). Left in, these get percent-encoded
 * into the path and silently break the remote app's routing. Also strips
 * their already percent-encoded form, since an earlier version of this app
 * could have saved a value that had already gone through this once.
 */
function sanitizeServerUrl(rawUrl: string) {
  // each code point below is stripped individually, not matched as a cluster
  // eslint-disable-next-line no-misleading-character-class
  let value = rawUrl.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "").trim();

  // strip a trailing run of percent-encoded space/invisible characters
  value = value.replace(
    /(%20|%E2%80%8B|%E2%80%8C|%E2%80%8D|%E2%81%A0|%EF%BB%BF)+$/gi,
    "",
  );

  return value;
}

/**
 * Load a server (official or self-hosted) into the main window.
 * By default the choice is persisted so it's remembered on next launch.
 */
function loadServer(rawUrl: string, persist = true) {
  const url = new URL(sanitizeServerUrl(rawUrl));

  // Only ever navigate the window to an actual server. `selectServer`
  // (the IPC channel behind this) is reachable from any page loaded in
  // this window, including whatever self-hosted server the user has
  // connected to -- without this, a compromised or malicious server
  // could point the whole window at file:// or another local-resource
  // scheme instead of a remote one.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    showServerPicker(undefined, true);
    return;
  }

  activeServerUrl = url.toString();
  rootMountRetryCount = 0;

  if (persist) {
    config.serverUrl = url.toString();

    // remember self-hosted servers as the favourite, so it's still one
    // click away after switching to the official server or elsewhere
    if (!isDefaultServerUrl(url.toString())) {
      config.favoriteServerUrl = url.toString();
    }
  }

  mainWindow.loadURL(url.toString()).catch(() => {
    // couldn't reach the server (DNS not resolving yet, server down,
    // no network, ...) -- fall back to the picker instead of leaving a
    // blank window with no visible way to retry or switch servers
    showServerPicker(url.toString(), true);
  });

  updateTrayMenu();
}

/**
 * Show the Bitwarden-style landing screen, letting the user continue to
 * the currently configured server or switch to another one.
 *
 * @param prefillUrl server to show/continue to; defaults to the saved one
 * @param connectionError whether to show a "couldn't connect" notice,
 *   e.g. after a failed automatic load
 */
function showServerPicker(prefillUrl?: string, connectionError = false) {
  activeServerUrl = null;

  mainWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      buildServerPickerHtml({
        defaultServerUrl: DEFAULT_SERVER_URL,
        savedServerUrl: prefillUrl ?? config.serverUrl,
        favoriteServerUrl: config.favoriteServerUrl,
        connectionError,
        strings: getStrings().picker,
      }),
    )}`,
  );

  updateTrayMenu();
}

// The MDUI (Material Design 3) color tokens the picker cares about,
// read from the app's own live CSS custom properties -- keep in sync
// with PickerTheme in audioSharePicker.ts. MDUI's unsuffixed
// `--mdui-color-*` variables always reflect whichever scheme (light or
// dark) and accent the user currently has set in the app itself, so
// reading them live is what makes the picker "follow the theme in
// settings" instead of guessing at a fixed look of our own.
const THEME_COLOR_KEYS = [
  "surface-container",
  "surface-container-high",
  "on-surface",
  "on-surface-variant",
  "outline-variant",
  "primary",
] as const;

/**
 * Reads the app's current MDUI design tokens -- color, typography, and
 * shape -- straight out of the main window's computed styles. Returns
 * null (letting the picker fall back to its own fixed dark palette) if
 * the app hasn't rendered far enough to have them yet, or isn't using
 * MDUI at all.
 */
async function getThemeTokens(): Promise<Partial<PickerTheme> | null> {
  try {
    const result = (await mainWindow.webContents.executeJavaScript(`
      (() => {
        // Read from <body>, not <html>: MDUI's color-scheme tokens on
        // the root element reflect the light scheme regardless of what
        // the app actually displays -- the app applies its real active
        // scheme (dark, in the common case) further down, at <body>.
        const cs = getComputedStyle(document.body);
        const color = {};
        for (const key of ${JSON.stringify(THEME_COLOR_KEYS)}) {
          const value = cs.getPropertyValue("--mdui-color-" + key).trim();
          if (value) color[key] = value;
        }
        return {
          color,
          fontFamily: cs.fontFamily,
          titleSize: cs.getPropertyValue("--mdui-typescale-title-medium-size").trim(),
          titleWeight: cs.getPropertyValue("--mdui-typescale-title-medium-weight").trim(),
          bodySize: cs.getPropertyValue("--mdui-typescale-body-medium-size").trim(),
          bodyWeight: cs.getPropertyValue("--mdui-typescale-body-medium-weight").trim(),
          labelSmallSize: cs.getPropertyValue("--mdui-typescale-body-small-size").trim(),
          cornerLarge: cs.getPropertyValue("--mdui-shape-corner-large").trim(),
          cornerMedium: cs.getPropertyValue("--mdui-shape-corner-medium").trim(),
          elevation: cs.getPropertyValue("--mdui-elevation-level2").trim(),
        };
      })()
    `)) as {
      color: Record<string, string>;
      fontFamily: string;
      titleSize: string;
      titleWeight: string;
      bodySize: string;
      bodyWeight: string;
      labelSmallSize: string;
      cornerLarge: string;
      cornerMedium: string;
      elevation: string;
    };

    if (!result || Object.keys(result.color).length === 0) return null;

    return {
      surfaceContainer: result.color["surface-container"],
      surfaceContainerHigh: result.color["surface-container-high"],
      onSurface: result.color["on-surface"],
      onSurfaceVariant: result.color["on-surface-variant"],
      outlineVariant: result.color["outline-variant"],
      primary: result.color["primary"],
      fontFamily: result.fontFamily || undefined,
      titleSize: result.titleSize || undefined,
      titleWeight: result.titleWeight || undefined,
      bodySize: result.bodySize || undefined,
      bodyWeight: result.bodyWeight || undefined,
      labelSmallSize: result.labelSmallSize || undefined,
      cornerLarge: result.cornerLarge || undefined,
      cornerMedium: result.cornerMedium || undefined,
      elevation: result.elevation || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * In-app popup asking which app's audio to include in a window share --
 * a styled replacement for the native OS context menu this used to be,
 * so it reads as part of the app rather than a disconnected system
 * popup. `onChoice` is called once with the picked mode; if the popup is
 * closed without a choice (clicking away, Esc), it's called with
 * `{ type: "all" }`, mirroring the native menu's old dismiss behaviour.
 */
async function showAudioSharePicker(
  apps: string[],
  onChoice: (mode: AudioCaptureMode) => void,
) {
  let responded = false;
  const respond = (mode: AudioCaptureMode) => {
    if (responded) return;
    responded = true;
    onChoice(mode);
  };

  const theme = await getThemeTokens();

  const picker = new BrowserWindow({
    width: 320,
    height: 400,
    parent: mainWindow,
    modal: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#191919",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Same reasoning as the main window's webPreferences below -- this
      // shares the same bundled preload.js, which requires it too.
      sandbox: false,
    },
  });

  picker.setMenu(null);

  const onCallback = (_: unknown, mode: AudioCaptureMode) => {
    respond(mode);
    picker.close();
  };
  ipcMain.once("audioSharePickerCallback", onCallback);

  // closed without an explicit choice (clicked away, Esc, alt-f4, the
  // close button) -- same fallback the native menu used to apply on
  // dismiss. `ipcMain.once` only unregisters itself when the event it's
  // listening for actually fires, so a picker dismissed this way (a
  // very common path -- Esc/click-away/close-button are all faster than
  // picking an option) would otherwise leave that listener -- and the
  // closure it holds onto (this whole function's `apps`, `picker`,
  // `respond`) -- registered on the module-global ipcMain forever, an
  // unbounded leak that grows by one every time the picker is dismissed
  // this way. Explicitly removing it here (a no-op if it already fired
  // and self-removed) closes that gap.
  picker.once("closed", () => {
    ipcMain.removeListener("audioSharePickerCallback", onCallback);
    respond({ type: "all" });
  });

  picker.once("ready-to-show", () => picker.show());

  picker.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      buildAudioSharePickerHtml({
        apps,
        strings: getStrings().screenShareAudio,
        theme,
      }),
    )}`,
  );
}

/**
 * Decide what screen-share audio routing to apply for a freshly picked
 * source, and (for a Wayland window share) show the app picker and wait
 * for a choice. Shared between `setDisplayMediaRequestHandler` below
 * (used when Chromium/desktopCapturer picked the source -- now only the
 * fallback path, for when the Rust capture addon isn't available) and the
 * `screenShareSourcePicked` IPC handler (used when the renderer's own
 * portal negotiation, via the addon, picked the source instead -- see
 * world/screenShareCapture.ts). Either way `showAudioSharePicker`,
 * `getActiveAudioApps`, and `setAudioCaptureMode` don't care how the
 * source was picked, only what apps are running and what mode the user
 * chooses, so this logic didn't need to change, just be reachable from
 * two call sites instead of one.
 */
async function resolveScreenShareAudioMode({
  isWindow,
  audioRequested,
}: {
  isWindow: boolean;
  audioRequested: boolean;
}): Promise<void> {
  if (!audioRequested) return;

  // On Wayland the screen-capture portal doesn't tell us which window
  // was picked (only whether it was a window at all) -- so when it's a
  // specific window, ask which app's audio to include instead of always
  // grabbing everything.
  if (isWayland && isWindow) {
    const apps = getActiveAudioApps();
    await new Promise<void>((resolve) => {
      showAudioSharePicker(apps, (mode) => {
        setAudioCaptureMode(mode);
        resolve();
      });
    });
    return;
  }

  setAudioCaptureMode({ type: "all" });
}

/**
 * Show the landing screen again so the user can switch servers, e.g. from
 * the tray menu. Does not touch the currently saved server.
 */
export function changeServer() {
  showServerPicker();
}

/**
 * Some server connections (particularly self-hosted ones over higher or
 * less predictable latency links) occasionally finish loading without the
 * remote app ever mounting its UI, leaving a blank window with nothing to
 * click. Detect that and retry a few times with a short backoff -- this
 * isn't something we can fix on our end since the remote app's own
 * startup is out of our control, so retrying automatically is the best we
 * can do. If it still hasn't mounted after a few attempts, fall back to
 * the picker with a notice instead of leaving the window blank forever.
 */
function scheduleRootMountCheck() {
  const urlAtSchedule = activeServerUrl;

  setTimeout(async () => {
    // a different server was loaded (or the picker is showing) since this
    // check was scheduled -- nothing to do
    if (activeServerUrl !== urlAtSchedule) {
      return;
    }

    let mounted = true;
    try {
      mounted = await mainWindow.webContents.executeJavaScript(
        `!!(document.getElementById("root") && document.getElementById("root").children.length > 0)`,
      );
    } catch {
      // couldn't check (e.g. window was closed); assume it's fine
      return;
    }

    if (mounted || activeServerUrl !== urlAtSchedule) {
      return;
    }

    if (rootMountRetryCount >= MAX_ROOT_MOUNT_RETRIES) {
      showServerPicker(urlAtSchedule, true);
      return;
    }

    rootMountRetryCount++;
    setTimeout(() => {
      if (activeServerUrl === urlAtSchedule) {
        mainWindow.webContents.reload();
      }
    }, 1000);
  }, 4000);
}

/**
 * Switch straight to the official server, e.g. from the tray menu while
 * connected to a self-hosted one.
 */
export function useOfficialServer() {
  loadServer(DEFAULT_SERVER_URL);
}

/**
 * Switch straight to the saved favourite self-hosted server, e.g. from
 * the tray menu while connected to the official server or another one.
 */
export function useFavoriteServer() {
  if (config.favoriteServerUrl) {
    loadServer(config.favoriteServerUrl);
  }
}

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

/**
 * Create the main application window
 */
export function createMainWindow() {
  // (CLI arg --hidden or config)
  const startHidden =
    app.commandLine.hasSwitch("hidden") || config.startMinimisedToTray;
  const isMacOS = process.platform === "darwin";

  // create the window
  mainWindow = new BrowserWindow({
    minWidth: 300,
    minHeight: 300,
    width: 1280,
    height: 720,
    backgroundColor: "#191919",
    frame: isMacOS ? true : !config.customFrame,
    titleBarStyle: isMacOS ? "hidden" : "default",
    trafficLightPosition: isMacOS ? { x: 8, y: 8 } : undefined,
    icon: windowIcon,
    show: !startHidden,
    webPreferences: {
      // relative to `.vite/build`
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Electron's sandboxed preload (the default since Electron 20) only
      // exposes a curated require() -- electron's own modules plus a
      // handful of Node builtins -- and categorically cannot load native
      // addons via require()/process.dlopen() at all (confirmed against
      // electron/electron#36012). world/screenShareCapture.ts requires
      // the Rust screen-capture addon (native/screen-capture) directly
      // from the preload script, which needs the unrestricted preload
      // Node environment this turns back on. contextIsolation stays on
      // above -- the page's own JS still has no Node/require access,
      // only this preload script does.
      sandbox: false,
    },
  });

  // hide the options
  mainWindow.setMenu(null);

  // restore last position if it was moved previously
  if (config.windowState.x > 0 || config.windowState.y > 0) {
    mainWindow.setPosition(
      config.windowState.x ?? 0,
      config.windowState.y ?? 0,
    );
  }

  // restore last size if it was resized previously
  if (config.windowState.width > 0 && config.windowState.height > 0) {
    mainWindow.setSize(
      config.windowState.width ?? 1280,
      config.windowState.height ?? 720,
    );
  }

  // maximise the window if it was maximised before
  if (config.windowState.isMaximised && !startHidden) {
    mainWindow.maximize();
  }

  // load the entrypoint: a forced server always wins, then a previously
  // saved server, otherwise show the self-host picker screen
  const forcedServerUrl = getForcedServerUrl();
  if (forcedServerUrl) {
    loadServer(forcedServerUrl, false);
  } else if (config.serverUrl) {
    loadServer(config.serverUrl);
  } else {
    showServerPicker();
  }

  // handle the picker screen's server selection
  ipcMain.on("selectServer", (_, url: string) => loadServer(url));

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // update tray menu when window is shown/hidden
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);

  // keep track of window state
  function generateState() {
    config.windowState = {
      x: mainWindow.getPosition()[0],
      y: mainWindow.getPosition()[1],
      width: mainWindow.getSize()[0],
      height: mainWindow.getSize()[1],
      isMaximised: mainWindow.isMaximized(),
    };
  }

  mainWindow.on("maximize", generateState);
  mainWindow.on("unmaximize", generateState);
  mainWindow.on("moved", generateState);
  mainWindow.on("resized", generateState);

  // rebind zoom controls to be more sensible
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.control && (input.key === "=" || input.key === "+")) {
      // zoom in (+)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() + 1,
      );
    } else if (input.control && input.key === "-") {
      // zoom out (-)
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() - 1,
      );
    } else if (input.control && input.key === "0") {
      // reset zoom to default.
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
    } else if (
      input.key === "F5" ||
      ((input.control || input.meta) && input.key.toLowerCase() === "r")
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  // send the config, and check that a loaded server actually mounted its
  // UI (not while our own picker page is showing)
  mainWindow.webContents.on("did-finish-load", () => {
    config.sync();

    if (activeServerUrl) {
      scheduleRootMountCheck();
    }
  });

  // dom-ready fires as soon as the (still blank) page shell exists, well
  // before the remote app's own JS has mounted anything into it -- cover
  // that gap with a loading overlay so a slow connection (self-hosted
  // servers especially) doesn't just look like a frozen blank window
  mainWindow.webContents.on("dom-ready", () => {
    if (!activeServerUrl) {
      return;
    }

    const connectingText = JSON.stringify(getStrings().picker.connecting);

    mainWindow.webContents
      .executeJavaScript(
        `(function () {
          if (document.getElementById("__stoatLoadingOverlay")) return;
          var overlay = document.createElement("div");
          overlay.id = "__stoatLoadingOverlay";
          overlay.style.cssText =
            "position:fixed;inset:0;z-index:2147483647;display:flex;" +
            "flex-direction:column;align-items:center;justify-content:center;" +
            "gap:14px;background:#191919;color:#9a9a9a;" +
            "font:13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto," +
            "Helvetica,Arial,sans-serif;";
          overlay.innerHTML =
            '<div style="width:28px;height:28px;border:3px solid ' +
            'rgba(255,255,255,0.15);border-top-color:#ff4655;' +
            'border-radius:50%;animation:__stoatSpin .7s linear infinite;">' +
            '</div><div>' + ${connectingText} + '</div><style>@keyframes ' +
            '__stoatSpin{to{transform:rotate(360deg)}}</style>';
          document.body.appendChild(overlay);

          function tryRemove() {
            var root = document.getElementById("root");
            if (root && root.children.length > 0) {
              overlay.remove();
              return true;
            }
            return false;
          }

          if (tryRemove()) return;

          var observer = new MutationObserver(function () {
            if (tryRemove()) observer.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true });

          // safety net: don't leave the overlay stuck forever if #root
          // never shows up (the retry/fallback logic elsewhere handles
          // that case on its own timeline)
          setTimeout(function () {
            observer.disconnect();
            var el = document.getElementById("__stoatLoadingOverlay");
            if (el) el.remove();
          }, 15000);
        })();`,
      )
      .catch(() => {
        // page may not be ready to accept injected scripts yet; ignore
      });
  });

  // configure spellchecker context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menu = new Menu();
    const t = getStrings().contextMenu;

    // add all suggestions
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    // allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: t.addToDictionary,
          click: () =>
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
    }

    // add an option to toggle spellchecker
    menu.append(
      new MenuItem({
        label: t.toggleSpellcheck,
        click() {
          config.spellchecker = !config.spellchecker;
        },
      }),
    );

    // show menu if we've generated enough entries
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // Create display media request handler
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen", "window"], fetchWindowIcons: true })
        .then((sources) => {
          // Shortcut for linux wayland.
          //
          // This whole branch is now only exercised as a fallback: on
          // Wayland, world/screenShareAudio.ts's patched getDisplayMedia
          // does its own portal negotiation via the Rust capture addon
          // (world/screenShareCapture.ts) rather than calling through to
          // here, precisely to avoid Chromium's own capture pipeline (the
          // native memory leak this addon exists to route around -- see
          // native/screen-capture/SPIKE.md). This still runs -- and still
          // needs to work correctly -- when the addon isn't available
          // (not built for this platform/arch yet) or its portal
          // negotiation fails, so a screen share never just breaks.
          if (sources.length == 1) {
            const isWindow = isWayland && sources[0].id.startsWith("window:");
            resolveScreenShareAudioMode({
              isWindow,
              audioRequested: request.audioRequested,
            }).then(() => {
              // Electron's callback() validates `audio` strictly -- it
              // must be a WebFrameMain, "loopback"/"loopbackWithMute", or
              // the key must be absent entirely. An explicit `audio:
              // undefined` throws (`TypeError: audio must be a
              // WebFrameMain, "loopback" or "loopbackWithMute"`), so the
              // key can't just always be present with a possibly-undefined
              // value the way the rest of this file's object literals
              // usually work.
              //
              // No `audio` here for a Wayland window share (handled by
              // resolveScreenShareAudioMode's picker) or on Wayland
              // generally: on this Chromium build "loopback" is no
              // longer the documented Windows-only no-op -- it does a
              // real capture of the physical output device's monitor,
              // i.e. everything playing on the machine. That would run
              // *alongside* the per-app audio our own patch
              // (world/screenShareAudio.ts) stitches on afterwards,
              // doubling up into exactly the "other apps' audio /
              // hearing your own voice back" leak this mode exists to
              // avoid.
              callback(
                request.audioRequested && !isWayland
                  ? { video: sources[0], audio: "loopback" }
                  : { video: sources[0] },
              );
            });
            return;
          }
          let pickerResponded = false;
          const respondToPicker = (result: Parameters<typeof callback>[0]) => {
            if (pickerResponded) return;
            pickerResponded = true;
            clearTimeout(pickerTimeout);
            ipcMain.removeListener(
              "screenPickerCallback",
              onScreenPickerCallback,
            );
            callback(result);
          };
          const onScreenPickerCallback = (
            _: unknown,
            idx: number,
            audio: boolean,
          ) => {
            if (idx < 0 || idx > sources.length) {
              respondToPicker({});
            } else {
              respondToPicker(
                audio && !isWayland
                  ? // see the isWayland comment above -- avoid duplicating
                    // the renderer-side audio patch. `audio` must be
                    // omitted entirely (not `undefined`) when unset --
                    // Electron's callback() throws on an explicit
                    // `audio: undefined`.
                    { video: sources[idx], audio: "loopback" }
                  : { video: sources[idx] },
              );
            }
          };
          ipcMain.once("screenPickerCallback", onScreenPickerCallback);

          // Defensive backstop: `ipcMain.once` only unregisters itself
          // when "screenPickerCallback" actually fires. If the picker is
          // ever dismissed in a way that doesn't send it, that listener
          // -- and everything it closes over, including `sources` (which
          // can carry sizeable window-thumbnail image data) and the
          // pending `callback` -- would otherwise stay registered on the
          // module-global ipcMain forever. Time it out instead.
          const pickerTimeout = setTimeout(
            () => respondToPicker({}),
            5 * 60 * 1000,
          );
          mainWindow.webContents.send(
            "screenPicker",
            sources.map((source, idx) => {
              const image = source.appIcon;
              if (image) {
                if (image.getAspectRatio() > 1) {
                  image.resize({ width: 256 });
                } else {
                  image.resize({ height: 256 });
                }
              }
              return {
                idx: idx,
                name: source.name,
                isFullScreen: source.id.startsWith("screen"),
                image: image?.toDataURL(),
              };
            }),
          );
        });
    },
    { useSystemPicker: true },
  );

  // Renderer's own portal negotiation (world/screenShareCapture.ts) picked
  // the source; it only knows whether that source was a window, not what
  // apps are running -- ask this process to make the same audio-routing
  // decision the fallback branch above makes when Chromium/desktopCapturer
  // picked the source instead.
  ipcMain.handle(
    "screenShareSourcePicked",
    (_event, opts: { isWindow: boolean }) =>
      resolveScreenShareAudioMode({
        isWindow: opts.isWindow,
        audioRequested: true,
      }),
  );

  // push world events to the window
  ipcMain.on("minimise", () => mainWindow.minimize());
  ipcMain.on("maximise", () =>
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(),
  );
  ipcMain.on("close", () => mainWindow.close());

  if (app.commandLine.hasSwitch("debug")) {
    mainWindow.webContents.openDevTools();
  }

  // let i = 0;
  // setInterval(() => setBadgeCount((++i % 30) + 1), 1000);
}

/**
 * Quit the entire app
 */
export function quitApp() {
  shouldQuit = true;
  mainWindow.close();
}

// Ensure global app quit works properly
app.on("before-quit", () => {
  shouldQuit = true;
});
