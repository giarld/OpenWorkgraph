import { parseVisualizeAssetPackage, VISUALIZE_LIBRARY_VERSION, VisualizeValidationError } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

/** Advance the minimum only when this Workspace stops reading an older file format. */
export const visualizeCompatibility = Object.freeze({ minimumVersion: 1, currentVersion: VISUALIZE_LIBRARY_VERSION });
export function parseSupportedVisualizeAsset(value: unknown) {
  try { return parseVisualizeAssetPackage(value, visualizeCompatibility); }
  catch (error) {
    if (error instanceof VisualizeValidationError && error.code === 'SCHEMA_UNSUPPORTED') throw new ServiceError('SCHEMA_UNSUPPORTED', '工作空间不支持此可视化文件版本。', { details: { ...visualizeCompatibility } });
    throw error;
  }
}
