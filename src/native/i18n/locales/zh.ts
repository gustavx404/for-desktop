import type { Strings } from "../types";

export const zh: Strings = {
  tray: {
    version: "版本",
    server: "服务器",
    officialServer: "官方服务器",
    other: (host) => `(其他) ${host}`,
    changeServer: "更改服务器...",
    showApp: "显示应用",
    hideApp: "隐藏应用",
    quitApp: "退出应用",
  },
  picker: {
    signInToContinue: "登录以继续。",
    connectionError: "无法连接。请检查服务器地址和网络连接，然后重试。",
    continueLabel: "继续",
    loggingInOn: "正在登录",
    change: "更改",
    selfHostedEnvironment: "自托管环境",
    serverUrlLabel: "服务器地址",
    invalidUrl: "请输入有效的服务器地址，包含 https://",
    cancel: "取消",
    save: "保存",
    useOfficialServer: "使用官方服务器 (stoat.chat)",
    connecting: "正在连接...",
  },
  notifications: {
    updateAvailableTitle: "有可用更新",
    updateAvailableBody: "重启应用以安装更新。",
  },
  discordRpc: {
    details: "正在与他人聊天",
    largeImageText: "加入 Stoat！",
    joinButton: "加入 Stoat",
  },
  contextMenu: {
    addToDictionary: "添加到词典",
    toggleSpellcheck: "切换拼写检查",
  },
  accessibility: {
    noNotifications: "没有通知",
    unreadMessages: "未读消息",
    notificationsCount: (count) => `${count} 条通知`,
  },
  screenShareAudio: {
    title: "共享哪个应用的音频？",
    nothingPlaying: "(当前没有应用在播放音频)",
    allSystemAudio: "全部系统音频",
    noAudio: "无音频",
  },
};
