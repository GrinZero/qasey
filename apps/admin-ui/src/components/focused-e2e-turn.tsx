import { useEffect, useRef, type ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { QaseyE2EContext } from "@qasey/contracts";
import { caseReviewUrl } from "./e2e-task-urls";

export function E2EContextBanner({ context }: { context: QaseyE2EContext }) {
  return <aside className="e2e-context-banner" aria-label="本次 E2E 任务">
    <div><strong>本次 E2E 任务 · {context.cases.length} 条用例</strong>
      <ul>{context.cases.map(item => <li key={item.caseVersionId}>{item.caseId} · v{item.version} · {item.title}</li>)}</ul></div>
    <a className="secondary-button" href={caseReviewUrl(context.planId, context.cases.length === 1 ? context.cases[0]?.caseVersionId : undefined)}>返回用例</a>
  </aside>;
}

export function FocusedE2ETurn({ id, focused, children }: { id: string; focused: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { stopScroll, scrollRef } = useStickToBottomContext();
  useEffect(() => {
    if (!focused) return;
    const frame = requestAnimationFrame(() => {
      const target = ref.current;
      const scroll = scrollRef.current;
      if (!target || !scroll) return;
      stopScroll();
      scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16;
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focused, stopScroll, scrollRef]);
  return <div ref={ref} id={`conversation-turn-${id}`} tabIndex={-1} className={focused ? "focused-e2e-turn" : undefined}>{children}</div>;
}
