import { systemLanguage, type AppLanguage } from './core';
import { translateMessage, type MessageVariables } from './messages';
import './catalogs';

let activeLanguage: AppLanguage | undefined;

export function setActiveLanguage(language: AppLanguage): void {
  activeLanguage = language;
}

export function getActiveLanguage(): AppLanguage {
  if (activeLanguage) return activeLanguage;
  if (typeof document !== 'undefined') {
    const declared = document.documentElement.lang;
    if (declared) return systemLanguage(declared);
  }
  return systemLanguage(typeof navigator === 'undefined' ? undefined : navigator.language);
}

/** Translate user-facing text in modules that cannot consume React context. */
export function translate(english: string, variables?: MessageVariables): string {
  return translateMessage(getActiveLanguage(), english, variables);
}
