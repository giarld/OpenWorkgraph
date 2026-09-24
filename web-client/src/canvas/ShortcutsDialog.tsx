import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { isMac, primaryLabel } from "./primary-modifier";
import { useI18n } from "../i18n/I18nProvider";

// Visual reference: infinite-canvas d213a746, canvas-top-bar / canvas-zoom-controls.
// Source attribution and MIT notice: docs/references/infinite-canvas-LICENSE.txt.
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const shortcuts: Array<{ keys: string[]; description: string }> = [
    { keys: [primaryLabel + " / Space", t("Drag")], description: t("Temporarily switch between select and pan tools when no node is selected") },
    { keys: ["Space"], description: t("Edit or preview the selected node") },
    { keys: ["F"], description: t("Center selected nodes at 100% zoom") },
    { keys: [t("Middle mouse drag")], description: t("Pan the Work Graph") },
    { keys: [t("Two-finger scroll / Mouse wheel")], description: t("Pan the Work Graph") },
    { keys: [primaryLabel + " + " + t("Mouse wheel")], description: t("Zoom around the pointer") },
    ...(isMac ? [{ keys: [t("Pinch / Ctrl + Mouse wheel")], description: t("Zoom around the pointer") }] : []),
    { keys: [t("Zoom slider")], description: t("Adjust the zoom level precisely") },
    { keys: [t("Drag empty space")], description: t("Select nodes with a box (select tool)") },
    { keys: ["Shift / " + primaryLabel, t("Click")], description: t("Add or remove nodes from the selection") },
    { keys: [primaryLabel, "A"], description: t("Select all nodes") },
    { keys: [primaryLabel, "C / V"], description: t("Copy / paste nodes or clipboard content") },
    { keys: [primaryLabel, "S"], description: t("Save Work Graph edits now") },
    { keys: [primaryLabel, "G"], description: t("Group selected nodes") },
    { keys: [primaryLabel, "Shift", "G"], description: t("Ungroup the selected group") },
    { keys: [primaryLabel, "Z"], description: t("Undo Work Graph edits") },
    { keys: [primaryLabel, "Shift", "Z"], description: t("Redo Work Graph edits") },
    ...(isMac ? [] : [{ keys: [primaryLabel, "Y"], description: t("Redo Work Graph edits") }]),
    { keys: ["Delete / Backspace"], description: t("Delete selected nodes or removable connections") },
    { keys: ["Esc"], description: t("Cancel the action, clear the selection, or exit editing") },
    { keys: [t("Double-click text")], description: t("Edit in place with the caret at the end and the view at the beginning") },
    { keys: [t("Double-click empty space")], description: t("Open the node creation menu") },
    { keys: [t("Drag an image corner")], description: t("Resize the card freely without distorting the image") },
    { keys: ["Shift", t("Drag an image corner")], description: t("Temporarily preserve the card aspect ratio") },
    { keys: [t("Drop files")], description: t("Import assets and place them on the Work Graph") },
  ];
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="owg-shortcuts-dialog"
      aria-labelledby={titleId}
      aria-modal="true"
      data-canvas-interactive
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Tab") {
          const targets = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              'button, [tabindex="0"]',
            ),
          );
          const first = targets[0],
            last = targets.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.target === event.currentTarget &&
          (event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom)
        )
          onClose();
      }}
    >
      <header className="owg-shortcuts-heading">
        <h2 id={titleId}>{t("Keyboard shortcuts")}</h2>
        <button
          type="button"
          aria-label={t("Close keyboard shortcuts")}
          title={t("Close")}
          onClick={onClose}
          autoFocus
        >
          <X size={18} />
        </button>
      </header>
      <div className="owg-shortcuts-list" tabIndex={0} aria-label={t("Keyboard shortcut list")}>
        {shortcuts.map(({ keys, description }) => (
          <div className="owg-shortcut-row" key={description + keys.join()}>
            <span className="owg-shortcut-keys">
              {keys.map((key, index) => (
                <span className="owg-shortcut-key" key={key}>
                  {index > 0 && (
                    <span className="owg-shortcut-plus" aria-hidden="true">
                      +
                    </span>
                  )}
                  <kbd>{key}</kbd>
                </span>
              ))}
            </span>
            <span className="owg-shortcut-description">{description}</span>
          </div>
        ))}
        <p className="owg-shortcuts-note">
          {t("Native shortcuts remain available while editing inputs. Run locks and hard delivery connections still follow their protection rules.")}
        </p>
      </div>
    </dialog>
  );
}
