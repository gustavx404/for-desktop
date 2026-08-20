import type { Strings } from "./i18n";

/**
 * Bitwarden-style landing screen shown before the app connects to a server.
 * Opens straight on a "Continue" (login) view for the current server, with
 * a small server switcher underneath — mirroring Bitwarden's own region
 * picker. Rendered as an inline `data:` document inside the main window,
 * so it can use the same preload bridge (`window.native`) as the remote app.
 */
export function buildServerPickerHtml({
  defaultServerUrl,
  savedServerUrl,
  favoriteServerUrl = "",
  connectionError = false,
  strings,
}: {
  defaultServerUrl: string;
  savedServerUrl: string;
  favoriteServerUrl?: string;
  connectionError?: boolean;
  strings: Strings["picker"];
}) {
  const t = strings;
  return /* html */ `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Stoat</title>
    <style>
      :root {
        color-scheme: dark;
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        height: 100%;
        margin: 0;
      }

      body {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #191919;
        color: #f2f2f2;
        font-family:
          -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
          Arial, sans-serif;
        -webkit-user-select: none;
        user-select: none;
      }

      .card {
        width: 360px;
        display: flex;
        flex-direction: column;
        align-items: stretch;
      }

      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        margin-bottom: 32px;
      }

      .brand .mark {
        width: 56px;
        height: 56px;
        border-radius: 16px;
        background: #ff4655;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 28px;
        font-weight: 700;
      }

      .brand h1 {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
      }

      .brand p {
        margin: 0;
        font-size: 13px;
        color: #9a9a9a;
        text-align: center;
      }

      button {
        font: inherit;
        border: none;
        cursor: pointer;
      }

      .primary {
        width: 100%;
        background: #ff4655;
        color: #fff;
        border-radius: 8px;
        padding: 12px 16px;
        font-size: 14px;
        font-weight: 600;
      }

      .primary:hover {
        filter: brightness(1.08);
      }

      .primary.small {
        padding: 9px 14px;
        font-size: 13px;
      }

      .link {
        background: transparent;
        color: #9a9a9a;
        font-size: 13px;
        padding: 4px;
      }

      .link:hover {
        color: #f2f2f2;
      }

      /* server row shown below the continue button, Bitwarden-style */
      .server-row {
        margin-top: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        background: transparent;
        color: #9a9a9a;
        font-size: 12.5px;
        padding: 6px;
        border-radius: 6px;
      }

      .server-row:hover {
        color: #f2f2f2;
        background: #232323;
      }

      .server-row .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #4fd177;
        flex-shrink: 0;
      }

      .server-row .host {
        color: #ddd;
        font-weight: 500;
      }

      .server-row .change {
        margin-left: 2px;
        color: #ff8087;
        text-decoration: underline;
        text-underline-offset: 2px;
      }

      .server-row:hover .change {
        color: #ff4655;
      }

      #login-view.hidden,
      #settings-view.hidden {
        display: none;
      }

      #settings-view {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      #settings-view h2 {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
        text-align: center;
      }

      label {
        font-size: 12px;
        color: #9a9a9a;
        display: block;
        margin-bottom: 6px;
      }

      input {
        font: inherit;
        width: 100%;
        background: #242424;
        border: 1px solid #3a3a3a;
        border-radius: 8px;
        color: #f2f2f2;
        padding: 10px 12px;
        font-size: 14px;
        -webkit-user-select: text;
        user-select: text;
      }

      input:focus {
        outline: none;
        border-color: #ff4655;
      }

      .error {
        display: none;
        font-size: 12px;
        color: #ff8a8a;
        margin-top: 6px;
      }

      .error.visible {
        display: block;
      }

      .settings-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .settings-footer {
        display: flex;
        justify-content: center;
      }

      .connection-error {
        display: none;
        background: rgba(255, 70, 85, 0.12);
        border: 1px solid rgba(255, 70, 85, 0.35);
        color: #ff8a8a;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 12.5px;
        margin-bottom: 14px;
        text-align: center;
      }

      .connection-error.visible {
        display: block;
      }

      button:disabled {
        opacity: 0.7;
        cursor: default;
      }

      .spinner {
        display: inline-block;
        width: 13px;
        height: 13px;
        margin-right: 7px;
        vertical-align: -2px;
        border: 2px solid rgba(255, 255, 255, 0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="brand">
        <div class="mark">S</div>
        <h1>Stoat</h1>
        <p>${t.signInToContinue}</p>
      </div>

      <div id="login-view">
        <p class="connection-error${connectionError ? " visible" : ""}">
          ${t.connectionError}
        </p>
        <button class="primary" id="continue" type="button">
          ${t.continueLabel}
        </button>
        <button class="server-row" id="open-settings" type="button">
          <span class="dot"></span>
          ${t.loggingInOn} <span class="host" id="current-host"></span>
          <span class="change">${t.change}</span>
        </button>
      </div>

      <div id="settings-view" class="hidden">
        <h2>${t.selfHostedEnvironment}</h2>
        <div>
          <label for="server-url">${t.serverUrlLabel}</label>
          <input
            id="server-url"
            type="text"
            placeholder="https://your-server.example.com/app"
            autocomplete="off"
            spellcheck="false"
          />
          <p class="error" id="server-url-error">
            ${t.invalidUrl}
          </p>
        </div>
        <div class="settings-actions">
          <button class="link" id="cancel-settings" type="button">
            ${t.cancel}
          </button>
          <button class="primary small" id="save-settings" type="button">
            ${t.save}
          </button>
        </div>
        <div class="settings-footer">
          <button class="link" id="use-official" type="button">
            ${t.useOfficialServer}
          </button>
        </div>
      </div>
    </div>

    <script>
      (function () {
        const DEFAULT_SERVER_URL = ${JSON.stringify(defaultServerUrl)};
        const SAVED_SERVER_URL = ${JSON.stringify(savedServerUrl)};
        const FAVORITE_SERVER_URL = ${JSON.stringify(favoriteServerUrl)};
        const CONNECTING_TEXT = ${JSON.stringify(t.connecting)};

        let effectiveServerUrl = SAVED_SERVER_URL || DEFAULT_SERVER_URL;

        const loginView = document.getElementById("login-view");
        const settingsView = document.getElementById("settings-view");
        const currentHost = document.getElementById("current-host");
        const input = document.getElementById("server-url");
        const error = document.getElementById("server-url-error");
        const continueBtn = document.getElementById("continue");
        const openSettingsBtn = document.getElementById("open-settings");
        const cancelBtn = document.getElementById("cancel-settings");
        const saveBtn = document.getElementById("save-settings");
        const useOfficialBtn = document.getElementById("use-official");

        function normalize(value) {
          // strip invisible/format characters some apps append after
          // links (e.g. a zero-width space used to allow line wrapping)
          value = value
            .replace(/[\\u200B\\u200C\\u200D\\u2060\\uFEFF]/g, "")
            .trim();
          if (value && !/^https?:\\/\\//i.test(value)) {
            value = "https://" + value;
          }
          return value;
        }

        function renderCurrentHost() {
          currentHost.textContent = new URL(effectiveServerUrl).host;
        }

        renderCurrentHost();

        continueBtn.addEventListener("click", () => {
          connect(effectiveServerUrl, continueBtn);
        });

        openSettingsBtn.addEventListener("click", () => {
          // prefer the saved self-hosted favourite, so it stays put in
          // the field even after switching to the official server
          input.value =
            FAVORITE_SERVER_URL ||
            (effectiveServerUrl === DEFAULT_SERVER_URL
              ? ""
              : effectiveServerUrl);
          error.classList.remove("visible");
          loginView.classList.add("hidden");
          settingsView.classList.remove("hidden");
          input.focus();
        });

        cancelBtn.addEventListener("click", () => {
          settingsView.classList.add("hidden");
          loginView.classList.remove("hidden");
        });

        function validateUrl(rawValue) {
          const value = normalize(rawValue);

          try {
            new URL(value);
          } catch {
            error.classList.add("visible");
            return null;
          }

          error.classList.remove("visible");
          return value;
        }

        // give immediate feedback on click -- connecting can take a few
        // seconds (self-hosted servers especially), and a button that just
        // sits there with no reaction reads as broken/frozen
        function showConnecting(triggerButton) {
          [
            continueBtn,
            openSettingsBtn,
            cancelBtn,
            saveBtn,
            useOfficialBtn,
            input,
          ].forEach((el) => {
            el.disabled = true;
          });
          if (triggerButton) {
            triggerButton.innerHTML =
              '<span class="spinner"></span>' + CONNECTING_TEXT;
          }
        }

        function connect(value, triggerButton) {
          effectiveServerUrl = value;
          showConnecting(triggerButton);
          window.native.selectServer(value);
        }

        function connectFromInput(triggerButton) {
          const value = validateUrl(input.value);
          if (value) {
            connect(value, triggerButton);
          }
        }

        saveBtn.addEventListener("click", () => connectFromInput(saveBtn));

        useOfficialBtn.addEventListener("click", () =>
          connect(DEFAULT_SERVER_URL, useOfficialBtn),
        );

        // paste a server URL and hit Enter to connect right away, no need
        // to click Save afterwards
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            connectFromInput(saveBtn);
          }
        });

        // clear a stale validation error as soon as the user edits the
        // field again (typing or pasting a new value)
        input.addEventListener("input", () => {
          error.classList.remove("visible");
        });
      })();
    </script>
  </body>
</html>`;
}
