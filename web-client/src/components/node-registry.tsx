import type { ComponentType } from "react";
import {
  Eye,
  File,
  FileText,
  Image,
  Music,
  Play,
  PanelsTopLeft,
  StickyNote,
  Type,
  Video,
} from "lucide-react";
import type { Run, WorkNode, WorkgraphAdapter } from "../domain/types";
import { useI18n } from "../i18n/I18nProvider";

export interface NodeContentProps {
  node: WorkNode;
  adapter: WorkgraphAdapter;
  run?: Run;
  onOpen: (node: WorkNode) => void;
  onError: (error: unknown) => void;
}

export interface NodeDefinition {
  type: string;
  title: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  Content?: ComponentType<NodeContentProps>;
}

function DemoNote({ node, onOpen }: NodeContentProps) {
  const { t } = useI18n();
  return (
    <div className="document-card">
      <StickyNote size={24} />
      <strong>{node.title}</strong>
      <span className="node-text">
        {node.content || t("This note is provided through the node type registry.")}
      </span>
      <button className="secondary-button" onClick={() => onOpen(node)}>
        {t("Open note")}
      </button>
    </div>
  );
}

const builtInDefinitions: NodeDefinition[] = [
  { type: "text", title: "Text", icon: Type },
  { type: "image", title: "Image", icon: Image },
  { type: "document", title: "Document", icon: FileText },
  { type: "video", title: "Video", icon: Video },
  { type: "audio", title: "Audio", icon: Music },
  { type: "preview", title: "Preview", icon: Eye },
  { type: "file", title: "File", icon: File },
  { type: "execution", title: "Execution", icon: Play },
  { type: "visualize", title: "Visualize", icon: PanelsTopLeft },
  { type: "demo:note", title: "Example note", icon: StickyNote, Content: DemoNote },
];

// A registration owns its layer so out-of-order cleanup cannot resurrect an
// already-unregistered renderer or remove a newer plugin's definition.
const registry = new Map<string, NodeDefinition[]>(
  builtInDefinitions.map((definition) => [
    definition.type,
    [Object.freeze({ ...definition })],
  ]),
);
const listeners = new Set<() => void>();
let version = 0;

export function subscribeNodeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stable primitive snapshot for React.useSyncExternalStore. */
export function getNodeRegistryVersion(): number {
  return version;
}

function emitRegistryChange(): void {
  version++;
  for (const listener of [...listeners]) listener();
}

/** Register trusted application components; imported graph data never loads code. */
export function registerNodeType(definition: NodeDefinition): () => void {
  if (!definition.type.trim()) throw new Error("Node type cannot be empty");
  const registered = Object.freeze({ ...definition });
  const layers = registry.get(registered.type) ?? [];
  layers.push(registered);
  registry.set(registered.type, layers);
  emitRegistryChange();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    layers.splice(layers.indexOf(registered), 1);
    if (!layers.length) registry.delete(registered.type);
    emitRegistryChange();
  };
}

export function getNodeDefinition(type: string): NodeDefinition {
  return registry.get(type)?.at(-1) ?? { type, title: "Unknown type", icon: File };
}

export function listNodeDefinitions(): NodeDefinition[] {
  return [...registry.values()].map((layers) => ({
    ...layers[layers.length - 1],
  }));
}
