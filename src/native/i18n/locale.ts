import { app } from "electron";

/**
 * Primary language subtag for the current system locale (e.g. "pt" for
 * "pt-BR"), used to pick UI string dictionaries across the app's own
 * screens (tray menu, server picker, notifications, ...). This is a
 * stable, deterministic signal -- unlike the remote server's own display
 * language, which has no persisted preference and can vary between loads
 * for reasons outside this app's control.
 */
export function getLanguage(): string {
  return app.getLocale().split("-")[0].toLowerCase();
}
