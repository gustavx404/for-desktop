import type { Strings } from "../types";

export const ja: Strings = {
  tray: {
    version: "バージョン",
    server: "サーバー",
    officialServer: "公式サーバー",
    other: (host) => `(その他) ${host}`,
    changeServer: "サーバーを変更...",
    showApp: "アプリを表示",
    hideApp: "アプリを隠す",
    quitApp: "アプリを終了",
  },
  picker: {
    signInToContinue: "続けるにはサインインしてください。",
    connectionError:
      "接続できませんでした。サーバーアドレスと接続を確認して、もう一度お試しください。",
    continueLabel: "続ける",
    loggingInOn: "ログイン先",
    change: "変更",
    selfHostedEnvironment: "セルフホスト環境",
    serverUrlLabel: "サーバーURL",
    invalidUrl: "https:// を含む有効なサーバーURLを入力してください",
    cancel: "キャンセル",
    save: "保存",
    useOfficialServer: "公式サーバーを使う (stoat.chat)",
    connecting: "接続中...",
  },
  notifications: {
    updateAvailableTitle: "アップデートがあります",
    updateAvailableBody:
      "アプリを再起動してアップデートをインストールしてください。",
  },
  discordRpc: {
    details: "他の人とチャット中",
    largeImageText: "Stoatに参加しよう！",
    joinButton: "Stoatに参加",
  },
  contextMenu: {
    addToDictionary: "辞書に追加",
    toggleSpellcheck: "スペルチェックの切り替え",
  },
  accessibility: {
    noNotifications: "通知なし",
    unreadMessages: "未読メッセージ",
    notificationsCount: (count) => `${count}件の通知`,
  },
  screenShareAudio: {
    title: "どのアプリの音声を共有しますか？",
    nothingPlaying: "(現在音声を再生しているものはありません)",
    allSystemAudio: "システム全体の音声",
    noAudio: "音声なし",
  },
};
