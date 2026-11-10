import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "../atoms";

type Props = {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Button style for the confirm action; the destructive default suits most
   *  uses (delete/import), install-style confirms pick "primary". */
  confirmVariant?: "primary" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Delete",
  confirmVariant = "danger",
  busy,
  onConfirm,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="modal-card">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button
            type="button"
            className="modal-x"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="modal-msg">{message}</div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy} autoFocus>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={busy} className={busy ? "is-busy" : ""}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
