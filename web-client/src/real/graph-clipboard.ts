import { validSkillReferences, portableSkillContent } from "./project-file-mentions";
import { randomId } from "../adapter/random";
import { previewEdgeError } from '../../../packages/protocol/src/preview';
import { executionOrder } from '../../../packages/protocol/src/execution-chain';
import type {
  GraphOperation,
  GraphSnapshot,
  Json,
  Node,
  Request,
} from "./contracts";
import { graphPath } from "./contracts";
import type { CanvasCreated } from "./ResourcesPanel";
import { emptyProjectFileContent } from './project-file-reference';
import { FILE_NODE_MAX_BYTES, importedNodeType } from '../domain/file-types';
import '../i18n/catalogs/real-core';
import { translate } from '../i18n/translate';
import { validateVisualizeNodeContent } from '../../../packages/protocol/src/visualize-validation';
import { isVisualizeFeatureSelection, VISUALIZE_DEFAULT_SIZE } from '../../../packages/protocol/src/visualize';
import type { VisualizeNodeContent, VisualizePagePackage, VisualizeResourceReference, VisualizeStoredNode } from '../../../packages/protocol/src/visualize';
import { remapTemporaryVisualizeAssetData, remapTemporaryVisualizePage, validateTemporaryVisualizeResources, visualizeResourceReferences } from './temporary-store';
import { WORKGRAPH_TRANSFER_TOTAL_BYTES } from '../../../packages/protocol/src/index';

export const REAL_NODE_CLIPBOARD = "application/x-openworkgraph-real-nodes";
export const LEGACY_NODE_CLIPBOARD = "application/x-openworkgraph-nodes";
const trustedPayloads = new Set<string>();
const scopeReaders = new Map<string, Request>();
const clipboardReaders = new Map<string, Request>();
const scopeKey = (scope: ClipboardScope) => JSON.stringify([scope.serviceId, scope.projectId, scope.graphId]);
/** Host-only readers are never serialized into the system clipboard. */
export function registerClipboardRequest(scope: ClipboardScope, request: Request): void {
  scopeReaders.set(scopeKey(scope), request);
  if (scopeReaders.size > 32) scopeReaders.delete(scopeReaders.keys().next().value!);
}
export interface VisualizePasteIntent { node: Node; source: ClipboardScope; target: ClipboardScope; reader?: Request }
const visualizePasteIntents = new Map<string, VisualizePasteIntent>();
/** Node IDs survive the history controller's structuredClone; authority does not. */
export function takeVisualizePasteIntents(operations: GraphOperation[], target: ClipboardScope): VisualizePasteIntent[] {
  return operations.flatMap(operation => {
    if (operation.type !== 'node.create' || operation.node.type !== 'visualize' || !validateVisualizeNodeContent(operation.node.content).page) return [];
    const intent = visualizePasteIntents.get(operation.node.id);
    if (!intent || scopeKey(intent.target) !== scopeKey(target) || JSON.stringify(intent.node) !== JSON.stringify(operation.node)) throw Error(translate('The visualization paste intent expired. Copy and paste the nodes again.'));
    visualizePasteIntents.delete(operation.node.id);
    return [intent];
  });
}
const kinds = new Set([
  "text",
  "document",
  "execution",
  "group",
  "image",
  "video",
  "file",
  "preview",
  "visualize",
]);
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error(translate("Invalid node clipboard object."));
  return v as Record<string, unknown>;
};
const fields = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw Error(translate("The clipboard contains unsupported fields, resources, or provenance."));
};
const id = (v: unknown): string => {
  if (typeof v !== "string" || !v || v.length > 128)
    throw Error(translate("Invalid clipboard node ID."));
  return v;
};
const position = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9)
    throw Error(translate("Invalid clipboard coordinates."));
  return v;
};

/** Extract data, never executable code or resource identities. */
export function clipboardContent(
  node: Pick<Node, "type" | "schemaVersion" | "content">,
  strict = false,
): Record<string, Json> {
  if (node.schemaVersion !== 1 || !kinds.has(node.type))
    throw Error(translate("Structured copying is not supported for this node type or schema yet."));
  const raw = object(node.content);
  const skillReferences = raw.skillReferences === undefined ? undefined : validSkillReferences(typeof raw.prompt === 'string' ? raw.prompt : '', raw.skillReferences);
  if (skillReferences && (!Array.isArray(raw.skillReferences) || skillReferences.length !== raw.skillReferences.length)) throw Error(translate("Invalid skill references."));
  const skillContent: Record<string, Json> = skillReferences ? { skillReferences: skillReferences.map(ref => ({ ...ref })) } : {};
  if (node.type === 'visualize') {
    const content = validateVisualizeNodeContent(raw);
    return { ...content, ...skillContent } as unknown as Record<string, Json>;
  }
  // Execution copies start fresh, including when reading an older clipboard.
  // Never carry run history, outputs, resource identities or model overrides.
  if (node.type === "execution") {
    if (raw.features !== undefined && (!Array.isArray(raw.features) || raw.features.length > 1 || raw.features.some(feature => !isVisualizeFeatureSelection(feature)))) throw Error(translate('Invalid clipboard feature identity.'));
    const features: Record<string, Json> = raw.features === undefined ? {} : { features: structuredClone(raw.features) as Json };
    if (raw.prompt === undefined) return features;
    if (typeof raw.prompt !== "string")
      throw Error(translate("Clipboard text fields must be strings."));
    return { prompt: raw.prompt, ...skillContent, ...features };
  }
  // A generated text node may retain its immutable Markdown output. Clipboard
  // copies are editable text copies, so leave that graph-scoped resource behind.
  const c = node.type === "text" && raw.generatedOutput !== undefined
    ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "generatedOutput")) as Record<string, Json>
    : raw;
  if (
    [
      "resourceId",
      "resourceVersion",
      "assetRef",
      "assetId",
      "resource",
      "resources",
    ].some((k) => k in c)
  )
    throw Error(translate("Resource identities cannot be recreated directly. Use the separate resource copy flow."));
  const allowed =
    node.type === "group"
      ? ["title"]
      : ["title", "text", "prompt", "summary", "modelOverride", "skillReferences"];
  if (strict) fields(c, allowed);
  const result: Record<string, Json> = {};
  for (const k of allowed.filter((k) => k !== "modelOverride" && k !== "skillReferences")) {
    if (c[k] === undefined) continue;
    if (typeof c[k] !== "string") throw Error(translate("Clipboard text fields must be strings."));
    result[k] = c[k];
  }
  if (node.type !== "group" && c.modelOverride !== undefined) {
    if (c.modelOverride === null) result.modelOverride = null;
    else {
      const m = object(c.modelOverride);
      fields(m, ["model", "reasoningEffort"]);
      if (
        typeof m.model !== "string" ||
        !m.model ||
        (m.reasoningEffort !== null &&
          m.reasoningEffort !== undefined &&
          typeof m.reasoningEffort !== "string")
      )
        throw Error(translate("Invalid model override settings."));
      result.modelOverride = {
        model: m.model,
        reasoningEffort: (m.reasoningEffort as string | null) ?? null,
      };
    }
  }
  return { ...result, ...skillContent };
}

interface ClipboardNode {
  id: string;
  type: string;
  schemaVersion: 1;
  content: Record<string, Json>;
  x: number;
  y: number;
  width?: number;
  height?: number;
  memberIds?: string[];
}
export interface ClipboardScope {
  serviceId: string;
  projectId: string;
  graphId: string;
}
interface Payload {
  format: "openworkgraph-real-nodes";
  version: 1;
  source: ClipboardScope;
  nodes: ClipboardNode[];
  edges: {
    id: string;
    sourceId: string;
    targetId: string;
    kind: "reference" | "execution";
  }[];
}

interface ProjectFilePasteCopy {
  created: CanvasCreated;
  type: 'image' | 'text' | 'file';
  text: string;
}

export function assertResourcePasteTarget(raw: string, target: ClipboardScope): void {
  const payload = parseNodeClipboard(raw);
  const hasResources = payload.nodes.some(
    (node) => typeof node.content.resourceId === "string",
  );
  if (
    hasResources &&
    (payload.source.serviceId !== target.serviceId ||
      payload.source.projectId !== target.projectId)
  )
    throw Error(
      translate("Pasting resources across Workspaces or projects is not supported. Use Work Graph export and import. No resources were created."),
    );
}

function validTrustedProjectSource(raw: string, payload: Payload, source: Record<string, Json>): boolean {
  return trustedPayloads.has(raw) &&
    payload.source.serviceId === source.serviceId &&
    payload.source.projectId === source.projectId;
}
export function contentWithResource(
  node: Pick<Node, "type" | "schemaVersion" | "content">,
  strict = false,
): Record<string, Json> {
  if (node.type === 'visualize') return clipboardContent(node, strict);
  if (node.type === "execution") return clipboardContent(node, strict);
  const c = object(node.content);
  const source = c.source === undefined ? undefined : object(c.source);
  if (source?.kind === 'project-file' || source?.kind === 'project-file-empty') {
    if (strict) fields(c, ['title','text','prompt','summary','modelOverride','skillReferences','mime','bytes','source','observation']);
    fields(source, source.kind === 'project-file' ? ['kind','serviceId','projectId','relativePath'] : ['kind','relativePath']);
    if (typeof source.relativePath !== 'string' || (source.kind === 'project-file' && (typeof source.serviceId !== 'string' || typeof source.projectId !== 'string'))) throw Error(translate("The project file reference clipboard is invalid."));
    const plain = { ...c }; delete plain.source; delete plain.observation; delete plain.mime; delete plain.bytes;
    const result = clipboardContent({ ...node, content: plain as Json }, strict);
    return { ...result, ...(typeof c.mime === 'string' ? { mime:c.mime } : {}), ...(typeof c.bytes === 'number' ? { bytes:c.bytes } : {}), source:structuredClone(source) as Json };
  }
  if (c.resourceId === undefined && c.resourceVersion === undefined)
    return clipboardContent(node, strict);
  if (node.type === "group")
    throw Error(translate("This node type cannot carry clipboard resources."));
  if (strict)
    fields(c, [
      "title",
      "text",
      "prompt",
      "summary",
      "modelOverride",
      "skillReferences",
      "resourceId",
      "resourceVersion",
      "mime",
      "bytes",
    ]);
  const resourceId = id(c.resourceId);
  if (
    !Number.isSafeInteger(c.resourceVersion) ||
    (c.resourceVersion as number) < 1
  )
    throw Error(translate("Clipboard resources must specify an exact version."));
  const {
    resourceId: _id,
    resourceVersion: _version,
    mime: _mime,
    bytes: _bytes,
    ...text
  } = c;
  const safe = clipboardContent({ ...node, content: text as Json }, strict);
  if (c.mime !== undefined && typeof c.mime !== "string")
    throw Error(translate("Invalid resource MIME type."));
  if (c.bytes !== undefined && (!Number.isSafeInteger(c.bytes) || (c.bytes as number) < 0))
    throw Error(translate("Invalid resource size."));
  return {
    ...safe,
    resourceId,
    resourceVersion: c.resourceVersion as number,
    ...(typeof c.mime === "string" ? { mime: c.mime } : {}),
    ...(typeof c.bytes === "number" ? { bytes: c.bytes } : {}),
  };
}

export function encodeNodeClipboard(
  graph: GraphSnapshot,
  selected: string[],
): string {
  const ids = new Set(selected);
  if (!ids.size) throw Error(translate("Select nodes to copy."));
  for (const selectedId of selected) {
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (!node) throw Error(translate("A node selected for copying no longer exists."));
    if (node.type === "group")
      for (const member of node.memberIds ?? []) ids.add(member);
  }
  const nodes: ClipboardNode[] = [...ids].map((nodeId) => {
    const n = graph.nodes.find((n) => n.id === nodeId);
    if (!n) throw Error(translate("A group member no longer exists."));
    return {
      id: n.id,
      type: n.type,
      schemaVersion: 1,
      content: contentWithResource(n),
      x: n.x,
      y: n.y,
      ...(n.width === undefined ? {} : { width: n.width }),
      ...(n.height === undefined ? {} : { height: n.height }),
      ...(n.type === "group"
        ? { memberIds: (n.memberIds ?? []).filter((id) => ids.has(id)) }
        : {}),
    };
  });
  const edges = graph.edges
    .filter(
      (e) =>
        (e.kind === "reference" || e.kind === "execution") && ids.has(e.sourceId) && ids.has(e.targetId),
    )
    .map((e) => ({ ...e }));
  for (const node of nodes) if (node.type === 'visualize') {
    const content = validateVisualizeNodeContent(node.content);
    content.inputBindings = content.inputBindings.filter(binding => edges.some(edge => edge.id === binding.edgeId && edge.kind === 'reference' && edge.targetId === node.id));
    node.content = content as unknown as Record<string, Json>;
  }
  const source = {
    serviceId: graph.serviceId,
    projectId: graph.projectId,
    graphId: graph.graphId,
  };
  const raw = JSON.stringify({
    format: "openworkgraph-real-nodes",
    version: 1,
    source,
    nodes,
    edges,
  });
  parseNodeClipboard(raw); // Validate group and edge topology before writing.
  trustedPayloads.add(raw);
  const reader = scopeReaders.get(scopeKey(source));
  if (reader) clipboardReaders.set(raw, reader);
  if (trustedPayloads.size > 32) { const expired = trustedPayloads.values().next().value!; trustedPayloads.delete(expired); clipboardReaders.delete(expired); }
  return raw;
}

export function parseNodeClipboard(raw: string): Payload {
  if (raw.length > 1024 * 1024) throw Error(translate("The node clipboard exceeds the 1 MiB limit."));
  const value = object(JSON.parse(raw));
  fields(value, ["format", "version", "source", "nodes", "edges"]);
  const sourceValue = object(value.source);
  fields(sourceValue, ["serviceId", "projectId", "graphId"]);
  const source = {
    serviceId: id(sourceValue.serviceId),
    projectId: id(sourceValue.projectId),
    graphId: id(sourceValue.graphId),
  };
  if (
    value.format !== "openworkgraph-real-nodes" ||
    value.version !== 1 ||
    !Array.isArray(value.nodes) ||
    !value.nodes.length ||
    value.nodes.length > 100 ||
    !Array.isArray(value.edges) ||
    value.edges.length > 200
  )
    throw Error(translate("Unsupported node clipboard format or item count."));
  const nodes: ClipboardNode[] = value.nodes.map((value) => {
    const n = object(value);
    fields(n, [
      "id",
      "type",
      "schemaVersion",
      "content",
      "x",
      "y",
      "width",
      "height",
      "memberIds",
    ]);
    if (typeof n.type !== "string" || n.schemaVersion !== 1)
      throw Error(translate("Unknown node schema. It will not be migrated automatically."));
    const result: ClipboardNode = {
      id: id(n.id),
      type: n.type,
      schemaVersion: 1,
      content: contentWithResource(
        { type: n.type, schemaVersion: 1, content: n.content as Json },
        true,
      ),
      x: position(n.x),
      y: position(n.y),
    };
    for (const dimension of ["width", "height"] as const)
      if (n[dimension] !== undefined) {
        const size = position(n[dimension]);
        if (size <= 0) throw Error(translate("Clipboard dimensions must be positive."));
        result[dimension] = size;
      }
    if (n.memberIds !== undefined) {
      if (n.type !== "group" || !Array.isArray(n.memberIds))
        throw Error(translate("Only groups can declare members."));
      result.memberIds = n.memberIds.map(id);
    }
    return result;
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw Error(translate("Duplicate node ID."));
  const members = new Set<string>();
  for (const group of nodes.filter((n) => n.type === "group"))
    for (const member of group.memberIds ?? []) {
      if (
        !byId.has(member) ||
        byId.get(member)!.type === "group" ||
        members.has(member)
      )
        throw Error(translate("Groups are nested, overlapping, or missing members."));
      members.add(member);
    }
  const edgeIds = new Set<string>();
  const incoming = new Map<string, number>();
  const edges = value.edges.map((value) => {
    const e = object(value);
    fields(e, ["id", "sourceId", "targetId", "kind"]);
    if (e.kind !== "reference" && e.kind !== "execution") throw Error(translate("Unsupported connection type."));
    const edge: Payload['edges'][number] = {
      id: id(e.id),
      sourceId: id(e.sourceId),
      targetId: id(e.targetId),
      kind: e.kind,
    };
    const source = byId.get(edge.sourceId),
      target = byId.get(edge.targetId);
    if (
      edge.sourceId === edge.targetId ||
      edgeIds.has(edge.id) ||
      !source ||
      !target ||
      source.type === "group" ||
      (edge.kind === "execution" ? source.type !== "execution" || target.type !== "execution" : source.type === "execution") ||
      !["text", "image", "execution", "file", "preview", "visualize"].includes(target.type)
    )
      throw Error(translate("Unsupported connection or provenance. No delivery relationship will be created."));
    if (edge.kind === "reference") {
      const previewError = previewEdgeError(source.type, target.type, incoming.get(target.id) ?? 0);
      if (previewError) throw Error(previewError);
      incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1);
      if (incoming.get(target.id)! > 8) throw Error(translate('A node can have at most 8 direct predecessors.'));
    }
    edgeIds.add(edge.id);
    return edge;
  });
  if (!executionOrder(edges)) throw Error(translate("Sequence connections cannot form a cycle."));
  for (const node of nodes) if (node.type === 'visualize' && validateVisualizeNodeContent(node.content).inputBindings.some(binding => !edges.some(edge => edge.id === binding.edgeId && edge.kind === 'reference' && edge.targetId === node.id))) throw Error(translate('Visualization bindings must name incoming reference edges of the node.'));
  return {
    format: "openworkgraph-real-nodes",
    version: 1,
    source,
    nodes,
    edges,
  };
}

export function planNodePaste(
  raw: string,
  at: { x: number; y: number },
  newId: () => string = () => randomId(),
  copies?: Map<string, CanvasCreated>,
  target?: ClipboardScope,
  projectCopies?: Map<string, ProjectFilePasteCopy>,
): { operations: GraphOperation[]; nodeIds: string[] } {
  const payload = parseNodeClipboard(raw);
  const ids = new Map(payload.nodes.map((n) => [n.id, newId()]));
  const edgeIds = new Map(payload.edges.map(edge => [edge.id, newId()]));
  const left = Math.min(...payload.nodes.map((n) => n.x)),
    top = Math.min(...payload.nodes.map((n) => n.y));
  const nodes: Node[] = payload.nodes.map((n) => {
    let content = n.content;
    let type = n.type;
    const source = content.source && typeof content.source === 'object' && !Array.isArray(content.source) ? content.source : undefined;
    const projectCopy = projectCopies?.get(n.id);
    if (projectCopy) {
      type = projectCopy.type;
      content = {
        title: projectCopy.created.resource.name,
        text: projectCopy.text,
        prompt: '',
        resourceId: projectCopy.created.resource.id,
        resourceVersion: projectCopy.created.resource.current.version,
        mime: projectCopy.created.resource.current.mime,
        ...(projectCopy.type === 'file' ? { bytes: projectCopy.created.resource.current.bytes } : {}),
      };
    } else if (source?.kind === 'project-file' && (!target || payload.source.serviceId !== target.serviceId || payload.source.projectId !== target.projectId || !validTrustedProjectSource(raw, payload, source))) content = emptyProjectFileContent(content);
    if (!target || payload.source.serviceId !== target.serviceId) content = portableSkillContent(content);
    if (n.type === 'visualize') {
      const visualize = validateVisualizeNodeContent(content);
      visualize.inputBindings = visualize.inputBindings.map(binding => ({ ...binding, edgeId: edgeIds.get(binding.edgeId)! }));
      content = visualize as unknown as Record<string, Json>;
    }
    if (!projectCopy && typeof content.resourceId === "string") {
      const created = copies?.get(n.id);
      if (!created)
        throw Error(
          translate("The resource must first be copied independently through copy-resource. The source reference cannot be pasted directly."),
        );
      content = {
        ...content,
        resourceId: created.resource.id,
        resourceVersion: created.resource.current.version,
        mime: created.resource.current.mime,
        bytes: created.resource.current.bytes,
      };
    }
    return {
      ...n,
      type,
      content,
      id: ids.get(n.id)!,
      contentVersion: 1,
      readOnly: false,
      x: position(at.x + n.x - left),
      y: position(at.y + n.y - top),
      ...(type === "group"
        ? { memberIds: (n.memberIds ?? []).map((id) => ids.get(id)!) }
        : {}),
    };
  });
  const operations: GraphOperation[] = nodes
    .sort((a, b) => Number(a.type === "group") - Number(b.type === "group"))
    .map((node) => ({ type: "node.create", node }));
  operations.push(
    ...payload.edges.map((edge) => ({
      type: "edge.create" as const,
      edge: {
        ...edge,
        id: edgeIds.get(edge.id)!,
        sourceId: ids.get(edge.sourceId)!,
        targetId: ids.get(edge.targetId)!,
      },
    })),
  );
  for (const node of nodes) if (node.type === 'visualize' && validateVisualizeNodeContent(node.content).page) {
    if (!target) throw Error(translate('Pasting a visualization page requires a target Work Graph.'));
    const sameWorkspace = payload.source.serviceId === target.serviceId && payload.source.projectId === target.projectId;
    const reader = clipboardReaders.get(raw);
    if (!sameWorkspace && !reader) throw Error(translate('The source Workspace connection for the visualization copy is unavailable.'));
    visualizePasteIntents.set(node.id, { node: structuredClone(node), source: payload.source, target: { ...target }, ...(reader ? { reader } : {}) });
    if (visualizePasteIntents.size > 256) visualizePasteIntents.delete(visualizePasteIntents.keys().next().value!);
  }
  return { operations, nodeIds: [...ids.values()] };
}

/** Owns all unknown copy keys and the prepared placement closure until success.
 * Retrying does not re-copy already acknowledged resources or generate node IDs. */
export function createResourcePasteJob(
  raw: string,
  target: ClipboardScope,
  at: { x: number; y: number },
  request: Request,
  prepare: (operations: GraphOperation[]) => () => Promise<GraphSnapshot>,
  newId: () => string = () => randomId(),
  onProgress: (completed: number, total: number) => void = () => {},
) {
  const payload = parseNodeClipboard(raw);
  const resources = payload.nodes.filter(
    (n) => typeof n.content.resourceId === "string",
  );
  const projectFiles = payload.nodes.filter((n) => {
    const source = n.content.source;
    return source && typeof source === 'object' && !Array.isArray(source) && source.kind === 'project-file';
  });
  if (!resources.length && !projectFiles.length && !payload.nodes.some(node => node.type === 'visualize' && validateVisualizeNodeContent(node.content).page)) throw Error(translate("This clipboard does not require the resource copy flow."));
  if (resources.length) assertResourcePasteTarget(raw, target);
  if (projectFiles.some(n => {
    const source = n.content.source;
    return !source || typeof source !== 'object' || Array.isArray(source) || !validTrustedProjectSource(raw, payload, source);
  }))
    throw Error(translate("An untrusted reference-node clipboard cannot read project files. No resources were created."));
  if (projectFiles.length && payload.source.serviceId !== target.serviceId)
    throw Error(translate("Pasting reference nodes across Workspaces is not supported. Use Work Graph export and import. No resources were created."));
  const copies = new Map<string, CanvasCreated>();
  const projectCopies = new Map<string, ProjectFilePasteCopy>();
  const projectStatuses = new Map<string, { mime: string }>();
  const jobs = resources.map((n) => ({
    nodeId: n.id,
    kind: 'resource' as const,
    body: {
      sourceGraphId: payload.source.graphId,
      resourceId: n.content.resourceId,
      version: n.content.resourceVersion,
      idempotencyKey: newId(),
    },
  }));
  const projectJobs = projectFiles.map((n) => {
    const source = n.content.source as { kind: 'project-file'; serviceId: string; projectId: string; relativePath: string };
    return {
      nodeId: n.id,
      kind: 'project-file' as const,
      body: {
        sourceProjectId: source.projectId,
        path: source.relativePath,
        mime: typeof n.content.mime === 'string' ? n.content.mime : 'application/octet-stream',
        name: typeof n.content.title === 'string' && n.content.title.trim() ? n.content.title : source.relativePath.split('/').at(-1) ?? translate("Project file"),
        idempotencyKey: newId(),
      },
    };
  });
  const total = jobs.length + projectJobs.length;
  let plan: ReturnType<typeof planNodePaste> | undefined;
  let place: (() => Promise<GraphSnapshot>) | undefined;
  let running: Promise<string[]> | undefined;
  let complete = false;
  async function run(assertCurrent: () => void) {
    assertCurrent();
    if (complete) return plan!.nodeIds;
    onProgress(copies.size + projectCopies.size, total);
    projectStatuses.clear();
    for (const job of projectJobs)
      if (!projectCopies.has(job.nodeId)) {
        assertCurrent();
        const [status] = await request<Array<{ state: 'available' | 'missing' | 'unavailable'; mime: string | null; bytes: number | null }>>(
          '/v1/projects/' + encodeURIComponent(job.body.sourceProjectId) + '/files/stat',
          { paths:[job.body.path] },
        );
        if (!status || status.state !== 'available')
          throw Error(status?.state === 'missing' ? translate("The project file no longer exists and cannot be copied as a resource node.") : translate("The project file is currently unavailable and cannot be copied as a resource node."));
        if (status.bytes === null || !Number.isSafeInteger(status.bytes) || status.bytes < 0)
          throw Error(translate("The project file size could not be verified, so it cannot be copied as a resource node."));
        if (status.bytes > FILE_NODE_MAX_BYTES)
          throw Error(translate("Files larger than 300 MB cannot be copied as resource nodes."));
        projectStatuses.set(job.nodeId, { mime:status.mime ?? job.body.mime });
      }
    for (const job of jobs)
      if (!copies.has(job.nodeId)) {
        assertCurrent();
        const created = await request<CanvasCreated>(
          graphPath(target.projectId, target.graphId) +
            "/resources/copy-resource",
          job.body,
        );
        // Retain acknowledged copies even when the user's attempt expired while
        // awaiting the response. Explicit resume must not create them twice.
        copies.set(job.nodeId, created);
        onProgress(copies.size + projectCopies.size, total);
        assertCurrent();
      }
    for (const job of projectJobs)
      if (!projectCopies.has(job.nodeId)) {
        assertCurrent();
        const created = await request<CanvasCreated>(
          graphPath(target.projectId, target.graphId) + '/resources/import-file',
          { ...job.body, mime:projectStatuses.get(job.nodeId)?.mime ?? job.body.mime },
        );
        const type = importedNodeType(job.body.path, created.resource.current.mime);
        const representation = type === 'text' ? await request<{ state: string; text: string | null }>(
          graphPath(target.projectId, target.graphId) + '/resources/' + encodeURIComponent(created.resource.id) + '/versions/' + created.resource.current.version + '/representation',
        ) : undefined;
        if (type === 'text' && (representation?.state !== 'ready' || representation.text === null)) throw Error(translate("The text resource cannot be copied as a text node."));
        const representationText = representation?.state === 'ready' && representation.text !== null ? representation.text : '';
        const text = new Blob([JSON.stringify(representationText)]).size <= 2 * 1024 * 1024 - 2048 ? representationText : '';
        projectCopies.set(job.nodeId, {
          created,
          type,
          text,
        });
        onProgress(copies.size + projectCopies.size, total);
        assertCurrent();
      }
    assertCurrent();
    plan ??= planNodePaste(raw, at, newId, copies, target, projectCopies);
    place ??= prepare(plan.operations);
    assertCurrent();
    await place();
    complete = true;
    assertCurrent();
    return plan.nodeIds;
  }
  // One ticket per explicit attempt; a concurrent caller cannot replace the
  // guard of an in-flight attempt. The default preserves non-UI API callers.
  return {
    run(assertCurrent: () => void = () => {}) {
      return (running ??= run(assertCurrent).finally(() => {
        running = undefined;
      }));
    },
  };
}

/** Uses public page writes for Workspace copies and an atomic local snapshot
 * transaction for temporary copies. No source delivery authority is replayed. */
export function createVisualizePasteWorkflow(
  intents: VisualizePasteIntent[], operations: GraphOperation[], target: ClipboardScope, request: Request,
  place: () => Promise<GraphSnapshot>, readGraph: () => GraphSnapshot, accept: (graph: GraphSnapshot) => void,
) {
  type DependencyCopy = { reference: VisualizeResourceReference; blob: Blob; key: string; created?: CanvasCreated; upload?: string };
  const plans = intents.map(intent => ({ intent, content: validateVisualizeNodeContent(intent.node.content), page: undefined as VisualizePagePackage | undefined, dependencies: [] as DependencyCopy[], bytes: 0, ready: false, phases: new Map<string, { body?: Record<string, unknown>; result?: VisualizeStoredNode; key: string }>() }));
  const localKey = randomId();
  let localBody: unknown;
  let localResult: GraphSnapshot | undefined;
  let placed: GraphSnapshot | undefined;
  let resized: GraphSnapshot | undefined;
  let ownAcceptedGraph: GraphSnapshot | undefined;
  let recoveryError: unknown;
  let rollbackBody: Record<string, unknown> | undefined;
  let rolledBack = false;
  let placementAttempted = false;
  const definiteLocalErrors = new WeakSet<object>();
  const retry = async <T>(work: () => Promise<T>, guard: () => void): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      guard();
      try { return await work(); } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
        if (attempt >= 2 || (code && !['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(code) && status < 500)) throw error;
      }
    }
  };
  const refresh = async (guard: () => void) => {
    guard();
    const graph = await request<GraphSnapshot>(graphPath(target.projectId, target.graphId));
    guard(); accept(graph); return graph;
  };
  let resize: (() => Promise<GraphSnapshot>) | undefined;
  const releasePrepared = async (guard: () => void) => {
    for (const plan of plans) for (const copy of plan.dependencies) {
      if (copy.created) {
        try {
          await retry(() => request(graphPath(target.projectId, target.graphId) + '/resources/release', { referenceId: copy.created!.referenceId, idempotencyKey: copy.key + '-release' }), guard);
        } catch (error) {
          // Only graph holds can be released, never node/history ownership.
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'NOT_FOUND') throw error;
        }
      } else if (copy.upload) {
        await retry(() => request('/v1/projects/' + encodeURIComponent(target.projectId) + '/uploads/' + encodeURIComponent(copy.upload!) + '/cancel', { idempotencyKey: copy.key + '-cancel' }), guard);
      }
    }
  };
  const rollback = async (guard: () => void) => {
    if (!placed) {
      if (placementAttempted) {
        // An unacknowledged creation must not be mistaken for an empty graph.
        // Do not derive ownership from a fresh snapshot and delete user data.
        const current = await refresh(guard);
        const ids = new Set(operations.flatMap(operation => operation.type === 'node.create' ? [operation.node.id] : []));
        if (current.nodes.some(node => ids.has(node.id))) throw recoveryError;
      }
      await releasePrepared(guard);
      rolledBack = true;
      return;
    }
    // Never rebase a compensating delete: a concurrent edit must prevent it.
    // Keep the exact body after a lost response so cleanup itself is replayable.
    if (!rollbackBody) {
      const current = await refresh(guard);
      const ids = new Set(operations.flatMap(operation => operation.type === 'node.create' ? [operation.node.id] : []));
      const baseline = ownAcceptedGraph!;
      for (const id of ids) {
        const before = baseline.nodes.find(node => node.id === id);
        const now = current.nodes.find(node => node.id === id);
        if (!now || JSON.stringify(now) !== JSON.stringify(before)) throw recoveryError;
      }
      const touching = (graph: GraphSnapshot) => graph.edges.filter(edge => ids.has(edge.sourceId) || ids.has(edge.targetId));
      if (JSON.stringify(touching(current)) !== JSON.stringify(touching(baseline))) throw recoveryError;
      const groups = (graph: GraphSnapshot) => graph.nodes.filter(node => node.memberIds?.some(id => ids.has(id)));
      if (JSON.stringify(groups(current)) !== JSON.stringify(groups(baseline))) throw recoveryError;
      rollbackBody = { idempotencyKey: randomId(), expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: current.layoutRevision, operations: [...ids].map(nodeId => ({ type: 'node.delete', nodeId })) };
    }
    const result = await retry(() => request<GraphSnapshot>(graphPath(target.projectId, target.graphId) + '/commands', rollbackBody), guard);
    guard(); accept(result);
    await releasePrepared(guard);
    await refresh(guard);
    rolledBack = true;
  };
  const run = async (guard: () => void, prepareResize: (operations: GraphOperation[]) => () => Promise<GraphSnapshot>): Promise<GraphSnapshot> => {
    // Check every source snapshot before preparing any target resource or node.
    let sourceBytes = plans.filter(plan => plan.ready).reduce((total, plan) => total + plan.bytes, 0);
    for (const plan of plans) if (!plan.ready) {
      let bytes = 0;
      const reader = plan.intent.source.serviceId === target.serviceId && plan.intent.source.projectId === target.projectId ? request : plan.intent.reader;
      if (!reader) throw Error(translate('The source Workspace connection for the visualization copy is unavailable.'));
      const resources = new Map<string, { name: string; blob: Blob }>();
      for (const reference of visualizeResourceReferences(plan.content)) {
        guard();
        const blob = await reader<Blob>(graphPath(plan.intent.source.projectId, plan.intent.source.graphId) + '/resources/' + encodeURIComponent(reference.resourceId) + '/versions/' + reference.resourceVersion + '/content', undefined, 'BLOB');
        guard();
        if (!(blob instanceof Blob) || blob.size > FILE_NODE_MAX_BYTES) throw Error(translate('The visualization copy resource is invalid or exceeds the size limit.'));
        bytes += blob.size; sourceBytes += blob.size;
        if (sourceBytes > WORKGRAPH_TRANSFER_TOTAL_BYTES) throw Error(translate('The Work Graph resources exceed the export limit.'));
        resources.set(JSON.stringify([reference.resourceId, reference.resourceVersion]), { name: reference.resourceId, blob });
      }
      const pages = await validateTemporaryVisualizeResources([plan.intent.node], resources);
      guard();
      plan.page = pages.get(JSON.stringify([plan.content.page!.resource.resourceId, plan.content.page!.resource.resourceVersion]))!;
      const fixedJson = new Set([plan.content.page!.resource, plan.content.form!.resource].map(reference => JSON.stringify([reference.resourceId, reference.resourceVersion])));
      plan.dependencies = visualizeResourceReferences(plan.content).filter(reference => !fixedJson.has(JSON.stringify([reference.resourceId, reference.resourceVersion])))
        .map(reference => ({ reference, blob: resources.get(JSON.stringify([reference.resourceId, reference.resourceVersion]))!.blob, key: randomId() }));
      plan.bytes = bytes;
      plan.ready = true;
    }
    if (plans.reduce((total, plan) => total + plan.dependencies.reduce((size, dependency) => size + dependency.blob.size, 0), 0) > WORKGRAPH_TRANSFER_TOTAL_BYTES) throw Error(translate('The Work Graph resources exceed the export limit.'));
    for (const plan of plans) for (const copy of plan.dependencies) if (!copy.created) {
      guard();
      if (target.serviceId === 'browser-local') {
        // Stage local dependencies in memory; commit them with nodes/pages.
        const id = randomId();
        copy.created = { resource: { id, name: copy.reference.resourceId, current: { version: 1, mime: copy.blob.type, bytes: copy.blob.size } }, referenceId: id };
      } else if (plan.intent.source.serviceId === target.serviceId && plan.intent.source.projectId === target.projectId) {
        copy.created = await retry(() => request<CanvasCreated>(graphPath(target.projectId, target.graphId) + '/resources/copy-resource', { sourceGraphId: plan.intent.source.graphId, resourceId: copy.reference.resourceId, version: copy.reference.resourceVersion, idempotencyKey: copy.key }), guard);
      } else {
        const base = '/v1/projects/' + encodeURIComponent(target.projectId) + '/uploads';
        if (!copy.upload) {
          const upload = await retry(() => request<{ uploadId: string }>(base, { name: copy.reference.resourceId, mime: copy.blob.type, bytes: copy.blob.size, idempotencyKey: copy.key + '-start' }), guard);
          copy.upload = upload.uploadId;
        }
        const path = base + '/' + encodeURIComponent(copy.upload);
        guard();
        const status = await request<{ received: number; bytes: number; state: string }>(path);
        guard();
        if (status.bytes !== copy.blob.size || !Number.isSafeInteger(status.received) || status.received < 0 || status.received > status.bytes || !['uploading', 'finished'].includes(status.state)) {
          const error = Error(translate('The visualization upload state changed. Verify the copy before retrying.'));
          definiteLocalErrors.add(error); throw error;
        }
        for (let offset = status.received; offset < copy.blob.size; offset += 1024 * 1024) {
          const bytes = new Uint8Array(await copy.blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          await retry(() => request(path + '/chunks', { offset, data: btoa(binary), idempotencyKey: copy.key + '-chunk-' + offset }), guard);
        }
        copy.created = await retry(() => request<CanvasCreated>(path + '/finish', { mode: 'canvas', name: copy.reference.resourceId, graphId: target.graphId, idempotencyKey: copy.key + '-finish' }), guard);
      }
      guard();
    }
    const pages = plans.map(plan => {
      const mapping = new Map(plan.dependencies.map(copy => [JSON.stringify([copy.reference.resourceId, copy.reference.resourceVersion]), { resourceId: copy.created!.resource.id, resourceVersion: copy.created!.resource.current.version }]));
      return { nodeId: plan.intent.node.id, page: remapTemporaryVisualizePage(plan.page, mapping),
        form: remapTemporaryVisualizeAssetData(plan.content.form!.data, mapping),
        dependencies: plan.content.page!.dependencies.map(reference => mapping.get(JSON.stringify([reference.resourceId, reference.resourceVersion]))!) };
    });
    if (target.serviceId === 'browser-local') {
      if (!localResult) {
        localBody ??= { operations: operations.map(operation => {
          if (operation.type !== 'node.create' || operation.node.type !== 'visualize') return operation;
          const plan = plans.find(value => value.intent.node.id === operation.node.id);
          if (!plan) return operation;
          const content = structuredClone(plan.content);
          const copied = pages.find(value => value.nodeId === operation.node.id)!;
          content.page!.dependencies = copied.dependencies;
          content.form!.data = copied.form as { [key: string]: Json };
          return { ...operation, node: { ...operation.node, content: content as unknown as Json } };
        }), pages: pages.map(({ nodeId, page }) => ({ nodeId, page })), resources: plans.flatMap(plan => plan.dependencies.map(copy => ({ resourceId: copy.created!.resource.id, name: copy.reference.resourceId, blob: copy.blob }))), idempotencyKey: localKey, expectedExecutionRevision: readGraph().executionRevision, expectedLayoutRevision: readGraph().layoutRevision };
        try { localResult = await retry(() => request<GraphSnapshot>(graphPath(target.projectId, target.graphId) + '/visualize-paste', localBody), guard); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT') localBody = undefined;
          throw error;
        }
      }
      guard(); accept(localResult); return localResult;
    }
    guard(); placementAttempted = true; placed ??= await place();
    ownAcceptedGraph ??= structuredClone(placed);
    guard();
    for (const plan of plans) {
      const path = graphPath(target.projectId, target.graphId) + '/visualize/' + encodeURIComponent(plan.intent.node.id);
      for (const [action, extra] of [
        ['install-page', { page: pages.find(value => value.nodeId === plan.intent.node.id)!.page }],
        ['update-form', { form: pages.find(value => value.nodeId === plan.intent.node.id)!.form }],
        ['save-state', { state: plan.content.state!.data }],
      ] as const) {
        let phase = plan.phases.get(action);
        if (!phase) { phase = { key: randomId() }; plan.phases.set(action, phase); }
        if (phase.result) continue;
        if (!phase.body) {
          guard();
          const current = await request<VisualizeStoredNode>(path);
          guard();
          const previous = [...plan.phases.values()].filter(value => value.result).at(-1)?.result;
          const expected = previous ?? placed.nodes.find(node => node.id === plan.intent.node.id)!;
          if (current.contentVersion !== expected.contentVersion || JSON.stringify(current.content) !== JSON.stringify(expected.content)) throw Object.assign(Error(translate('The visualization copy changed before completion. Review the copy before retrying.')), { code: 'REVISION_CONFLICT' });
          phase.body = { action, ...extra, idempotencyKey: phase.key, expectedContentVersion: current.contentVersion, expectedExecutionRevision: current.executionRevision, expectedLayoutRevision: current.layoutRevision, expectedPageRevision: current.content.page?.revision ?? 0,
            ...(action === 'update-form' ? { expectedFormVersion: current.content.form!.version } : action === 'save-state' ? { expectedStateVersion: current.content.state!.version } : {}) };
        }
        try { phase.result = await retry(() => request<VisualizeStoredNode>(path, phase!.body), guard); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'REVISION_CONFLICT') phase.body = undefined;
          throw error;
        }
        // Track only this write's accepted effects, never adopt a later GET as
        // ownership evidence: it could already include another user's layout.
        const owned = ownAcceptedGraph.nodes.find(node => node.id === plan.intent.node.id)!;
        owned.content = structuredClone(phase.result.content) as unknown as Json;
        owned.contentVersion = phase.result.contentVersion;
        if (action === 'install-page') Object.assign(owned, phase.result.page?.layout ?? VISUALIZE_DEFAULT_SIZE);
        ownAcceptedGraph.executionRevision = phase.result.executionRevision;
        ownAcceptedGraph.layoutRevision = phase.result.layoutRevision;
        guard(); await refresh(guard);
      }
    }
    if (!resized) {
      resize ??= prepareResize([{ type: 'layout.resize', sizes: intents.map(intent => ({ nodeId: intent.node.id, width: intent.node.width ?? null, height: intent.node.height ?? null })) }]);
      guard(); resized = await resize();
      for (const intent of intents) {
        const owned = ownAcceptedGraph.nodes.find(node => node.id === intent.node.id)!;
        const accepted = resized.nodes.find(node => node.id === intent.node.id)!;
        // Preserve independently tracked content/position; accept our sizes.
        owned.width = accepted.width; owned.height = accepted.height;
      }
      ownAcceptedGraph.executionRevision = resized.executionRevision;
      ownAcceptedGraph.layoutRevision = resized.layoutRevision;
    }
    guard(); return await refresh(guard);
  };
  const recoveryMessage = () => Object.assign(Error(rolledBack
    ? translate('The failed visualization copy was removed. Copy and paste the nodes again.')
    : translate('The visualization copy could not be removed safely. Reconnect and retry cleanup, or review copies changed by another user.')), { cause: recoveryError, ...((recoveryError && typeof recoveryError === 'object' && 'code' in recoveryError) ? { code: recoveryError.code } : {}) });
  return { async run(guard: () => void, prepareResize: (operations: GraphOperation[]) => () => Promise<GraphSnapshot>): Promise<GraphSnapshot> {
    if (rolledBack) throw recoveryMessage();
    if (recoveryError) {
      try { await rollback(guard); } catch { /* Keep recovery pending with the original code. */ }
      throw recoveryMessage();
    }
    try { return await run(guard, prepareResize); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
      // An uncertain write may have committed; resume its original phase/key.
      // Definite failures compensate only copies still owned by this operation.
      const definite = (code && status < 500 && !['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE'].includes(code)) || (error instanceof Error && definiteLocalErrors.has(error));
      const prepared = plans.some(plan => plan.dependencies.some(copy => copy.created || copy.upload));
      if (target.serviceId !== 'browser-local' && (placed || prepared) && definite) {
        recoveryError = error;
        try { await rollback(guard); } catch { /* Retry cleanup before any further page writes. */ }
        throw recoveryMessage();
      }
      throw error;
    }
  } };
}
