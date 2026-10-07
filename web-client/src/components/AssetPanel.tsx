import { useRef, useState, useSyncExternalStore } from "react";
import { File, Plus, Upload, X } from "lucide-react";
import type {
  AssetVersion,
  WorkGraph,
  WorkNode,
  WorkgraphAdapter,
} from "../domain/types";
import { AssetPreviewContent } from "./NodeContent";
import { useI18n } from "../i18n/I18nProvider";

export interface AssetPanelProps {
  graph: WorkGraph;
  adapter: WorkgraphAdapter;
  onClose: () => void;
  onSelect: (node: WorkNode) => void;
  onError: (error: unknown) => void;
}

function inferMime(file: globalThis.File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
  };
  return known[extension] ?? "application/octet-stream";
}

function AssetCard({
  asset,
  adapter,
  onError,
  onPlace,
}: {
  asset: AssetVersion;
  adapter: WorkgraphAdapter;
  onError: (error: unknown) => void;
  onPlace: () => void;
}) {
  const { t } = useI18n();
  const kind = asset.mimeType.split("/")[0];
  return (
    <article className="asset-card">
      {["image", "video", "audio"].includes(kind) ? (
        <AssetPreviewContent
          assetRef={asset}
          adapter={adapter}
          kind={kind}
          title={asset.name}
          onError={onError}
        />
      ) : asset.text !== undefined ? (
        <pre className="node-text">
          {asset.text.slice(0, 500) || t("Empty text file")}
        </pre>
      ) : (
        <div className="document-card">
          <File size={24} />
          <p className="muted">{t("Preview is not available for this file")}</p>
        </div>
      )}
      <strong>{asset.name}</strong>
      <p className="muted">
        {asset.mimeType} ·{" "}
        {asset.size < 1024
          ? `${asset.size} B`
          : `${(asset.size / 1024).toFixed(1)} KB`}
      </p>
      <button className="secondary-button" onClick={onPlace}>
        <Plus size={14} />
        {t("Place on Work Graph")}
      </button>
    </article>
  );
}

export function AssetPanel({
  graph,
  adapter,
  onClose,
  onSelect,
  onError,
}: AssetPanelProps) {
  const { t } = useI18n();
  const snapshot = useSyncExternalStore(
    (listener) => adapter.subscribe(listener),
    () => adapter.getSnapshot(),
  );
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const latest = new Map<string, AssetVersion>();
  for (const asset of snapshot.assets) {
    if (
      asset.serviceId !== graph.serviceId ||
      asset.projectId !== graph.projectId
    )
      continue;
    const previous = latest.get(asset.assetId);
    if (!previous || previous.createdAt <= asset.createdAt)
      latest.set(asset.assetId, asset);
  }
  const assets = [...latest.values()].filter((asset) =>
    asset.name.toLowerCase().includes(search.toLowerCase()),
  );
  const importFiles = async (files: globalThis.File[]) => {
    if (importing || !files.length) return;
    setImporting(true);
    try {
      for (const file of files) {
        try {
          const mimeType = inferMime(file);
          await adapter.importAsset(graph.serviceId, graph.projectId, {
            name: file.name,
            mimeType,
            data: file,
          });
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      setImporting(false);
    }
  };
  return (
    <aside
      className="asset-panel panel"
      aria-label={t("Project assets")}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void importFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="panel-heading">
        <h2>{t("Assets")}</h2>
        <button
          className="icon-button"
          aria-label={t("Close asset panel")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <p className="muted">{t("Development file import · Current Workspace / Project")}</p>
      <p className="muted">
        {snapshot.services.find((service) => service.id === graph.serviceId)
          ?.name ?? graph.serviceId}{" "}
        /{" "}
        {snapshot.projects.find(
          (project) =>
            project.id === graph.projectId &&
            project.serviceId === graph.serviceId,
        )?.name ?? graph.projectId}
      </p>
      <input
        aria-label={t("Search assets")}
        placeholder={t("Search assets…")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <button
        className="primary-button"
        disabled={importing}
        onClick={() => input.current?.click()}
      >
        <Upload size={16} />
        {importing ? t("Importing…") : t("Import files")}
      </button>
      <p className="muted">
        {t("You can also drop files here. Text, images, video, and audio are supported; PDFs and other attachments show a placeholder.")}
      </p>
      <div className="asset-list">
        {assets.map((asset) => (
          <AssetCard
            key={`${asset.serviceId}:${asset.assetId}:${asset.versionId}`}
            asset={asset}
            adapter={adapter}
            onError={onError}
            onPlace={() => {
              try {
                onSelect(adapter.placeAsset(graph.id, asset));
              } catch (error) {
                onError(error);
              }
            }}
          />
        ))}
        {!assets.length && (
          <p className="muted">
            {search
              ? t("No matching assets.")
              : t("This project has no assets yet. Import files to place them on the Work Graph.")}
          </p>
        )}
      </div>
    </aside>
  );
}

export default AssetPanel;
