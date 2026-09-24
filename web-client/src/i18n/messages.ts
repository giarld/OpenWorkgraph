import type { AppLanguage } from './core';

export type MessageVariables = Record<string, string | number>;
export type TranslationCatalog = Record<string, string>;

export const coreZhCN = {
  'OpenWorkgraph · Work Graph': 'OpenWorkgraph · 工作图',
  'Loading workspace…': '正在载入工作区…',
  'Change language': '切换语言',
  'Language': '语言',
  'Follow system': '跟随系统',
  'Simplified Chinese': '简体中文',
  'English': 'English',
  'Delete {name}': '删除 {name}',
} satisfies TranslationCatalog;

// Domain catalogs are merged here as migration batches land. English message
// text is the canonical key; Simplified Chinese provides the translation.
export const zhCN: TranslationCatalog = { ...coreZhCN };

export function translateMessage(
  language: AppLanguage,
  english: string,
  variables?: MessageVariables,
): string {
  const template = language === 'zh-CN' ? zhCN[english] ?? english : english;
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(variables, name) ? String(variables[name]) : match);
}
