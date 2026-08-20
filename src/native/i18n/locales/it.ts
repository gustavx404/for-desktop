import type { Strings } from "../types";

export const it: Strings = {
  tray: {
    version: "Versione",
    server: "Server",
    officialServer: "Server Ufficiale",
    other: (host) => `(altro) ${host}`,
    changeServer: "Cambia Server...",
    showApp: "Mostra App",
    hideApp: "Nascondi App",
    quitApp: "Esci dall'App",
  },
  picker: {
    signInToContinue: "Accedi per continuare.",
    connectionError:
      "Connessione non riuscita. Controlla l'indirizzo del server e la tua connessione, poi riprova.",
    continueLabel: "Continua",
    loggingInOn: "Accesso a",
    change: "Cambia",
    selfHostedEnvironment: "Ambiente self-hosted",
    serverUrlLabel: "URL del server",
    invalidUrl: "Inserisci un URL server valido, incluso https://",
    cancel: "Annulla",
    save: "Salva",
    useOfficialServer: "Usa server ufficiale (stoat.chat)",
    connecting: "Connessione in corso...",
  },
  notifications: {
    updateAvailableTitle: "Aggiornamento disponibile",
    updateAvailableBody: "Riavvia l'app per installare l'aggiornamento.",
  },
  discordRpc: {
    details: "Chatta con altri",
    largeImageText: "Unisciti a Stoat!",
    joinButton: "Unisciti a Stoat",
  },
  contextMenu: {
    addToDictionary: "Aggiungi al dizionario",
    toggleSpellcheck: "Attiva/disattiva controllo ortografico",
  },
  accessibility: {
    noNotifications: "Nessuna notifica",
    unreadMessages: "Messaggi non letti",
    notificationsCount: (count) => `${count} notifiche`,
  },
  screenShareAudio: {
    title: "Audio di quale app condividere?",
    nothingPlaying: "(nessun audio in riproduzione ora)",
    allSystemAudio: "Audio di sistema completo",
    noAudio: "Nessun audio",
  },
};
