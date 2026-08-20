import type { Strings } from "../types";

export const pt: Strings = {
  tray: {
    version: "Versão",
    server: "Servidor",
    officialServer: "Servidor Oficial",
    other: (host) => `(outro) ${host}`,
    changeServer: "Trocar Servidor...",
    showApp: "Mostrar App",
    hideApp: "Ocultar App",
    quitApp: "Sair do App",
  },
  picker: {
    signInToContinue: "Entre para continuar.",
    connectionError:
      "Não foi possível conectar. Verifique o endereço do servidor e sua conexão, depois tente novamente.",
    continueLabel: "Continuar",
    loggingInOn: "Entrando em",
    change: "Trocar",
    selfHostedEnvironment: "Ambiente self-hosted",
    serverUrlLabel: "URL do servidor",
    invalidUrl: "Digite uma URL de servidor válida, incluindo https://",
    cancel: "Cancelar",
    save: "Salvar",
    useOfficialServer: "Usar servidor oficial (stoat.chat)",
    connecting: "Conectando...",
  },
  notifications: {
    updateAvailableTitle: "Atualização Disponível",
    updateAvailableBody: "Reinicie o app para instalar a atualização.",
  },
  discordRpc: {
    details: "Conversando com outras pessoas",
    largeImageText: "Junte-se ao Stoat!",
    joinButton: "Junte-se ao Stoat",
  },
  contextMenu: {
    addToDictionary: "Adicionar ao dicionário",
    toggleSpellcheck: "Ativar/desativar corretor ortográfico",
  },
  accessibility: {
    noNotifications: "Sem notificações",
    unreadMessages: "Mensagens não lidas",
    notificationsCount: (count) => `${count} notificações`,
  },
  screenShareAudio: {
    title: "Áudio de qual app compartilhar?",
    nothingPlaying: "(nada tocando áudio agora)",
    allSystemAudio: "Áudio geral do sistema",
    noAudio: "Sem áudio",
  },
};
