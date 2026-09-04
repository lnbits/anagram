import type { App, ComputedRef, InjectionKey } from 'vue';
import { computed, inject, reactive } from 'vue';
import ar from './locales/ar.json';
import arEG from './locales/ar-EG.json';
import bnBD from './locales/bn-BD.json';
import deDE from './locales/de-DE.json';
import enUS from './locales/en-US.json';
import esES from './locales/es-ES.json';
import frFR from './locales/fr-FR.json';
import hiIN from './locales/hi-IN.json';
import idID from './locales/id-ID.json';
import jaJP from './locales/ja-JP.json';
import mrIN from './locales/mr-IN.json';
import pcmNG from './locales/pcm-NG.json';
import ptBR from './locales/pt-BR.json';
import ruRU from './locales/ru-RU.json';
import taIN from './locales/ta-IN.json';
import teIN from './locales/te-IN.json';
import trTR from './locales/tr-TR.json';
import urPK from './locales/ur-PK.json';
import yueHK from './locales/yue-HK.json';
import zhCN from './locales/zh-CN.json';

export type TranslationParams = Record<string, string | number | boolean | null | undefined>;
export type TranslationMessages = Record<string, string>;
export type TextDirection = 'ltr' | 'rtl';

export type LocaleCode =
  | 'ar'
  | 'ar-EG'
  | 'bn-BD'
  | 'de-DE'
  | 'en-US'
  | 'es-ES'
  | 'fr-FR'
  | 'hi-IN'
  | 'id-ID'
  | 'ja-JP'
  | 'mr-IN'
  | 'pcm-NG'
  | 'pt-BR'
  | 'ru-RU'
  | 'ta-IN'
  | 'te-IN'
  | 'tr-TR'
  | 'ur-PK'
  | 'yue-HK'
  | 'zh-CN';

export interface LanguageOption {
  code: LocaleCode;
  englishName: string;
  nativeName: string;
  intlLocale: string;
  direction: TextDirection;
}

interface I18nState {
  locale: LocaleCode;
}

export interface I18nApi {
  locale: ComputedRef<LocaleCode>;
  language: ComputedRef<LanguageOption>;
  languages: readonly LanguageOption[];
  setLocale: (locale: LocaleCode) => void;
  t: (key: string, params?: TranslationParams) => string;
}

const LOCALE_STORAGE_KEY = 'nostr-chat:locale';

export const languageOptions = [
  {
    code: 'en-US',
    englishName: 'English',
    nativeName: 'English',
    intlLocale: 'en-US',
    direction: 'ltr',
  },
  {
    code: 'zh-CN',
    englishName: 'Mandarin Chinese',
    nativeName: '简体中文',
    intlLocale: 'zh-CN',
    direction: 'ltr',
  },
  {
    code: 'hi-IN',
    englishName: 'Hindi',
    nativeName: 'हिन्दी',
    intlLocale: 'hi-IN',
    direction: 'ltr',
  },
  {
    code: 'es-ES',
    englishName: 'Spanish',
    nativeName: 'Español',
    intlLocale: 'es-ES',
    direction: 'ltr',
  },
  {
    code: 'ar',
    englishName: 'Arabic',
    nativeName: 'العربية',
    intlLocale: 'ar',
    direction: 'rtl',
  },
  {
    code: 'fr-FR',
    englishName: 'French',
    nativeName: 'Français',
    intlLocale: 'fr-FR',
    direction: 'ltr',
  },
  {
    code: 'bn-BD',
    englishName: 'Bengali',
    nativeName: 'বাংলা',
    intlLocale: 'bn-BD',
    direction: 'ltr',
  },
  {
    code: 'pt-BR',
    englishName: 'Portuguese',
    nativeName: 'Português',
    intlLocale: 'pt-BR',
    direction: 'ltr',
  },
  {
    code: 'ru-RU',
    englishName: 'Russian',
    nativeName: 'Русский',
    intlLocale: 'ru-RU',
    direction: 'ltr',
  },
  {
    code: 'ur-PK',
    englishName: 'Urdu',
    nativeName: 'اردو',
    intlLocale: 'ur-PK',
    direction: 'rtl',
  },
  {
    code: 'id-ID',
    englishName: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    intlLocale: 'id-ID',
    direction: 'ltr',
  },
  {
    code: 'de-DE',
    englishName: 'German',
    nativeName: 'Deutsch',
    intlLocale: 'de-DE',
    direction: 'ltr',
  },
  {
    code: 'ja-JP',
    englishName: 'Japanese',
    nativeName: '日本語',
    intlLocale: 'ja-JP',
    direction: 'ltr',
  },
  {
    code: 'pcm-NG',
    englishName: 'Nigerian Pidgin',
    nativeName: 'Naija',
    intlLocale: 'en-NG',
    direction: 'ltr',
  },
  {
    code: 'ar-EG',
    englishName: 'Egyptian Arabic',
    nativeName: 'العربية المصرية',
    intlLocale: 'ar-EG',
    direction: 'rtl',
  },
  {
    code: 'mr-IN',
    englishName: 'Marathi',
    nativeName: 'मराठी',
    intlLocale: 'mr-IN',
    direction: 'ltr',
  },
  {
    code: 'te-IN',
    englishName: 'Telugu',
    nativeName: 'తెలుగు',
    intlLocale: 'te-IN',
    direction: 'ltr',
  },
  {
    code: 'tr-TR',
    englishName: 'Turkish',
    nativeName: 'Türkçe',
    intlLocale: 'tr-TR',
    direction: 'ltr',
  },
  {
    code: 'ta-IN',
    englishName: 'Tamil',
    nativeName: 'தமிழ்',
    intlLocale: 'ta-IN',
    direction: 'ltr',
  },
  {
    code: 'yue-HK',
    englishName: 'Cantonese',
    nativeName: '粵語',
    intlLocale: 'yue-HK',
    direction: 'ltr',
  },
] as const satisfies readonly LanguageOption[];

const messagesByLocale: Record<LocaleCode, TranslationMessages> = {
  ar,
  'ar-EG': arEG,
  'bn-BD': bnBD,
  'de-DE': deDE,
  'en-US': enUS,
  'es-ES': esES,
  'fr-FR': frFR,
  'hi-IN': hiIN,
  'id-ID': idID,
  'ja-JP': jaJP,
  'mr-IN': mrIN,
  'pcm-NG': pcmNG,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'ta-IN': taIN,
  'te-IN': teIN,
  'tr-TR': trTR,
  'ur-PK': urPK,
  'yue-HK': yueHK,
  'zh-CN': zhCN,
};

const languageByCode = new Map(languageOptions.map((language) => [language.code, language]));
const supportedLocaleCodes = new Set<LocaleCode>(languageOptions.map((language) => language.code));
const fallbackLocale: LocaleCode = 'en-US';
const fallbackLanguage =
  languageOptions.find((language) => language.code === fallbackLocale) ?? languageOptions[0];

const state = reactive<I18nState>({
  locale: resolveInitialLocale(),
});

const currentLocale = computed(() => state.locale);
const currentLanguage = computed(() => languageByCode.get(state.locale) ?? fallbackLanguage);
const i18nInjectionKey: InjectionKey<I18nApi> = Symbol('anagram-i18n');

export const i18nApi: I18nApi = {
  locale: currentLocale,
  language: currentLanguage,
  languages: languageOptions,
  setLocale,
  t,
};

export function installI18n(app: App): void {
  app.provide(i18nInjectionKey, i18nApi);
  app.config.globalProperties.$t = t;
  app.config.globalProperties.$i18nLocale = currentLocale;
  applyDocumentLocale();
}

export function useI18n(): I18nApi {
  return inject(i18nInjectionKey, i18nApi);
}

export function setLocale(locale: LocaleCode): void {
  if (!isSupportedLocale(locale) || state.locale === locale) {
    return;
  }

  state.locale = locale;
  saveStoredLocale(locale);
  applyDocumentLocale();
}

export function t(key: string, params: TranslationParams = {}): string {
  const normalizedKey = key.trim();
  const localeMessages = messagesByLocale[state.locale] ?? {};
  const fallbackMessages = messagesByLocale[fallbackLocale];
  const template =
    localeMessages[normalizedKey] ?? fallbackMessages[normalizedKey] ?? normalizedKey;
  return interpolateMessage(template, params);
}

export function getDateTimeLocale(): string {
  return currentLanguage.value.intlLocale;
}

export function isSupportedLocale(value: string): value is LocaleCode {
  return supportedLocaleCodes.has(value as LocaleCode);
}

function interpolateMessage(template: string, params: TranslationParams): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, paramKey: string) => {
    const value = params[paramKey];
    if (value === null || value === undefined) {
      return match;
    }

    return String(value);
  });
}

function resolveInitialLocale(): LocaleCode {
  const storedLocale = readStoredLocale();
  if (storedLocale) {
    return storedLocale;
  }

  if (typeof navigator === 'undefined') {
    return fallbackLocale;
  }

  for (const preferredLanguage of navigator.languages ?? [navigator.language]) {
    const matchingLocale = findMatchingLocale(preferredLanguage);
    if (matchingLocale) {
      return matchingLocale;
    }
  }

  return fallbackLocale;
}

function findMatchingLocale(value: string | undefined): LocaleCode | null {
  const normalizedValue = value?.trim();
  if (!normalizedValue) {
    return null;
  }

  if (isSupportedLocale(normalizedValue)) {
    return normalizedValue;
  }

  const languagePart = normalizedValue.split('-')[0]?.toLowerCase();
  if (!languagePart) {
    return null;
  }

  return (
    languageOptions.find((language) => language.code.toLowerCase().startsWith(languagePart))
      ?.code ?? null
  );
}

function readStoredLocale(): LocaleCode | null {
  try {
    const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY)?.trim();
    return storedLocale && isSupportedLocale(storedLocale) ? storedLocale : null;
  } catch {
    return null;
  }
}

function saveStoredLocale(locale: LocaleCode): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Locale changes should keep working for the current session even if storage fails.
  }
}

function applyDocumentLocale(): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.lang = currentLanguage.value.intlLocale;
  document.documentElement.dir = currentLanguage.value.direction;
}
