import type { Strings } from "../types";

export const ko: Strings = {
  tray: {
    version: "버전",
    server: "서버",
    officialServer: "공식 서버",
    other: (host) => `(기타) ${host}`,
    changeServer: "서버 변경...",
    showApp: "앱 표시",
    hideApp: "앱 숨기기",
    quitApp: "앱 종료",
  },
  picker: {
    signInToContinue: "계속하려면 로그인하세요.",
    connectionError:
      "연결할 수 없습니다. 서버 주소와 연결을 확인한 후 다시 시도하세요.",
    continueLabel: "계속",
    loggingInOn: "로그인 중",
    change: "변경",
    selfHostedEnvironment: "셀프 호스팅 환경",
    serverUrlLabel: "서버 URL",
    invalidUrl: "https://를 포함한 유효한 서버 URL을 입력하세요",
    cancel: "취소",
    save: "저장",
    useOfficialServer: "공식 서버 사용 (stoat.chat)",
    connecting: "연결 중...",
  },
  notifications: {
    updateAvailableTitle: "업데이트 가능",
    updateAvailableBody: "업데이트를 설치하려면 앱을 재시작하세요.",
  },
  discordRpc: {
    details: "다른 사람들과 채팅 중",
    largeImageText: "Stoat에 참여하세요!",
    joinButton: "Stoat 참여하기",
  },
  contextMenu: {
    addToDictionary: "사전에 추가",
    toggleSpellcheck: "맞춤법 검사 전환",
  },
  accessibility: {
    noNotifications: "알림 없음",
    unreadMessages: "읽지 않은 메시지",
    notificationsCount: (count) => `알림 ${count}개`,
  },
  screenShareAudio: {
    title: "어떤 앱의 오디오를 공유할까요?",
    nothingPlaying: "(현재 재생 중인 오디오 없음)",
    allSystemAudio: "전체 시스템 오디오",
    noAudio: "오디오 없음",
  },
};
