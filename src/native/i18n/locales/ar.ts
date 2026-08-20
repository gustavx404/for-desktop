import type { Strings } from "../types";

export const ar: Strings = {
  tray: {
    version: "الإصدار",
    server: "الخادم",
    officialServer: "الخادم الرسمي",
    other: (host) => `(آخر) ${host}`,
    changeServer: "تغيير الخادم...",
    showApp: "إظهار التطبيق",
    hideApp: "إخفاء التطبيق",
    quitApp: "إنهاء التطبيق",
  },
  picker: {
    signInToContinue: "سجّل الدخول للمتابعة.",
    connectionError:
      "تعذّر الاتصال. تحقّق من عنوان الخادم واتصالك، ثم حاول مرة أخرى.",
    continueLabel: "متابعة",
    loggingInOn: "تسجيل الدخول إلى",
    change: "تغيير",
    selfHostedEnvironment: "بيئة مستضافة ذاتيًا",
    serverUrlLabel: "رابط الخادم",
    invalidUrl: "أدخل رابط خادم صالحًا يتضمن https://",
    cancel: "إلغاء",
    save: "حفظ",
    useOfficialServer: "استخدام الخادم الرسمي (stoat.chat)",
    connecting: "جارٍ الاتصال...",
  },
  notifications: {
    updateAvailableTitle: "تحديث متاح",
    updateAvailableBody: "أعد تشغيل التطبيق لتثبيت التحديث.",
  },
  discordRpc: {
    details: "يتحدث مع آخرين",
    largeImageText: "انضم إلى Stoat!",
    joinButton: "انضم إلى Stoat",
  },
  contextMenu: {
    addToDictionary: "إضافة إلى القاموس",
    toggleSpellcheck: "تبديل التدقيق الإملائي",
  },
  accessibility: {
    noNotifications: "لا إشعارات",
    unreadMessages: "رسائل غير مقروءة",
    notificationsCount: (count) => `${count} إشعارات`,
  },
  screenShareAudio: {
    title: "صوت أي تطبيق تريد مشاركته؟",
    nothingPlaying: "(لا يوجد صوت قيد التشغيل الآن)",
    allSystemAudio: "كل صوت النظام",
    noAudio: "بدون صوت",
  },
};
