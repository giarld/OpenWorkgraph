import { isVisualizeFeatureSelection, VISUALIZE_FEATURE_ID } from '@openworkgraph/protocol';
import type { BuiltinFeatureCandidate, VisualizeFeatureSelection } from '@openworkgraph/protocol';
import { ServiceError } from './errors.js';

const selection: Readonly<VisualizeFeatureSelection> = Object.freeze({
  kind: 'builtin-feature', featureId: VISUALIZE_FEATURE_ID, version: 1,
});
const candidate: Readonly<BuiltinFeatureCandidate> = Object.freeze({
  ...selection, name: 'visualize', description: '生成可交互的可视化节点，以 JSON 表单向后继传递业务数据。',
});

/** Local product catalog: no workspace paths, installation or credentials. */
export function visualizeFeatureCandidates(query = ''): BuiltinFeatureCandidate[] {
  const term = query.trim().toLocaleLowerCase();
  return !term || candidate.name.includes(term) || candidate.description.toLocaleLowerCase().includes(term)
    ? [{ ...candidate }] : [];
}

/** Validate identities before any async skill discovery. Names/$mentions never enable features.
 * visualizeGeneration is host-owned: set it for a visualize node's own generation only.
 * Include the returned detached selection in the submitted snapshot AND its digest. */
export function freezeVisualizeFeatures(raw: unknown, visualizeGeneration = false): VisualizeFeatureSelection[] {
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 1 || raw.length === 1 && !isVisualizeFeatureSelection(raw[0])))
    throw new ServiceError('INPUT_BLOCKED', '无效的内置可视化功能选择，请重新选择。');
  const enabled = visualizeGeneration || Array.isArray(raw) && raw.length === 1;
  // Fresh immutable objects prevent caller edits during asynchronous preflight.
  return Object.freeze(enabled ? [Object.freeze({ ...selection })] : []) as VisualizeFeatureSelection[];
}

/** Publication/launch must inspect the frozen identity, never the edited node/prompt. */
export function hasVisualizeFeature(features: unknown): boolean {
  return Array.isArray(features) && features.length === 1 && isVisualizeFeatureSelection(features[0]);
}
