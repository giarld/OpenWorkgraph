#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  buildVisualizeAssetPackage, buildVisualizeToolTemplate,
  validateVisualizeAssetPackageBytes, validateVisualizePagePackage,
  readVisualizeAssetPage, collectVisualizeAssetReferences,
} from './vendor/protocol.mjs';

const NL = String.fromCharCode(10);
const MAX_FILE = 32 * 1024 * 1024, MAX_RESOURCES = 24 * 1024 * 1024;
const PAGE_ID = '__owgv_page', FORM_ID = '__owgv_form';
const ref = resourceId => ({ resourceId, resourceVersion: 1 });
const jsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, required = allowed) {
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error('Expected fields: ' + allowed.join(', '));
}
function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be a nonempty string');
  return value;
}
async function bytesAt(path, maximum = MAX_FILE) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) throw new Error('Not a file or exceeds byte budget: ' + path);
  const bytes = await readFile(path);
  if (bytes.length > maximum) throw new Error('File exceeds byte budget: ' + path);
  return bytes;
}
function utf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
async function jsonAt(path) { return JSON.parse(utf8(await bytesAt(path))); }
function resource(resourceId, name, mime, bytes) {
  return { resourceId, version: 1, name, mime, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
}
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + NL, 'utf8');
}

export async function validate(value) {
  const asset = await validateVisualizeAssetPackageBytes(value);
  const page = readVisualizeAssetPage(asset);
  for (const data of [page.form.schema, page.initialForm, page.initialState,
    asset.node.content.form.data, asset.node.content.state.data]) collectVisualizeAssetReferences(data);
  return asset;
}

export async function pack(sourcePath, outputPath) {
  sourcePath = resolve(sourcePath); outputPath = resolve(outputPath);
  if (extname(outputPath).toLowerCase() !== '.owgv') throw new Error('Output filename must end in .owgv');
  if (sourcePath === outputPath) throw new Error('Source and output must differ');
  const source = await jsonAt(sourcePath), root = dirname(sourcePath);
  fields(source, ['title', 'prompt', 'htmlFile', 'page', 'assets', 'snapshot'], ['title', 'page']);
  nonempty(source.title, 'title');
  if (source.prompt !== undefined && typeof source.prompt !== 'string') throw new Error('prompt must be a string');
  if (!plain(source.page)) throw new Error('page must be an object');
  const page = structuredClone(source.page);
  if (Object.hasOwn(source, 'htmlFile')) {
    if (Object.hasOwn(page, 'html')) throw new Error('Use either htmlFile or page.html');
    page.html = utf8(await bytesAt(resolve(root, nonempty(source.htmlFile, 'htmlFile')), 4_194_304));
  }
  validateVisualizePagePackage(page);
  if (page.version !== 2) throw new Error('New .owgv files require page version 2');
  if (!Array.isArray(source.assets ?? [])) throw new Error('assets must be an array');
  const resources = [], ids = new Set([PAGE_ID, FORM_ID]);
  let total = 0;
  if ((source.assets ?? []).length > 254) throw new Error('At most 254 media resources plus page/form');
  for (const item of source.assets ?? []) {
    fields(item, ['resourceId', 'path', 'mime', 'name'], ['resourceId', 'path', 'mime']);
    const id = nonempty(item.resourceId, 'resourceId');
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(id) || ids.has(id)) throw new Error('Invalid or duplicate resourceId: ' + id);
    ids.add(id);
    const path = resolve(root, nonempty(item.path, 'asset path'));
    const bytes = await bytesAt(path, MAX_RESOURCES - total);
    total += bytes.length;
    resources.push(resource(id, item.name === undefined ? basename(path) : nonempty(item.name, 'asset name'),
      nonempty(item.mime, 'asset mime'), bytes));
  }
  const snapshot = source.snapshot;
  if (snapshot !== undefined) fields(snapshot, ['form', 'state', 'width', 'height']);
  const formData = snapshot ? snapshot.form : page.initialForm;
  const stateData = snapshot ? snapshot.state : page.initialState;
  const width = snapshot ? snapshot.width : page.layout?.width ?? 480;
  const height = snapshot ? snapshot.height : page.layout?.height ?? 360;
  const node = { type: 'visualize', schemaVersion: 1, width, height, content: {
    title: source.title, prompt: source.prompt ?? '', inputBindings: [],
    page: { revision: 1, resource: ref(PAGE_ID), dependencies: [] },
    form: { pageRevision: 1, schemaVersion: page.form.version, version: 1, data: formData, resource: ref(FORM_ID) },
    state: { pageRevision: 1, version: 1, data: stateData },
  } };
  resources.unshift(resource(PAGE_ID, 'visualize-page.json', 'application/json', jsonBytes(page)),
    resource(FORM_ID, 'visualize-form.json', 'application/json', jsonBytes(formData)));
  const build = snapshot ? buildVisualizeAssetPackage : buildVisualizeToolTemplate;
  const asset = await validate(build({ node, page, resources }));
  // Validate the exact serialized file, including its whitespace byte budget.
  const serialized = JSON.stringify(asset) + NL;
  await validate(serialized);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, 'utf8');
  return { valid: true, path: outputPath, title: asset.title, resources: asset.resources.length,
    bytes: Buffer.byteLength(serialized), decodedBytes: asset.resources.reduce((sum, item) => sum + item.bytes, 0) };
}

export async function unpack(inputPath, outputDirectory) {
  const asset = await validate(utf8(await bytesAt(resolve(inputPath))));
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: false });
  const page = readVisualizeAssetPage(asset), content = asset.node.content;
  const source = { title: asset.title, prompt: content.prompt, htmlFile: 'tool.html', page,
    assets: [], snapshot: { form: content.form.data, state: content.state.data,
      width: asset.node.width, height: asset.node.height } };
  await writeFile(resolve(out, 'tool.html'), page.html, 'utf8');
  delete page.html;
  const reserved = new Set([content.page.resource.resourceId, content.form.resource.resourceId]);
  const suffix = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg',
    'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
    'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js', 'application/json': '.json' };
  for (const item of asset.resources) {
    if (reserved.has(item.resourceId)) continue;
    // Resource display names never become extraction paths.
    const path = 'media/' + item.resourceId + (suffix[item.mime] ?? '.bin');
    await mkdir(resolve(out, 'media'), { recursive: true });
    await writeFile(resolve(out, path), Buffer.from(item.base64, 'base64'));
    source.assets.push({ resourceId: item.resourceId, name: item.name, mime: item.mime, path });
  }
  await writeJson(resolve(out, 'source.json'), source);
  return { valid: true, path: resolve(out, 'source.json'), assets: source.assets.length };
}

async function main(args) {
  const [command, first, second] = args;
  if (command === '--help' || command === '-h') {
    console.log(['Usage: node owgv.mjs pack source.json output.owgv',
      '       node owgv.mjs validate file.owgv', '       node owgv.mjs unpack file.owgv NEW_DIRECTORY'].join(NL));
    return;
  }
  let result;
  if (command === 'pack' && args.length === 3) result = await pack(first, second);
  else if (command === 'unpack' && args.length === 3) result = await unpack(first, second);
  else if (command === 'validate' && args.length === 2) {
    const asset = await validate(utf8(await bytesAt(resolve(first))));
    result = { valid: true, path: resolve(first), title: asset.title, resources: asset.resources.length };
  } else throw new Error('Use --help for pack, validate and unpack commands');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ valid: false, code: error.code ?? 'INVALID_REQUEST',
      message: error.message, ...(error.fields?.length ? { fields: error.fields } : {}) }, null, 2));
    process.exitCode = 1;
  });
}
