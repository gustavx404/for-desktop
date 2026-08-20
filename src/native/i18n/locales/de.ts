import type { Strings } from "../types";

export const de: Strings = {
  tray: {
    version: "Version",
    server: "Server",
    officialServer: "Offizieller Server",
    other: (host) => `(andere) ${host}`,
    changeServer: "Server wechseln...",
    showApp: "App anzeigen",
    hideApp: "App ausblenden",
    quitApp: "App beenden",
  },
  picker: {
    signInToContinue: "Melde dich an, um fortzufahren.",
    connectionError:
      "Verbindung fehlgeschlagen. Überprüfe die Serveradresse und deine Verbindung und versuche es erneut.",
    continueLabel: "Weiter",
    loggingInOn: "Anmeldung bei",
    change: "Ändern",
    selfHostedEnvironment: "Selbst gehostete Umgebung",
    serverUrlLabel: "Server-URL",
    invalidUrl: "Gib eine gültige Server-URL ein, inklusive https://",
    cancel: "Abbrechen",
    save: "Speichern",
    useOfficialServer: "Offiziellen Server verwenden (stoat.chat)",
    connecting: "Verbindung wird hergestellt...",
  },
  notifications: {
    updateAvailableTitle: "Update verfügbar",
    updateAvailableBody: "Starte die App neu, um das Update zu installieren.",
  },
  discordRpc: {
    details: "Chattet mit anderen",
    largeImageText: "Tritt Stoat bei!",
    joinButton: "Stoat beitreten",
  },
  contextMenu: {
    addToDictionary: "Zum Wörterbuch hinzufügen",
    toggleSpellcheck: "Rechtschreibprüfung umschalten",
  },
  accessibility: {
    noNotifications: "Keine Benachrichtigungen",
    unreadMessages: "Ungelesene Nachrichten",
    notificationsCount: (count) => `${count} Benachrichtigungen`,
  },
  screenShareAudio: {
    title: "Audio welcher App teilen?",
    nothingPlaying: "(gerade läuft kein Ton)",
    allSystemAudio: "Gesamter Systemton",
    noAudio: "Kein Audio",
  },
};
