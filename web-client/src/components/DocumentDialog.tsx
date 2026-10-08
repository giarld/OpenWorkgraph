import { PreviewDialogHeading, PreviewDialogLayers, visibleDialogControls, type PreviewDialogNavigation } from './PreviewDialogStack';
import { MarkdownPreview, MarkdownPreviewProvider } from "../real/MarkdownPreview";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Copy, Save } from "lucide-react";
import type { WorkNode, WorkgraphAdapter } from "../domain/types";
import { hasTextContent } from "../domain/file-types";
import { AssetPreviewContent, ContentPlaceholder } from "./NodeContent";
import { useI18n } from "../i18n/I18nProvider";
import type { Request } from "../real/contracts";

export interface DocumentDialogProps {
  node: WorkNode;
  navigation?: PreviewDialogNavigation;
  adapter?: WorkgraphAdapter;
  initialPreview?: boolean;
  onDraft?: (patch: { title: string; content: string }) => void;
  saveStatus?: string;
  children?: ReactNode;
  onSave?: (patch: { title: string; content: string }) => void | Promise<void>;
  onCopy?: () => WorkNode | Promise<WorkNode>;
  onClose: () => void;
  onSelect: (node: WorkNode) => void;
  onError: (error: unknown) => void;
  onOpenLink?: (href: string, sourcePath?: string) => void;
  imageRequest?: Request;
  imageRevision?: number;
}

export function DocumentDialog(props: DocumentDialogProps) {
  return (
    <DocumentEditor
      key={`${props.node.serviceId}:${props.node.graphId}:${props.node.id}`}
      {...props}
    />
  );
}

function DocumentEditor({
  node,
  navigation,
  adapter,
  onSave,
  onDraft, saveStatus, children, initialPreview,
  onCopy,
  onClose,
  onSelect,
  onError,
  onOpenLink,
  imageRequest,
  imageRevision,
}: DocumentDialogProps) {
  const { t } = useI18n();
  const isMedia = ["image", "video", "audio"].includes(node.type);
  const isText = ["text", "document", "demo:note"].includes(node.type);
  const [draft, setDraft] = useState(node.content);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(initialPreview ?? false);
  const [readable, setReadable] = useState(isText && !node.assetRef);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const editing = isText && readable && !node.readonly && !preview;
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (dirty && !onDraft) return;
    if (!isText) {
      setReadable(false);
      return;
    }
    try {
      const asset = node.assetRef
        ? adapter?.readAsset(node.assetRef)
        : undefined;
      const canRead = !asset || hasTextContent(asset);
      setReadable(canRead);
      setDraft(canRead ? (asset?.text ?? node.content) : "");
    } catch (error) {
      setReadable(false);
      errorRef.current(error);
    }
  }, [
    adapter,
    isText,
    node.title,
    node.content,
    node.assetRef?.serviceId,
    node.assetRef?.assetId,
    node.assetRef?.versionId,
    dirty,
  ]);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const save = async () => {
    setSaving(true);
    try {
      if (onSave) await onSave({ title: node.title, content: draft });
      else if (adapter) adapter.updateNode(node.graphId, node.id, { title: node.title, content: draft });
      else throw Error(t("Document save interface is missing"));
      setDirty(false);
      setSaved(true);
    } catch (error) {
      onError(error);
    } finally { setSaving(false); }
  };
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className={`document-dialog panel preview-stack-dialog${editing ? " document-dialog-editing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        tabIndex={-1}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" || ((node.readonly || preview || !!navigation?.layers.length) && event.code === "Space" && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !(event.target as Element).closest('button,a[href],video,audio,input,textarea,select,[contenteditable="true"]'))) {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const elements = visibleDialogControls(dialog.current);
            const first = elements[0];
            const last = elements.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <PreviewDialogHeading title={node.title} titleId={titleId} navigation={navigation} onClose={onClose} closeLabel={t("Close document")}/>
        <MarkdownPreviewProvider onOpenLink={onOpenLink} imageRequest={imageRequest} projectId={node.projectId} imageRevision={imageRevision} expandableImages>
        <PreviewDialogLayers navigation={navigation} rootClassName="document-dialog-content">
        {isText && readable && (
          <p className="muted">
            {node.readonly
              ? t("The original delivery is read-only; copy it to edit independently.")
              : onDraft ? t("Edits are saved automatically.") : t("Saving changes updates this document's content version.")}
          </p>
        )}
        {node.summary && <p>{node.summary}</p>}
        {isMedia && node.assetRef && adapter ? (
          <AssetPreviewContent
            assetRef={node.assetRef}
            adapter={adapter}
            kind={node.type}
            title={node.title}
            onError={onError}
          />
        ) : !readable ? (
          <ContentPlaceholder node={node} />
        ) : (
          <>
            {node.readonly || preview ? (
              <MarkdownPreview className="document-body" text={draft} />
            ) : (
              <textarea
                className="document-editor node-text"
                disabled={saving}
                aria-label={t("Markdown body")}
                value={draft}
                onChange={(event) => {
                  if (onDraft) { try { onDraft({ title: node.title, content: event.target.value }); } catch (e) { onError(e); return; } }
                  setDraft(event.target.value);
                  setDirty(true);
                  setSaved(false);
                }}
              />
            )}
            <footer className="document-actions">
              {node.readonly ? (
                <button
                  className="primary-button"
                  disabled={saving || (!adapter && !onCopy)}
                  onClick={async () => {
                    try {
                      const copy = onCopy ? await onCopy() : adapter!.copyNode(node.graphId, node.id);
                      onSelect(copy);
                    } catch (error) {
                      onError(error);
                    }
                  }}
                >
                  <Copy size={16} />
                  {t("Copy and edit")}
                </button>
              ) : (
                <>
                  <button
                    className="secondary-button"
                    onClick={() => setPreview((value) => !value)}
                  >
                    {preview ? t("Edit body") : t("Preview Markdown")}
                  </button>
                  {!onDraft && <button
                    className="primary-button"
                    disabled={!dirty || saving}
                    onClick={() => void save()}
                  >
                    <Save size={16} />
                    {t("Save")}
                  </button>}
                </>
              )}
              <span className="muted" role="status">
                {saveStatus ?? (dirty ? t("Unsaved changes") : saved ? t("Saved") : "")}
              </span>
            </footer>
          </>
        )}
        {children}
        </PreviewDialogLayers>
        </MarkdownPreviewProvider>
      </section>
    </div>
  );
}

export default DocumentDialog;
