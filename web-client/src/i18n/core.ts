export const LANGUAGE_PREFERENCE_STORAGE_KEY = 'openworkgraph:language';

export type LanguagePreference = 'system' | 'zh-CN' | 'en';
export type AppLanguage = Exclude<LanguagePreference, 'system'>;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'zh-CN' || value === 'en';
}

export function systemLanguage(language: string | undefined): AppLanguage {
  if (!language) return 'en';
  const normalized = language.replace(/_/g, '-');
  if (/^zh(?:$|-CN(?:-|$)|-SG(?:-|$)|-MY(?:-|$)|-Hans(?:-|$))/i.test(normalized)) return 'zh-CN';
  return 'en';
}

export function resolveLanguage(
  preference: LanguagePreference,
  language: string | undefined,
): AppLanguage {
  return preference === 'system' ? systemLanguage(language) : preference;
}
