import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Eye, LoaderCircle, MoreHorizontal, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { CaseHubCase } from "../types";
import { ConfirmDialog } from "./ui/confirm-dialog";

export function CaseRowActions({ testCase, loading, onView, onDelete }: {
  testCase: CaseHubCase;
  loading: boolean;
  onView: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openingDialog = useRef(false);

  // Portal clicks still bubble through React to the clickable case row.
  return <div className="case-row-actions" onClick={event => event.stopPropagation()}>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button ref={triggerRef} type="button" className="icon-button case-actions-trigger" aria-label={`${testCase.id} 更多操作`} title="更多操作" disabled={loading}>
          {loading ? <LoaderCircle className="spin" size={18} /> : <MoreHorizontal size={18} />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="row-actions-menu" align="end" sideOffset={6} collisionPadding={12}
          onCloseAutoFocus={event => { if (openingDialog.current) event.preventDefault(); }}>
          <DropdownMenu.Item className="row-actions-item" onSelect={onView}><Eye size={16} aria-hidden="true" />查看详情</DropdownMenu.Item>
          <DropdownMenu.Separator className="row-actions-separator" />
          <DropdownMenu.Item className="row-actions-item destructive" onSelect={() => { openingDialog.current = true; setConfirmOpen(true); }}>
            <Trash2 size={16} aria-hidden="true" />删除用例
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} title="删除用例？" confirmLabel="删除用例"
      description="该用例将从用例库移除，无法再发起新的 E2E。历史版本与执行证据仍会保留。"
      onConfirm={onDelete} onRestoreFocus={() => {
        openingDialog.current = false;
        const target = triggerRef.current?.isConnected ? triggerRef.current : document.getElementById("case-hub-search");
        target?.focus();
      }}>
      <div className="confirm-dialog-subject"><span>{testCase.id}</span><strong>{testCase.title}</strong></div>
    </ConfirmDialog>
  </div>;
}
