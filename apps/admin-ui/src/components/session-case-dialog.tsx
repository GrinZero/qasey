import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { CaseReviewItem } from "../types";

const automationLabels = {
  none: "未自动化", generating: "生成中", awaiting_review: "证据待审",
  verified: "已验证", failed: "E2E 失败", stale: "待更新",
} as const;

export function SessionCaseDialog({ item, onClose }: { item: CaseReviewItem; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { content } = item;

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(<dialog ref={dialogRef} className="session-case-dialog" aria-labelledby="session-case-detail-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="session-case-dialog-head">
      <div><p>{item.publishedCaseId ?? "未发布用例"} · {content.priority}</p><h2 id="session-case-detail-title">{content.title}</h2><p>{content.suitePath}</p></div>
      <button type="button" className="icon-button bordered" aria-label="关闭用例详情" onClick={onClose}><X size={18} /></button>
    </header>
    <div className="session-case-dialog-body">
      <dl className="session-case-detail-status">
        <div><dt>用例审批</dt><dd>{item.status === "approved" ? "已批准" : item.status === "removed" ? "已移除" : "待审"}</dd></div>
        <div><dt>自动化状态</dt><dd>{automationLabels[item.automationStatus ?? "none"]}</dd></div>
      </dl>
      {content.description && <section><h3>用例说明</h3><p>{content.description}</p></section>}
      <section><h3>前置条件</h3>{content.preconditions.length ? <ul>{content.preconditions.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p>无额外前置条件</p>}</section>
      <section><h3>测试步骤与预期结果</h3><ol className="session-case-detail-steps">{content.steps.map((step, index) => <li key={index}><h4>{step.action}</h4><p className="session-case-expected-label">预期结果</p><ul>{step.expected.map((value, expectedIndex) => <li key={expectedIndex}>{value}</li>)}</ul></li>)}</ol></section>
      {Object.keys(content.testData).length > 0 && <section><h3>测试数据</h3><pre>{JSON.stringify(content.testData, null, 2)}</pre></section>}
      {content.tags.length > 0 && <section><h3>标签</h3><p>{content.tags.join(" · ")}</p></section>}
    </div>
  </dialog>, document.body);
}
