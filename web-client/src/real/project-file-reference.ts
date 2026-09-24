import type { Json } from './contracts';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

const object = (value: Json): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function projectFileSource(content: Json): Record<string, Json> {
  return object(object(content).source);
}
export function isBoundProjectFileReference(content: Json): boolean {
  return projectFileSource(content).kind === 'project-file';
}
export function isEmptyProjectFileReference(content: Json): boolean {
  return projectFileSource(content).kind === 'project-file-empty';
}
export function isProjectFileReference(content: Json): boolean {
  const kind = projectFileSource(content).kind;
  return kind === 'project-file' || kind === 'project-file-empty';
}
export function emptyProjectFileContent(content: Record<string, Json>): Record<string, Json> {
  const source = object(content.source);
  const relativePath = String(source.relativePath ?? '');
  return { title: String(content.title ?? relativePath.split('/').at(-1) ?? translate("Empty reference")), source: { kind: 'project-file-empty', relativePath } };
}
