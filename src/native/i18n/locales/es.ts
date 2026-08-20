import type { Strings } from "../types";

export const es: Strings = {
  tray: {
    version: "Versión",
    server: "Servidor",
    officialServer: "Servidor Oficial",
    other: (host) => `(otro) ${host}`,
    changeServer: "Cambiar Servidor...",
    showApp: "Mostrar App",
    hideApp: "Ocultar App",
    quitApp: "Salir de la App",
  },
  picker: {
    signInToContinue: "Inicia sesión para continuar.",
    connectionError:
      "No se pudo conectar. Verifica la dirección del servidor y tu conexión, luego intenta de nuevo.",
    continueLabel: "Continuar",
    loggingInOn: "Iniciando sesión en",
    change: "Cambiar",
    selfHostedEnvironment: "Entorno autoalojado",
    serverUrlLabel: "URL del servidor",
    invalidUrl: "Ingresa una URL de servidor válida, incluyendo https://",
    cancel: "Cancelar",
    save: "Guardar",
    useOfficialServer: "Usar servidor oficial (stoat.chat)",
    connecting: "Conectando...",
  },
  notifications: {
    updateAvailableTitle: "Actualización Disponible",
    updateAvailableBody: "Reinicia la app para instalar la actualización.",
  },
  discordRpc: {
    details: "Chateando con otros",
    largeImageText: "¡Únete a Stoat!",
    joinButton: "Únete a Stoat",
  },
  contextMenu: {
    addToDictionary: "Añadir al diccionario",
    toggleSpellcheck: "Activar/desactivar corrector ortográfico",
  },
  accessibility: {
    noNotifications: "Sin notificaciones",
    unreadMessages: "Mensajes no leídos",
    notificationsCount: (count) => `${count} notificaciones`,
  },
  screenShareAudio: {
    title: "¿Audio de qué app compartir?",
    nothingPlaying: "(nada reproduciendo audio ahora)",
    allSystemAudio: "Audio general del sistema",
    noAudio: "Sin audio",
  },
};
