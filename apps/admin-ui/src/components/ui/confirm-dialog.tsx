import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { AlertCircle, LoaderCircle, Trash2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onRestoreFocus: () => void;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel, onConfirm, onRestoreFocus }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const changeOpen = (next: boolean) => {
    if (inFlight.current) return;
    setError("");
    onOpenChange(next);
  };
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除失败，请重试。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return <AlertDialog.Root open={open} onOpenChange={changeOpen}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="confirm-dialog-overlay" />
      <AlertDialog.Content className="confirm-dialog" aria-busy={pending}
        onEscapeKeyDown={event => { if (inFlight.current) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); onRestoreFocus(); }}>
        <div className="confirm-dialog-icon" aria-hidden="true"><Trash2 size={22} /></div>
        <AlertDialog.Title className="confirm-dialog-title">{title}</AlertDialog.Title>
        <AlertDialog.Description className="confirm-dialog-description">{description}</AlertDialog.Description>
        {children}
        {error && <p className="confirm-dialog-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span></p>}
        <div className="confirm-dialog-footer">
          <AlertDialog.Cancel asChild><button type="button" className="secondary-button" disabled={pending}>取消</button></AlertDialog.Cancel>
          <button type="button" className="destructive-button" disabled={pending} onClick={() => void confirm()}>
            {pending && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{pending ? "正在删除…" : confirmLabel}
          </button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
