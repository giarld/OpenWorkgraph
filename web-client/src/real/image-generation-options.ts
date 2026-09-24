import type { ImageGenerationOptions, ImageProviderModel } from '../../../packages/protocol/src/index';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';

export const IMAGE_SCALES = ['auto', '1k', '2k', '4k'] as const;
export type ImageScale = (typeof IMAGE_SCALES)[number];

export const IMAGE_RATIOS = ['auto', '1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16', '21:9', '9:21'] as const;

export const IMAGE_SIZE_PRESETS: Readonly<Record<Exclude<ImageScale, 'auto'>, Readonly<Record<string, string>>>> = {
  '1k': { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1536x864', '9:16': '864x1536', '21:9': '2016x864', '9:21': '864x2016' },
  '2k': { '1:1': '2048x2048', '2:3': '1360x2048', '3:2': '2048x1360', '4:3': '2048x1536', '3:4': '1536x2048', '16:9': '2048x1152', '9:16': '1152x2048', '21:9': '2688x1152', '9:21': '1152x2688' },
  '4k': { '1:1': '2880x2880', '2:3': '2336x3520', '3:2': '3520x2336', '4:3': '3312x2480', '3:4': '2480x3312', '16:9': '3840x2160', '9:16': '2160x3840', '21:9': '3840x1648', '9:21': '1648x3840' },
};

export interface ImageDimensions { width: number; height: number }

export function parseImageDimensions(value: string | undefined): ImageDimensions | undefined {
  const match = /^(\d{1,4})x(\d{1,4})$/i.exec(value ?? '');
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export function exactImageRatio(size: string): string | undefined {
  const dimensions = parseImageDimensions(size);
  if (!dimensions) return undefined;
  const divisor = gcd(dimensions.width, dimensions.height);
  return `${dimensions.width / divisor}:${dimensions.height / divisor}`;
}

export function nearestImageRatio(size: string): string {
  const dimensions = parseImageDimensions(size);
  if (!dimensions) return size === 'auto' ? 'auto' : '1:1';
  const target = dimensions.width / dimensions.height;
  return IMAGE_RATIOS.filter(value => value !== 'auto').reduce((best, value) => {
    const [width, height] = value.split(':').map(Number);
    const [bestWidth, bestHeight] = best.split(':').map(Number);
    return Math.abs(width! / height! - target) < Math.abs(bestWidth! / bestHeight! - target) ? value : best;
  }, '1:1');
}

export function inferImageScale(size: string | undefined): ImageScale {
  if (!size || size === 'auto') return 'auto';
  for (const scale of ['1k', '2k', '4k'] as const) if (Object.values(IMAGE_SIZE_PRESETS[scale]).includes(size)) return scale;
  const dimensions = parseImageDimensions(size);
  if (!dimensions) return 'auto';
  const edge = Math.max(dimensions.width, dimensions.height);
  return edge <= 1536 ? '1k' : edge <= 2688 ? '2k' : '4k';
}

export function presetImageSize(scale: ImageScale, ratio: string): string {
  if (scale === 'auto' || ratio === 'auto') return 'auto';
  return IMAGE_SIZE_PRESETS[scale][ratio] ?? 'auto';
}

export function declaredImageSizes(model: ImageProviderModel | undefined): string[] {
  return [...new Set((model?.sizes ?? []).filter(value => parseImageDimensions(value)))];
}

export function modelAllowsCustomImageSize(model: ImageProviderModel | undefined): boolean {
  return !model || model.sizes.includes('auto');
}

export function imageRatiosForModel(model: ImageProviderModel | undefined): string[] {
  if (modelAllowsCustomImageSize(model)) return [...IMAGE_RATIOS];
  return [...new Set(declaredImageSizes(model).map(exactImageRatio).filter((value): value is string => Boolean(value)))];
}

export function imageScalesForModel(model: ImageProviderModel | undefined): ImageScale[] {
  if (modelAllowsCustomImageSize(model)) return [...IMAGE_SCALES];
  return [...new Set(declaredImageSizes(model).map(inferImageScale))];
}

export function chooseDeclaredImageSize(model: ImageProviderModel, scale: ImageScale, ratio: string): string | undefined {
  const sizes = declaredImageSizes(model);
  return sizes.find(size => inferImageScale(size) === scale && exactImageRatio(size) === ratio)
    ?? sizes.find(size => exactImageRatio(size) === ratio)
    ?? sizes.find(size => inferImageScale(size) === scale)
    ?? sizes[0];
}

export function normalizeImageOptionsForModel(options: ImageGenerationOptions, model: ImageProviderModel): ImageGenerationOptions {
  const quality = options.quality && options.quality !== 'auto' && !model.qualities.includes('auto') && !model.qualities.includes(options.quality) ? 'auto' : options.quality ?? 'auto';
  if (modelAllowsCustomImageSize(model)) return { ...options, quality };
  const sizes = declaredImageSizes(model);
  const size = options.size && sizes.includes(options.size) ? options.size : sizes[0] ?? 'auto';
  return { ...options, quality, size, aspectRatio: exactImageRatio(size) ?? 'auto' };
}

export function validateCustomImageSize(size: string): string | undefined {
  const dimensions = parseImageDimensions(size);
  if (!dimensions) return translate("Enter valid image dimensions.");
  const { width, height } = dimensions;
  if (Math.max(width, height) > 3840) return translate("The longest image edge cannot exceed 3840 pixels.");
  if (Math.max(width, height) / Math.min(width, height) > 3) return translate("The image aspect ratio cannot exceed 3:1.");
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) return translate("The image must contain between 655,360 and 8,294,400 pixels.");
  return undefined;
}
