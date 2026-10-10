import enUS from './locales/en-US.json';
import { writable, derived, get } from 'svelte/store';
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
] as const;
export type LocaleCode = (typeof languageOptions)[number]['code'];
export type TranslationParams = Record<string, string | number | boolean | null | undefined>;
const dictionaries: Record<string, Record<string, string>> = { 'en-US': enUS };
const catalogLoaders = import.meta.glob<{ default: Record<string, string> }>('./locales/*.json');
const catalogVersion = writable(0);
const catalogRequests = new Map<string, Promise<void>>();
function loadCatalog(language: string): Promise<void> {
  if (dictionaries[language]) return Promise.resolve();
  const existing = catalogRequests.get(language);
  if (existing) return existing;
  const loader = catalogLoaders[`./locales/${language}.json`];
  if (!loader) return Promise.resolve();
  const loading = loader()
    .then((module) => {
      dictionaries[language] = module.default;
      catalogVersion.update((n) => n + 1);
    })
    .catch((error) => console.warn('Language catalog unavailable', error))
    .finally(() => catalogRequests.delete(language));
  catalogRequests.set(language, loading);
  return loading;
}
const storageKey = 'nostr-chat:locale';
const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
export const locale = writable<LocaleCode>(
  languageOptions.some((l) => l.code === saved) ? (saved as LocaleCode) : 'en-US',
);
export function setLocale(value: LocaleCode) {
  if (!languageOptions.some((language) => language.code === value)) return;
  locale.set(value);
  if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, value);
}
locale.subscribe((value) => {
  void loadCatalog(value);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = value;
    document.documentElement.dir =
      languageOptions.find((l) => l.code === value)?.direction ?? 'ltr';
  }
});
function translateFor(language: string, key: string, params: TranslationParams = {}) {
  return (dictionaries[language]?.[key] ?? dictionaries['en-US'][key] ?? key).replace(
    /\{(\w+)\}/g,
    (_, name) => String(params[name] ?? `{${name}}`),
  );
}
export function t(key: string, params: TranslationParams = {}) {
  return translateFor(get(locale), key, params);
}
// Also translate existing interface labels using their canonical source keys.
const keysByEnglish = new Map(
  Object.entries(dictionaries['en-US']).map(([key, value]) => [value, key]),
);
export const translate = derived(
  [locale, catalogVersion],
  ([language]) =>
    (text: string, params: TranslationParams = {}) =>
      translateFor(language, keysByEnglish.get(text) ?? text, params),
);
