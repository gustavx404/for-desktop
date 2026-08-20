import type { Strings } from "../types";

export const nl: Strings = {
  tray: {
    version: "Versie",
    server: "Server",
    officialServer: "Officiële Server",
    other: (host) => `(anders) ${host}`,
    changeServer: "Server Wijzigen...",
    showApp: "App Tonen",
    hideApp: "App Verbergen",
    quitApp: "App Afsluiten",
  },
  picker: {
    signInToContinue: "Log in om door te gaan.",
    connectionError:
      "Kan geen verbinding maken. Controleer het serveradres en je verbinding, probeer het daarna opnieuw.",
    continueLabel: "Doorgaan",
    loggingInOn: "Inloggen bij",
    change: "Wijzigen",
    selfHostedEnvironment: "Self-hosted omgeving",
    serverUrlLabel: "Server-URL",
    invalidUrl: "Voer een geldige server-URL in, inclusief https://",
    cancel: "Annuleren",
    save: "Opslaan",
    useOfficialServer: "Officiële server gebruiken (stoat.chat)",
    connecting: "Verbinden...",
  },
  notifications: {
    updateAvailableTitle: "Update beschikbaar",
    updateAvailableBody: "Herstart de app om de update te installeren.",
  },
  discordRpc: {
    details: "Chat met anderen",
    largeImageText: "Doe mee met Stoat!",
    joinButton: "Doe mee met Stoat",
  },
  contextMenu: {
    addToDictionary: "Toevoegen aan woordenboek",
    toggleSpellcheck: "Spellingcontrole in-/uitschakelen",
  },
  accessibility: {
    noNotifications: "Geen meldingen",
    unreadMessages: "Ongelezen berichten",
    notificationsCount: (count) => `${count} meldingen`,
  },
  screenShareAudio: {
    title: "Audio van welke app delen?",
    nothingPlaying: "(er speelt nu geen geluid)",
    allSystemAudio: "Alle systeemaudio",
    noAudio: "Geen audio",
  },
};
