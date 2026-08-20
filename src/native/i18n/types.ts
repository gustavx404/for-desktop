export type Strings = {
  tray: {
    version: string;
    server: string;
    officialServer: string;
    other: (host: string) => string;
    changeServer: string;
    showApp: string;
    hideApp: string;
    quitApp: string;
  };
  picker: {
    signInToContinue: string;
    connectionError: string;
    continueLabel: string;
    loggingInOn: string;
    change: string;
    selfHostedEnvironment: string;
    serverUrlLabel: string;
    invalidUrl: string;
    cancel: string;
    save: string;
    useOfficialServer: string;
    connecting: string;
  };
  notifications: {
    updateAvailableTitle: string;
    updateAvailableBody: string;
  };
  discordRpc: {
    details: string;
    largeImageText: string;
    joinButton: string;
  };
  contextMenu: {
    addToDictionary: string;
    toggleSpellcheck: string;
  };
  accessibility: {
    noNotifications: string;
    unreadMessages: string;
    notificationsCount: (count: number) => string;
  };
  screenShareAudio: {
    title: string;
    nothingPlaying: string;
    allSystemAudio: string;
    noAudio: string;
  };
};
