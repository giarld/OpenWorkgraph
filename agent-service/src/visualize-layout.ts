import type { GraphSnapshot } from '@openworkgraph/protocol';
import { outputSuccessorPositions } from './output-layout.js';

export function visualizeSuccessorPositions(graph: GraphSnapshot, sourceId: string, types: readonly string[]): { x: number; y: number; width: number; height: number }[] {
  return outputSuccessorPositions(graph, sourceId, types.map(type => ({ type })));
}
