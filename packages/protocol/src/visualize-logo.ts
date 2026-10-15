import type { VisualizePagePackage } from './visualize.js';

export const VISUALIZE_LOGO_MAX_BYTES = 8192;
export const VISUALIZE_LOGO_MAX_ELEMENTS = 64;
export const VISUALIZE_DEFAULT_LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#64748b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="44" height="44" rx="8"/><path d="M18 24h28M18 40h28"/></g><g fill="#3b82f6"><circle cx="28" cy="24" r="5"/><circle cx="38" cy="40" r="5"/></g></svg>';
export const VISUALIZE_LOGO_PALETTES = [
  { name: '松绿 × 琥珀', primary: '#287568', accent: '#D99A35' },
  { name: '海蓝 × 珊瑚', primary: '#3478B8', accent: '#E98273' },
  { name: '钢蓝 × 青绿', primary: '#5276A5', accent: '#38B6A0' },
] as const;
export const VISUALIZE_LOGO_GENERATION_GUIDANCE = '采用双色几何实心风格。用厚实主轮廓表达页面核心功能，以第二种颜色强调关键部件，让色块本身形成图标，不加外围底板。仅使用本次指定的主色与强调色，不混用其他配色组；将显式颜色值保存到 logoSvg，不在页面加载或渲染时随机变色。主结构厚度约 6–8 单位，适度圆角。通过简单拼接或局部交叠建立记忆点，不堆叠细节，不统一套用空心方框。最多两个视觉主体，在 24 像素尺寸下仍清晰可辨。页面功能：使用本次具体功能名称。同次交付 version=2 页面包的 logoSvg 直接 SVG 文本，不调用图像模型；viewBox="0 0 64 64"、透明背景、四周至少 8 单位安全区，最多两种颜色。生成时优先 2–6 个图形元素，上限 10 个，SVG 不超过 2 KiB；兼容校验硬上限仍为 64 个图形元素 / 8 KiB，不作为生成目标。不含文字、位图、渐变、阴影、动画、外部资源、CSS 或 currentColor。';
const elements = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc']);
const attributes = new Set(['xmlns', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'd', 'x', 'y', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'points']);
/** Strict XML parser for a closed SVG dialect. No browser repair, entity
 * expansion or sanitizing deletion: validate structure and every attribute. */
export function validateVisualizeLogoSvg(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > VISUALIZE_LOGO_MAX_BYTES) return 'Logo exceeds the SVG byte budget or is missing';
  const source = value.trim(), stack: string[] = [], colors = new Set<string>();
  let offset = 0, count = 0, roots = 0;
  while (offset < source.length) {
    if (source[offset] !== '<') {
      const end = source.indexOf('<', offset), text = source.slice(offset, end < 0 ? source.length : end);
      if (text.includes('&') || text.trim() && !['title', 'desc'].includes(stack.at(-1) ?? '')) return 'Unexpected SVG text or entity';
      offset = end < 0 ? source.length : end; continue;
    }
    const close = /^<\/([A-Za-z]+)\s*>/.exec(source.slice(offset));
    if (close) { if (stack.pop() !== close[1]) return 'Mismatched SVG closing element'; offset += close[0].length; continue; }
    const open = /^<([A-Za-z]+)(?=[\s/>])/.exec(source.slice(offset));
    if (!open || !elements.has(open[1]!)) return 'Unsupported SVG element or XML declaration';
    const name = open[1]!;
    if (!stack.length) { if (++roots !== 1 || name !== 'svg') return 'SVG requires one root'; }
    else if (name === 'svg' || ['title', 'desc'].includes(stack.at(-1)!)) return 'Invalid SVG nesting';
    if (++count > VISUALIZE_LOGO_MAX_ELEMENTS + 1 || stack.length > 16) return 'SVG element budget exceeded';
    offset += open[0].length;
    const attrs = new Map<string, string>();
    while (true) {
      const space = /^\s*/.exec(source.slice(offset))![0]; offset += space.length;
      if (source.startsWith('/>', offset) || source[offset] === '>') break;
      if (!space) return 'SVG attributes require whitespace';
      const attribute = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(["'])([^<>]*?)\2/.exec(source.slice(offset));
      if (!attribute) return 'Malformed SVG attribute';
      const key = attribute[1]!, val = attribute[3]!;
      if (!attributes.has(key) || attrs.has(key) || val.includes('&') || val.includes(String.fromCharCode(92)) || [...val].some(c => c.charCodeAt(0) < 32) || /url\s*\(|currentColor|javascript:|data:/i.test(val)) return 'Unsupported SVG attribute value';
      if (key === 'xmlns' && (name !== 'svg' || val !== 'http://www.w3.org/2000/svg')) return 'Invalid SVG namespace';
      if (key === 'viewBox' && (name !== 'svg' || val.trim() !== '0 0 64 64')) return 'Logo viewBox must be 0 0 64 64';
      if (key === 'fill' || key === 'stroke') {
        if (val !== 'none' && !/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(val)) return 'SVG colors must be explicit hex colors';
        if (val !== 'none') colors.add(val.toLowerCase());
      } else if (key === 'stroke-linecap' && !['round', 'butt', 'square'].includes(val) || key === 'stroke-linejoin' && !['round', 'bevel', 'miter'].includes(val) || key === 'fill-rule' && !['nonzero', 'evenodd'].includes(val)) return 'Invalid SVG presentation attribute';
      else if (!['xmlns', 'viewBox', 'fill', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'fill-rule'].includes(key)) {
        const pattern = key === 'd' ? /^[MmZzLlHhVvCcSsQqTtAa0-9eE+.,\s-]+$/ : key === 'transform' ? /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\([0-9eE+.,\s-]+\)\s*)+$/ : /^[0-9eE+.,\s-]+$/;
        if (!pattern.test(val)) return 'Invalid SVG geometry';
      }
      attrs.set(key, val); offset += attribute[0].length;
    }
    if (name === 'svg' && (attrs.get('viewBox') !== '0 0 64 64' || attrs.get('xmlns') !== 'http://www.w3.org/2000/svg')) return 'SVG namespace and viewBox are required';
    if (source.startsWith('/>', offset)) offset += 2; else { offset++; stack.push(name); }
  }
  if (stack.length || roots !== 1 || count < 2 || colors.size > 3 || !colors.size) return 'Invalid or empty SVG logo';
  return null;
}
/** Shared nonfatal preprocessing for generated pages and portable snapshots. */
export function normalizeVisualizePageLogo(value: unknown): { page: VisualizePagePackage; warnings: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { page: value as VisualizePagePackage, warnings: [] };
  const descriptor = Object.getOwnPropertyDescriptor(value, 'version');
  if (!descriptor || !('value' in descriptor) || ![1, 2].includes(descriptor.value)) return { page: value as VisualizePagePackage, warnings: [] };
  // Pass unsafe input through unchanged for strict page validation to reject.
  // Inspect descriptors before structuredClone, which otherwise invokes getters.
  // Keep this local to avoid a runtime dependency on visualize-validation.
  const pending: unknown[] = [value], visited = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) continue;
    if (!item || typeof item !== 'object') return { page: value as VisualizePagePackage, warnings: [] };
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return { page: value as VisualizePagePackage, warnings: [] };
    if (visited.has(item)) continue;
    visited.add(item);
    for (const key of Reflect.ownKeys(item)) {
      const field = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in field)) return { page: value as VisualizePagePackage, warnings: [] };
      pending.push(field.value);
    }
  }
  const page = structuredClone(value) as VisualizePagePackage;
  const issue = validateVisualizeLogoSvg(page.logoSvg);
  page.version = 2;
  if (issue) page.logoSvg = VISUALIZE_DEFAULT_LOGO_SVG;
  return { page, warnings: issue ? [issue + '; default logo used'] : [] };
}
