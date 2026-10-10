import { VISUALIZE_FEATURE_ID, type VisualizeFeatureSelection } from '../../../packages/protocol/src/visualize';

export const VISUALIZE_FEATURE_MENTION = '[visualize](workgraph-feature:visualize)';

export function extractBuiltinFeatureMention(link: string) {
  return link === VISUALIZE_FEATURE_MENTION ? { name: 'visualize', kind: 'builtin-feature' as const } : undefined;
}

/** Explicit feature tokens stay in sync with the structured execution setting. */
export function syncBuiltinFeatureMentions(previous: string, next: string, features: VisualizeFeatureSelection[]): VisualizeFeatureSelection[] {
  const selected = features.filter(feature => feature.featureId !== VISUALIZE_FEATURE_ID);
  if (next.includes(VISUALIZE_FEATURE_MENTION)) selected.push({ kind: 'builtin-feature', featureId: VISUALIZE_FEATURE_ID, version: 1 });
  else if (!previous.includes(VISUALIZE_FEATURE_MENTION)) return features;
  return selected;
}
