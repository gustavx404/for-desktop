import type { Strings } from "../types";

export const ru: Strings = {
  tray: {
    version: "Версия",
    server: "Сервер",
    officialServer: "Официальный сервер",
    other: (host) => `(другой) ${host}`,
    changeServer: "Сменить сервер...",
    showApp: "Показать приложение",
    hideApp: "Скрыть приложение",
    quitApp: "Выйти из приложения",
  },
  picker: {
    signInToContinue: "Войдите, чтобы продолжить.",
    connectionError:
      "Не удалось подключиться. Проверьте адрес сервера и подключение, затем попробуйте снова.",
    continueLabel: "Продолжить",
    loggingInOn: "Вход на",
    change: "Изменить",
    selfHostedEnvironment: "Собственный сервер",
    serverUrlLabel: "URL сервера",
    invalidUrl: "Введите корректный URL сервера, включая https://",
    cancel: "Отмена",
    save: "Сохранить",
    useOfficialServer: "Использовать официальный сервер (stoat.chat)",
    connecting: "Подключение...",
  },
  notifications: {
    updateAvailableTitle: "Доступно обновление",
    updateAvailableBody:
      "Перезапустите приложение, чтобы установить обновление.",
  },
  discordRpc: {
    details: "Общается с другими",
    largeImageText: "Присоединяйтесь к Stoat!",
    joinButton: "Присоединиться к Stoat",
  },
  contextMenu: {
    addToDictionary: "Добавить в словарь",
    toggleSpellcheck: "Вкл./выкл. проверку орфографии",
  },
  accessibility: {
    noNotifications: "Нет уведомлений",
    unreadMessages: "Непрочитанные сообщения",
    notificationsCount: (count) => `${count} уведомлений`,
  },
  screenShareAudio: {
    title: "Звук какого приложения передавать?",
    nothingPlaying: "(сейчас ничего не воспроизводит звук)",
    allSystemAudio: "Весь системный звук",
    noAudio: "Без звука",
  },
};
