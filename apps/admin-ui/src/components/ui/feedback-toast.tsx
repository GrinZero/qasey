import { CheckCircle2, X } from "lucide-react";
import { useEffect } from "react";

export function FeedbackToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return <div className="feedback-toast" role="status">
    <CheckCircle2 size={20} aria-hidden="true" />
    <span>{message}</span>
    <button type="button" className="icon-button" aria-label="关闭提示" onClick={onDismiss}><X size={16} /></button>
  </div>;
}
