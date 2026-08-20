import type { Strings } from "../types";

export const en: Strings = {
  tray: {
    version: "Version",
    server: "Server",
    officialServer: "Official Server",
    other: (host) => `(other) ${host}`,
    changeServer: "Change Server...",
    showApp: "Show App",
    hideApp: "Hide App",
    quitApp: "Quit App",
  },
  picker: {
    signInToContinue: "Sign in to continue.",
    connectionError:
      "Couldn't connect. Check the server address and your connection, then try again.",
    continueLabel: "Continue",
    loggingInOn: "Logging in on",
    change: "Change",
    selfHostedEnvironment: "Self-hosted environment",
    serverUrlLabel: "Server URL",
    invalidUrl: "Enter a valid server URL, including https://",
    cancel: "Cancel",
    save: "Save",
    useOfficialServer: "Use official server (stoat.chat)",
    connecting: "Connecting...",
  },
  notifications: {
    updateAvailableTitle: "Update Available",
    updateAvailableBody: "Restart the app to install the update.",
  },
  discordRpc: {
    details: "Chatting with others",
    largeImageText: "Join Stoat!",
    joinButton: "Join Stoat",
  },
  contextMenu: {
    addToDictionary: "Add to dictionary",
    toggleSpellcheck: "Toggle spellcheck",
  },
  accessibility: {
    noNotifications: "No Notifications",
    unreadMessages: "Unread Messages",
    notificationsCount: (count) => `${count} Notifications`,
  },
  screenShareAudio: {
    title: "Which app's audio to share?",
    nothingPlaying: "(nothing playing audio right now)",
    allSystemAudio: "All system audio",
    noAudio: "No audio",
  },
};
