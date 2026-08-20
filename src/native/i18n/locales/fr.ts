import type { Strings } from "../types";

export const fr: Strings = {
  tray: {
    version: "Version",
    server: "Serveur",
    officialServer: "Serveur Officiel",
    other: (host) => `(autre) ${host}`,
    changeServer: "Changer de Serveur...",
    showApp: "Afficher l'App",
    hideApp: "Masquer l'App",
    quitApp: "Quitter l'App",
  },
  picker: {
    signInToContinue: "Connectez-vous pour continuer.",
    connectionError:
      "Connexion impossible. Vérifiez l'adresse du serveur et votre connexion, puis réessayez.",
    continueLabel: "Continuer",
    loggingInOn: "Connexion à",
    change: "Changer",
    selfHostedEnvironment: "Environnement auto-hébergé",
    serverUrlLabel: "URL du serveur",
    invalidUrl: "Entrez une URL de serveur valide, avec https://",
    cancel: "Annuler",
    save: "Enregistrer",
    useOfficialServer: "Utiliser le serveur officiel (stoat.chat)",
    connecting: "Connexion...",
  },
  notifications: {
    updateAvailableTitle: "Mise à jour disponible",
    updateAvailableBody: "Redémarrez l'app pour installer la mise à jour.",
  },
  discordRpc: {
    details: "Discute avec d'autres personnes",
    largeImageText: "Rejoignez Stoat !",
    joinButton: "Rejoindre Stoat",
  },
  contextMenu: {
    addToDictionary: "Ajouter au dictionnaire",
    toggleSpellcheck: "Activer/désactiver le correcteur orthographique",
  },
  accessibility: {
    noNotifications: "Aucune notification",
    unreadMessages: "Messages non lus",
    notificationsCount: (count) => `${count} notifications`,
  },
  screenShareAudio: {
    title: "Audio de quelle application partager ?",
    nothingPlaying: "(rien ne joue de son actuellement)",
    allSystemAudio: "Tout l'audio du système",
    noAudio: "Aucun audio",
  },
};
