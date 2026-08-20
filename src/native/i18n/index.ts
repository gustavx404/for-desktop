import { getLanguage } from "./locale";
import { ar } from "./locales/ar";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { nl } from "./locales/nl";
import { pt } from "./locales/pt";
import { ru } from "./locales/ru";
import { zh } from "./locales/zh";
import type { Strings } from "./types";

export type { Strings } from "./types";

const dictionaries: Record<string, Strings> = {
  en,
  pt,
  es,
  fr,
  de,
  it,
  nl,
  ru,
  ja,
  zh,
  ko,
  ar,
};

/**
 * All of this app's own UI strings (tray menu, server picker,
 * notifications, Discord Rich Presence, spellcheck context menu,
 * accessibility labels) for the current system locale. Falls back to
 * English for locales without a dictionary yet.
 */
export function getStrings(): Strings {
  return dictionaries[getLanguage()] ?? en;
}
