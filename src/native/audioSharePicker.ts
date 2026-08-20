import type { Strings } from "./i18n";

/**
 * A curated subset of the app's live MDUI (Material Design 3) design
 * tokens -- colors, typography, and shape -- read from the main
 * window's own computed styles right before showing the picker (see
 * getThemeTokens() in window.ts). Color values are "R,G,B" triples --
 * MDUI's own convention, letting rgb(var(--x)) pull them in directly.
 * Falls back to a fixed dark palette (this object's values) when the
 * read fails, e.g. before the app has finished loading.
 */
export type PickerTheme = Record<keyof typeof FALLBACK_THEME, string>;

const FALLBACK_THEME = {
  surfaceContainer: "36,36,36",
  surfaceContainerHigh: "45,45,45",
  onSurface: "242,242,242",
  onSurfaceVariant: "167,167,167",
  outlineVariant: "58,58,58",
  primary: "255,138,135",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  titleSize: "13px",
  titleWeight: "600",
  bodySize: "13.5px",
  bodyWeight: "400",
  labelSmallSize: "12.5px",
  cornerLarge: "12px",
  cornerMedium: "8px",
  elevation: "none",
};

/**
 * In-app replacement for the native OS context menu previously used to
 * pick which app's audio to include in a window share (see window.ts).
 * A native `Menu` looks and behaves like whatever the OS/desktop
 * environment renders context menus as -- different font, no branding,
 * fixed system colors regardless of the app's own theme -- which reads
 * as disconnected from the rest of the app. This mirrors the same
 * `data:` HTML approach as serverPicker.ts, just shown in a small
 * popup window instead of taking over the main window's content, and
 * pulls in the app's actual MDUI color tokens so it matches whatever
 * theme/scheme the user has picked in settings, light or dark.
 */
export function buildAudioSharePickerHtml({
  apps,
  strings,
  theme,
}: {
  apps: string[];
  strings: Strings["screenShareAudio"];
  theme?: Partial<PickerTheme> | null;
}) {
  const t = strings;
  const c: PickerTheme = { ...FALLBACK_THEME, ...theme };
  const appRows = apps
    .map(
      (appName) => /* html */ `
        <button class="row" type="button" data-mode="app" data-app-name="${escapeHtml(appName)}">
          <span class="dot app-dot"></span>
          <span class="row-label">${escapeHtml(appName)}</span>
        </button>`,
    )
    .join("");

  return /* html */ `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Stoat</title>
    <style>
      :root {
        --surface-container: ${c.surfaceContainer};
        --surface-container-high: ${c.surfaceContainerHigh};
        --on-surface: ${c.onSurface};
        --on-surface-variant: ${c.onSurfaceVariant};
        --outline-variant: ${c.outlineVariant};
        --primary: ${c.primary};
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        height: 100%;
        margin: 0;
        overflow: hidden;
      }

      body {
        display: flex;
        flex-direction: column;
        background: rgb(var(--surface-container));
        color: rgb(var(--on-surface));
        font-family: ${c.fontFamily};
        -webkit-user-select: none;
        user-select: none;
        border: 1px solid rgba(var(--outline-variant), 0.6);
        border-radius: ${c.cornerLarge};
        box-shadow: ${c.elevation};
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 8px 10px 16px;
        font-size: ${c.titleSize};
        font-weight: ${c.titleWeight};
        color: rgb(var(--on-surface));
        flex-shrink: 0;
      }

      .close {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex-shrink: 0;
        background: transparent;
        border: none;
        border-radius: 50%;
        color: rgb(var(--on-surface-variant));
        cursor: pointer;
      }

      .close:hover,
      .close:focus-visible {
        background: rgb(var(--surface-container-high));
        outline: none;
      }

      .close svg {
        width: 14px;
        height: 14px;
      }

      .list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .empty {
        padding: 10px 8px;
        font-size: ${c.labelSmallSize};
        color: rgb(var(--on-surface-variant));
        text-align: center;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        background: transparent;
        border: none;
        border-radius: ${c.cornerMedium};
        color: rgb(var(--on-surface));
        font: inherit;
        font-size: ${c.bodySize};
        font-weight: ${c.bodyWeight};
        text-align: left;
        padding: 9px 10px;
        cursor: pointer;
      }

      .row:hover,
      .row:focus-visible {
        background: rgb(var(--surface-container-high));
        outline: none;
      }

      .row-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
        background: rgb(var(--primary));
      }

      .all-dot,
      .none-dot {
        background: rgb(var(--on-surface-variant));
      }

      .divider {
        height: 1px;
        background: rgb(var(--outline-variant));
        margin: 6px 8px;
        flex-shrink: 0;
      }

      footer {
        padding: 6px 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex-shrink: 0;
      }
    </style>
  </head>
  <body>
    <header>
      <span>${escapeHtml(t.title)}</span>
      <button class="close" type="button" id="close-btn" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </header>
    <div class="list">
      ${
        apps.length > 0
          ? appRows
          : `<div class="empty">${escapeHtml(t.nothingPlaying)}</div>`
      }
    </div>
    <div class="divider"></div>
    <footer>
      <button class="row" type="button" data-mode="all">
        <span class="dot all-dot"></span>
        <span class="row-label">${escapeHtml(t.allSystemAudio)}</span>
      </button>
      <button class="row" type="button" data-mode="none">
        <span class="dot none-dot"></span>
        <span class="row-label">${escapeHtml(t.noAudio)}</span>
      </button>
    </footer>

    <script>
      (function () {
        document.querySelectorAll(".row").forEach((el) => {
          el.addEventListener("click", () => {
            const mode = el.dataset.mode;
            if (mode === "app") {
              window.native.audioSharePickerCallback({
                type: "app",
                appName: el.dataset.appName,
              });
            } else {
              window.native.audioSharePickerCallback({ type: mode });
            }
          });
        });

        // Esc and the close button both mirror clicking away from a
        // native menu: close without an explicit choice, letting the
        // main process apply its default.
        document
          .getElementById("close-btn")
          .addEventListener("click", () => window.close());
        window.addEventListener("keydown", (event) => {
          if (event.key === "Escape") window.close();
        });
      })();
    </script>
  </body>
</html>`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
