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

export const REAL_NODE_CLIPBOARD = "application/x-openworkgraph-real-nodes";
export const LEGACY_NODE_CLIPBOARD = "application/x-openworkgraph-nodes";
const trustedPayloads = new Set<string>();
const kinds = new Set([
  "text",
  "document",
  "execution",
  "group",
  "image",
  "video",
  "file",
  "preview",
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
  // Execution copies start fresh, including when reading an older clipboard.
  // Never carry run history, outputs, resource identities or model overrides.
  if (node.type === "execution") {
    if (raw.prompt === undefined) return {};
    if (typeof raw.prompt !== "string")
      throw Error(translate("Clipboard text fields must be strings."));
    return { prompt: raw.prompt, ...skillContent };
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
  if (trustedPayloads.size > 32) trustedPayloads.delete(trustedPayloads.values().next().value!);
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
      !["text", "image", "execution", "file", "preview"].includes(target.type)
    )
      throw Error(translate("Unsupported connection or provenance. No delivery relationship will be created."));
    if (edge.kind === "reference") {
      const previewError = previewEdgeError(source.type, target.type, incoming.get(target.id) ?? 0);
      if (previewError) throw Error(previewError);
      incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1);
    }
    edgeIds.add(edge.id);
    return edge;
  });
  if (!executionOrder(edges)) throw Error(translate("Sequence connections cannot form a cycle."));
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
        id: newId(),
        sourceId: ids.get(edge.sourceId)!,
        targetId: ids.get(edge.targetId)!,
      },
    })),
  );
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
  if (!resources.length && !projectFiles.length) throw Error(translate("This clipboard does not require the resource copy flow."));
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
