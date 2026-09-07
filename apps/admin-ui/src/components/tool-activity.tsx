import { QaseyPublicToolInputSchema, QaseyPublicToolOutputSchema } from "@qasey/contracts";
import type { DynamicToolUIPart } from "ai";
import { ArrowUpRight, Check, ChevronRight, CircleAlert, LoaderCircle, Search, Wrench, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Filter = "all" | "failed";
type ToolTone = "running" | "completed" | "failed" | "incomplete";

function toolView(tool: DynamicToolUIPart, running: boolean) {
  const input = QaseyPublicToolInputSchema.safeParse(tool.input);
  const inputSummary = input.success ? input.data.summary : "未保存输入摘要。";
  if (tool.state === "output-error") return { tone: "failed" as const, status: "失败", summary: tool.errorText, inputSummary };
  if (tool.state === "output-denied") return { tone: "failed" as const, status: "未执行", summary: "工具调用未获批准。", inputSummary };
  if (tool.state === "output-available") {
    const output = QaseyPublicToolOutputSchema.safeParse(tool.output);
    return { tone: "completed" as const, status: "成功", summary: output.success ? output.data.summary : "工具执行完成。", inputSummary };
  }
  return { tone: running ? "running" as const : "incomplete" as const, status: running ? "执行中" : "未完成", summary: running ? inputSummary : "本次调用未记录最终结果。", inputSummary };
}

function ToolIcon({ tone }: { tone: ToolTone }) {
  if (tone === "running") return <LoaderCircle className="spin-slow" size={16} />;
  if (tone === "completed") return <Check size={16} />;
  return <CircleAlert size={16} />;
}

export function ToolActivity({ tools, running }: { tools: DynamicToolUIPart[]; running: boolean }) {
  const [drawer, setDrawer] = useState<Filter | null>(null);
  const views = tools.map(tool => toolView(tool, running));
  const failures = tools.filter((_, index) => views[index]?.tone === "failed");
  const completedCount = views.filter(view => view.tone === "completed").length;
  const pendingCount = tools.length - completedCount - failures.length;
  const active = tools.findLast((_, index) => views[index]?.tone === "running");
  const headline = running ? active ? `正在执行：${active.title ?? "工具调用"}` : "正在处理…" : "执行结束";
  const counts = `调用 ${tools.length} 次 · ${completedCount} 次成功${failures.length ? ` · ${failures.length} 次失败` : ""}${pendingCount ? ` · ${pendingCount} 次${running ? "执行中" : "未完成"}` : ""}`;

  return <section className="conversation-tools" aria-label="工具调用摘要">
    <div className="tool-activity-summary">
      <span className={`tool-activity-icon${running ? " tool-activity-icon--running" : ""}`}>{running ? <LoaderCircle className="spin-slow" size={16} /> : <Wrench size={16} />}</span>
      <div className="tool-activity-heading"><strong title={headline}>{headline}</strong><span>{counts}</span></div>
      <button type="button" className="tool-activity-link" onClick={() => setDrawer("all")}>{running ? "查看实时过程" : "查看过程"}<ArrowUpRight size={14} /></button>
    </div>
    {failures.length > 0 && <details className="tool-activity-failures">
      <summary><CircleAlert size={15} /><span>{failures.length} 次调用失败</span><ChevronRight size={14} /></summary>
      <div className="tool-activity-failure-preview">
        <p>以下是调用失败记录，是否影响最终结果请结合回复判断。</p>
        {failures.slice(0, 3).map(tool => <ToolLogRow key={tool.toolCallId} tool={tool} running={running} />)}
        <button type="button" className="tool-activity-link" onClick={() => setDrawer("failed")}>查看全部失败记录<ArrowUpRight size={14} /></button>
      </div>
    </details>}
    {drawer !== null && <ToolLogDrawer tools={tools} running={running} counts={counts} initialFilter={drawer} onClose={() => setDrawer(null)} />}
  </section>;
}

function ToolLogRow({ tool, running, sequence }: { tool: DynamicToolUIPart; running: boolean; sequence?: number }) {
  const view = toolView(tool, running);
  return <details className={`tool-log-row tool-log-row--${view.tone}`}>
    <summary>
      <ToolIcon tone={view.tone} />
      {sequence !== undefined && <span className="tool-log-sequence">{sequence}</span>}
      <span className="tool-log-title" title={tool.title ?? "工具调用"}>{tool.title ?? "工具调用"}</span>
      <span className="tool-log-status">{view.status}</span>
      <ChevronRight className="tool-log-chevron" size={14} />
    </summary>
    <dl className="tool-log-detail">
      <div><dt>工具</dt><dd><code>{tool.toolName}</code></dd></div>
      <div><dt>调用 ID</dt><dd><code>{tool.toolCallId}</code></dd></div>
      <div><dt>输入摘要</dt><dd>{view.inputSummary}</dd></div>
      <div><dt>{view.tone === "failed" ? "失败原因" : "结果摘要"}</dt><dd>{view.summary}</dd></div>
    </dl>
  </details>;
}

function ToolLogDrawer({ tools, running, counts, initialFilter, onClose }: { tools: DynamicToolUIPart[]; running: boolean; counts: string; initialFilter: Filter; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [filter, setFilter] = useState(initialFilter);
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const filtered = tools.map((tool, index) => ({ tool, sequence: index + 1 })).filter(({ tool }) => {
    const view = toolView(tool, running);
    return (filter === "all" || view.tone === "failed") && (!search || [tool.title, tool.toolName, tool.toolCallId, view.inputSummary, view.summary].join(" ").toLocaleLowerCase().includes(search));
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return createPortal(<dialog ref={dialogRef} className="tool-log-drawer" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className="tool-log-header"><div><h2 id={titleId}>执行过程</h2><p>{counts}</p></div><button type="button" className="tool-log-close" aria-label="关闭执行过程" onClick={onClose}><X size={20} /></button></header>
    <div className="tool-log-controls">
      <div className="tool-log-filters" role="group" aria-label="调用状态筛选"><button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部</button><button type="button" aria-pressed={filter === "failed"} onClick={() => setFilter("failed")}>失败</button></div>
      <label className="tool-log-search"><Search size={16} /><input aria-label="搜索调用记录" placeholder="搜索工具、输入或结果" value={query} onChange={event => setQuery(event.target.value)} type="search" /></label>
      <p className="tool-log-result-count" role="status">{running ? "实时更新 · " : ""}显示 {filtered.length} / {tools.length} 次调用</p>
    </div>
    <div className="tool-log-list">
      {filtered.map(({ tool, sequence }) => <ToolLogRow key={tool.toolCallId} tool={tool} running={running} sequence={sequence} />)}
      {!filtered.length && <p className="tool-log-empty">{search ? "没有匹配的调用记录，试试其他关键词。" : "没有失败的调用记录。"}</p>}
    </div>
  </dialog>, document.body);
}
