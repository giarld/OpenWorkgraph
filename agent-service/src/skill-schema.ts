import type { SkillConfigSchema, SkillEnvironmentField } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

export const SKILL_CONFIG_LIMITS = { schemaBytes: 128 * 1024, fields: 128, valueBytes: 16 * 1024, valuesBytes: 256 * 1024 } as const;
const fail = (): never => { throw new ServiceError('INVALID_REQUEST', '技能配置声明格式无效。'); };
const controls = new Set(['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME', 'NODE_OPTIONS', 'NODE_PATH', 'SHELL', 'COMSPEC', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'IFS', 'CDPATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'PYTHONPATH', 'PYTHONHOME', 'RUBYOPT', 'PERL5OPT', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR']);
export function validateSkillEnvironmentName(name: string): void {
  if (typeof name !== 'string' || name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || controls.has(name.toUpperCase()) || /^(?:CODEX_|NODE_|LD_|DYLD_)/i.test(name)) fail();
}
export function validateSkillValue(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > SKILL_CONFIG_LIMITS.valueBytes || value.includes('\0')) fail();
}

/** Scan original tokens before JSON.parse can erase duplicate object keys. */
function uniqueJson(text: string): unknown {
  let offset = 0;
  const ws = () => { while (offset < text.length && /[\t\r\n ]/.test(text[offset] ?? '')) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') { try { return JSON.parse(text.slice(start, offset)) as string; } catch { fail(); } }
      if (char === '\\') offset++;
    }
    return fail();
  };
  const value = (depth: number): void => {
    if (depth > 16) fail();
    ws();
    const char = text[offset];
    if (char === '{' || char === '[') {
      offset++; ws();
      const end = char === '{' ? '}' : ']';
      const keys = new Set<string>();
      if (text[offset] === end) { offset++; return; }
      for (;;) {
        ws();
        if (char === '{') {
          if (text[offset] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key); ws();
          if (text[offset++] !== ':') fail();
        }
        value(depth + 1); ws();
        if (text[offset] === end) { offset++; return; }
        if (text[offset++] !== ',') fail();
      }
    } else if (char === '"') string();
    else {
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
      if (!token) fail();
      offset += token![0].length;
    }
  };
  try { value(0); ws(); if (offset !== text.length) fail(); return JSON.parse(text) as unknown; }
  catch { return fail(); }
}
function object(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) fail();
  return result;
}
function prose(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) fail();
}
export function parseSkillConfig(text: string): SkillConfigSchema {
  if (typeof text !== 'string' || Buffer.byteLength(text) > SKILL_CONFIG_LIMITS.schemaBytes) fail();
  const root = object(uniqueJson(text), ['version', 'environment'], ['version', 'environment']);
  if (root.version !== 1 || !Array.isArray(root.environment) || root.environment.length > SKILL_CONFIG_LIMITS.fields) fail();
  const names = new Set<string>();
  const environment = (root.environment as unknown[]).map(raw => {
    const field = object(raw, ['name', 'label', 'description', 'required', 'secret', 'default', 'translations'], ['name', 'label', 'description', 'required', 'secret']);
    if (typeof field.name !== 'string' || typeof field.required !== 'boolean' || typeof field.secret !== 'boolean') fail();
    const name = field.name as string;
    validateSkillEnvironmentName(name);
    // Portable packages cannot declare names that collide on Windows.
    if (names.has(name.toUpperCase())) fail();
    names.add(name.toUpperCase());
    prose(field.label); prose(field.description);
    if (Object.hasOwn(field, 'default')) {
      if (field.secret || typeof field.default !== 'string') fail();
      validateSkillValue(field.default as string);
    }
    if (Object.hasOwn(field, 'translations')) {
      const translations = field.translations;
      if (!translations || typeof translations !== 'object' || Array.isArray(translations) || Object.keys(translations).length > 32) fail();
      for (const [locale, translation] of Object.entries(translations as Record<string, unknown>)) {
        if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) fail();
        const translated = object(translation, ['label', 'description'], ['label', 'description']);
        prose(translated.label); prose(translated.description);
      }
    }
    return field as unknown as SkillEnvironmentField;
  });
  return { version: 1, environment };
}
