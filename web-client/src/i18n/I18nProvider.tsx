import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import {
  LANGUAGE_PREFERENCE_STORAGE_KEY,
  isLanguagePreference,
  resolveLanguage,
  type AppLanguage,
  type LanguagePreference,
} from './core';
import { translateMessage, type MessageVariables } from './messages';
import { getActiveLanguage, setActiveLanguage } from './translate';

interface I18nValue {
  language: AppLanguage;
  locale: string;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => void;
  t: (english: string, variables?: MessageVariables) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatDateTime: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

function readPreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
    if (isLanguagePreference(stored)) return stored;
  } catch { /* Language selection remains available without storage. */ }
  return 'system';
}

function browserLanguage(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>(readPreference);
  const [systemLocale, setSystemLocale] = useState(browserLanguage);
  const language = resolveLanguage(preference, systemLocale);
  setActiveLanguage(language);

  useEffect(() => {
    const update = () => setSystemLocale(browserLanguage());
    window.addEventListener('languagechange', update);
    return () => window.removeEventListener('languagechange', update);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.title = translateMessage(language, 'OpenWorkgraph · Work Graph');
  }, [language]);

  const setPreference = useCallback((next: LanguagePreference) => {
    setPreferenceState(next);
    try { localStorage.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, next); }
    catch { /* Keep the in-memory selection when storage is unavailable. */ }
  }, []);

  const t = useCallback((english: string, variables?: MessageVariables) =>
    translateMessage(language, english, variables), [language]);
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en';
  const formatNumber = useCallback((value: number, options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(value), [locale]);
  const formatDateTime = useCallback((value: Date | number, options?: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options).format(value), [locale]);

  const value = useMemo<I18nValue>(() => ({
    language, locale, preference, setPreference, t, formatNumber, formatDateTime,
  }), [language, locale, preference, setPreference, t, formatNumber, formatDateTime]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value) return value;
  const language = getActiveLanguage();
  const locale = language === 'zh-CN' ? 'zh-CN' : 'en';
  return {
    language,
    locale,
    preference: language,
    setPreference: preference => setActiveLanguage(preference === 'system' ? 'en' : preference),
    t: (english, variables) => translateMessage(language, english, variables),
    formatNumber: (number, options) => new Intl.NumberFormat(locale, options).format(number),
    formatDateTime: (date, options) => new Intl.DateTimeFormat(locale, options).format(date),
  };
}
