import { Check, ChevronDown, ChevronUp, LoaderCircle, Play, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { protectReviewNavigation } from "./review-navigation";
import { E2ETaskLink } from "./e2e-task-link";
import { CaseReviewContentSchema, type QaseyE2ETask } from "@qasey/contracts";
import { api, errorMessage } from "../api";
import type { CaseReviewContent, CaseReviewItem, CaseReviewPlanDetail } from "../types";

interface CaseReviewPanelProps {
  planId: string;
  compact?: boolean;
  onGenerate?: (plan: CaseReviewPlanDetail, caseVersionIds: string[]) => Promise<void>;
  onChanged?: () => void | Promise<void>;
}

const automationLabels = {
  none: "纯文字", generating: "生成中", awaiting_review: "待审证据", verified: "e2e", failed: "生成失败", stale: "E2E 待更新",
} as const;

export function CaseReviewPanel({ planId, compact = false, onGenerate, onChanged }: CaseReviewPanelProps) {
  const [detail, setDetail] = useState<CaseReviewPlanDetail | null>(null);
  const [expandedId, setExpandedId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("plan") === planId ? params.get("item") ?? "" : "";
  });
  const [submittedTask, setSubmittedTask] = useState<QaseyE2ETask | null>(null);
  const requestIds = useRef(new Map<string, string>());
  const launching = useRef(false);
  const located = useRef(false);
  const [drafts, setDrafts] = useState<Record<string, CaseReviewContent>>({});
  const [editingRevisions, setEditingRevisions] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState("");
  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!dirty) return;
    const unprotect = protectReviewNavigation();
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const guardNavigation = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || anchor.hash && anchor.pathname === location.pathname && anchor.search === location.search) return;
      if (anchor.href === location.href) return;
      if (!window.confirm("还有未保存的用例修改。确定离开并放弃修改吗？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardNavigation, true);
    return () => { unprotect(); window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guardNavigation, true); };
  }, [dirty]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => { setDetail(await api.getReviewPlan(planId)); }, [planId]);
  useEffect(() => { void load().catch(cause => setError(errorMessage(cause))); }, [load]);

  const tasks = [...(detail?.e2eTasks ?? []), ...(submittedTask && !detail?.e2eTasks?.some(task => task.turnId === submittedTask.turnId) ? [submittedTask] : [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestTask = tasks[0];
  const activeTasks = tasks.filter(task => task.status === "running");
  if (submittedTask?.status === "running" && !tasks.some(task => task.turnId === submittedTask.turnId)) activeTasks.push(submittedTask);
  const activeVersions = new Set(activeTasks.flatMap(task => task.context.cases.map(item => item.caseVersionId)));
  const working = activeTasks.length > 0 || detail?.items.some(item => item.automationStatus === "generating");
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [working, load]);
  useEffect(() => {
    if (!detail || located.current || new URLSearchParams(window.location.search).get("plan") !== planId) return;
    located.current = true;
    const versionId = new URLSearchParams(window.location.search).get("version");
    const matching = detail.items.find(item => item.publishedCaseVersionId === versionId);
    if (matching) setExpandedId(matching.id);
    document.getElementById(`review-plan-${planId}`)?.scrollIntoView({ block: "start" });
  }, [detail, planId]);

  const pending = detail?.items.filter(item => item.status === "pending") ?? [];
  const eligible = detail?.items.filter(item => item.status === "approved" && item.publishedCaseVersionId && !activeVersions.has(item.publishedCaseVersionId) && !["verified", "generating", "awaiting_review"].includes(item.automationStatus ?? "none")) ?? [];
  const allReviewed = detail?.plan.status === "ready";

  const mutate = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key); setError(""); setNotice("");
    try { await operation(); await load(); await onChanged?.(); }
    catch (cause) { setError(errorMessage(cause)); await load().catch(() => undefined); }
    finally { setBusy(""); }
  };

  const expand = (item: CaseReviewItem) => {
    if (expandedId === item.id) { setExpandedId(""); return; }
    setExpandedId(item.id); setError("");
  };

  const discard = (id: string) => {
    setDrafts(current => { const next = { ...current }; delete next[id]; return next; });
    setEditingRevisions(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const save = (item: CaseReviewItem, content: CaseReviewContent, approve: boolean) => mutate(`save:${item.id}`, async () => {
    const normalized = {
      ...content, tags: content.tags.map(tag => tag.trim()).filter(Boolean),
      preconditions: content.preconditions.map(line => line.trim()).filter(Boolean),
      steps: content.steps.map(step => ({ ...step, expected: step.expected.map(line => line.trim()).filter(Boolean) })),
    };
    const validation = CaseReviewContentSchema.safeParse(normalized);
    if (!validation.success) throw new Error("请检查标题、Suite、操作和预期均已填写，且内容未超过长度限制。修改仍保留在当前草稿中。");
    const updated = await api.updateReviewItem(planId, item.id, editingRevisions[item.id] ?? item.revision, validation.data);
    const saved = updated.items.find(candidate => candidate.id === item.id);
    if (!saved) throw new Error("保存后的用例不存在，请刷新后重试。");
    setDetail(updated);
    discard(item.id);
    if (approve) await api.approveReviewItem(planId, item.id, saved.revision);
    setNotice(approve ? "修改已保存，文字用例已批准。" : "修改已保存。文字用例需要重新审核后生效。");
  });

  const generate = async (ids: string[]) => {
    if (!detail || !ids.length || dirty || launching.current) return;
    launching.current = true;
    const selectionKey = [...ids].sort().join(":");
    const requestId = requestIds.current.get(selectionKey) ?? crypto.randomUUID();
    requestIds.current.set(selectionKey, requestId);
    try {
      await mutate(`generate:${selectionKey}`, async () => {
        if (onGenerate) await onGenerate(detail, ids);
        else {
          const task = await api.generateE2E(detail.plan.conversationId, detail.plan.id, ids, requestId);
          setSubmittedTask(task);
        }
        requestIds.current.delete(selectionKey);
        setNotice("E2E 任务已启动。点击“查看 Agent 工作”可定位本次任务；你可以留在这里继续审核。");
      });
    } finally { launching.current = false; }
  };

  if (!detail) return <section className={`case-review-panel ${compact ? "case-review-panel--compact" : ""}`}><div className="review-loading"><LoaderCircle className="spin" size={17} />正在读取文字用例计划…</div>{error && <p className="review-inline-error">{error}</p>}</section>;
  return <section className={`case-review-panel ${compact ? "case-review-panel--compact" : ""}`} id={`review-plan-${planId}`} aria-label="文字用例审核与自动化">
    <header className="case-review-panel__head">
      <div><span className="review-kicker">TEXT CASE REVIEW</span><h3>{detail.plan.requirement.goal}</h3><p>{pending.length ? `${pending.length} 条等待确认` : "文字用例已审完"} · {detail.items.filter(item => item.status === "approved").length} 条已批准</p></div>
      <div className="case-review-panel__actions">
        {detail.editable && pending.length > 0 && <button className="secondary-button" disabled={Boolean(busy) || dirty} onClick={() => void mutate("approve-all", () => api.approveReviewItems(planId, pending.map(item => ({ itemId: item.id, expectedRevision: item.revision }))))}><Check size={14} />全部批准</button>}
        {detail.editable && <button className="primary-button" disabled={!allReviewed || !eligible.length || Boolean(busy) || dirty} title={!allReviewed ? "先完成所有文字用例审核" : eligible.length ? "以一个 Run 和一个 PR 生成尚未覆盖的用例" : "没有需要生成的用例"} onClick={() => void generate(eligible.flatMap(item => item.publishedCaseVersionId ? [item.publishedCaseVersionId] : []))}>{busy.startsWith("generate:") ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{busy.startsWith("generate:") ? "正在启动…" : `生成 E2E（${eligible.length} 条）`}</button>}
      </div>
    </header>
    {error && <p className="review-inline-error" role="alert">{error}</p>}
    {notice && <p className="review-feedback" role="status">{notice}</p>}
    {dirty && <p className="review-feedback" role="status">有 {Object.keys(drafts).length} 条未保存修改，切换用例会保留草稿。请保存或放弃修改后再批量批准、生成 E2E。</p>}
    {busy.startsWith("generate:") && <p className="review-feedback" role="status">正在提交 E2E 任务，请稍候。</p>}
    {latestTask && !compact && <E2ETaskLink task={latestTask} />}
    <a className="review-conversation-link" target="_blank" rel="noreferrer" href={`/admin/apps/qasey?conversation=${encodeURIComponent(detail.plan.conversationId)}`}>查看原会话与运行进度 →</a>
    {!detail.editable && <p className="review-readonly">此计划属于另一位用户的 AI session，你可以查看，但不能修改、批准或启动 E2E。</p>}
    <div className="review-ledger" aria-label="文字测试用例">
      <div className="review-ledger__columns"><span>状态</span><span>标题 / Suite</span><span>优先级</span><span>标签</span><span>E2E</span><span>操作</span></div>
      {detail.items.map(item => <ReviewRow key={item.id} item={item} editable={detail.editable} expanded={expandedId === item.id} draft={drafts[item.id] ?? null} task={tasks.find(task => task.context.cases.some(candidate => candidate.caseVersionId === item.publishedCaseVersionId)) ?? (submittedTask?.context.cases.some(candidate => candidate.caseVersionId === item.publishedCaseVersionId) ? submittedTask : undefined)} editing={editingRevisions[item.id] !== undefined} busy={busy} dirty={dirty || Boolean(item.publishedCaseVersionId && activeVersions.has(item.publishedCaseVersionId))}
        onExpand={() => expand(item)} onEdit={() => setEditingRevisions(current => ({ ...current, [item.id]: item.revision }))} onDiscard={() => discard(item.id)}
        onDraft={value => setDrafts(current => ({ ...current, [item.id]: value }))}
        onSave={(content, approve) => save(item, content, approve)}
        onApprove={() => mutate(`approve:${item.id}`, () => api.approveReviewItem(planId, item.id, item.revision))}
        onRemove={() => mutate(`remove:${item.id}`, () => api.setReviewItemRemoved(planId, item.id, item.revision, true))}
        onRestore={() => mutate(`restore:${item.id}`, () => api.setReviewItemRemoved(planId, item.id, item.revision, false))}
        onGenerate={() => item.publishedCaseVersionId ? generate([item.publishedCaseVersionId]) : Promise.resolve()} />)}
    </div>
  </section>;
}

function ReviewRow({ item, editable, expanded, draft, task, editing, dirty, busy, onExpand, onEdit, onDiscard, onDraft, onSave, onApprove, onRemove, onRestore, onGenerate }: {
  task: QaseyE2ETask | undefined; item: CaseReviewItem; editable: boolean; expanded: boolean; editing: boolean; dirty: boolean; draft: CaseReviewContent | null; busy: string;
  onExpand: () => void; onEdit: () => void; onDiscard: () => void; onDraft: (value: CaseReviewContent) => void; onSave: (value: CaseReviewContent, approve: boolean) => Promise<void>;
  onApprove: () => Promise<void>; onRemove: () => Promise<void>; onRestore: () => Promise<void>; onGenerate: () => Promise<void>;
}) {
  const [invalid, setInvalid] = useState(false);
  const automation = task?.status === "running" ? "generating" : item.automationStatus ?? "none";
  const canGenerate = item.status === "approved" && item.publishedCaseVersionId && !["verified", "generating", "awaiting_review"].includes(automation);
  return <div className={`review-ledger__row review-ledger__row--${item.status}`}>
    <button className="review-ledger__summary" onClick={onExpand} aria-expanded={expanded} aria-controls={`review-detail-${item.id}`}>
      <span><i className={`review-state review-state--${item.status}`} />{item.status === "pending" ? "待审" : item.status === "approved" ? "已批准" : "已移除"}</span>
      <span><strong>{item.content.title}{draft && <em className="review-unsaved">未保存</em>}</strong><small>{item.content.suitePath}</small></span>
      <span>{item.content.priority}</span><span>{item.content.tags.join(" · ") || "—"}</span>
      <span className={`automation-state automation-state--${automation}`}>{automationLabels[automation]}</span>
      <span>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>
    </button>
    <div id={`review-detail-${item.id}`} hidden={!expanded}>
    {task && <E2ETaskLink task={task} />}
    {editing ? <ReviewEditor item={item} value={draft ?? item.content} editable={editable && !busy && item.status !== "removed"} onChange={onDraft} onValidity={setInvalid} /> : <ReviewReadView content={draft ?? item.content} />}
    {automation === "failed" && <p className="review-inline-error">E2E 生成失败，已批准的文字用例仍然有效。请在原会话中查看失败原因，处理后重新生成。</p>}
    {expanded && <footer className="review-ledger__footer">
      <span>{item.publishedCaseId ? `${item.publishedCaseId} · revision ${item.revision}` : `Draft ${item.ordinal + 1} · revision ${item.revision}`}</span>
      <div>
        {editable && item.status === "removed" && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void onRestore()}><RotateCcw size={14} />撤销移除</button>}
        {editable && item.status !== "removed" && <button className="secondary-button danger-button" disabled={Boolean(busy) || Boolean(draft)} onClick={() => void onRemove()}><Trash2 size={14} />移除</button>}
        {editable && item.status !== "removed" && !editing && <button className="secondary-button" disabled={Boolean(busy)} onClick={onEdit}>{item.status === "approved" ? "编辑并创建修订" : "编辑"}</button>}
        {editing && <button className="secondary-button" disabled={Boolean(busy)} onClick={() => { onDiscard(); setInvalid(false); }}>{draft ? "放弃修改" : "取消编辑"}</button>}
        {editing && draft && <button className="secondary-button" disabled={Boolean(busy) || invalid} onClick={() => void onSave(draft, false)}><Save size={14} />保存修改</button>}
        {editing && draft && <button className="primary-button" disabled={Boolean(busy) || invalid} onClick={() => void onSave(draft, true)}><Check size={14} />保存并批准</button>}
        {editable && item.status === "pending" && !draft && !editing && <button className="primary-button" disabled={Boolean(busy)} onClick={() => void onApprove()}><Check size={14} />批准文字用例</button>}
        {editable && canGenerate && <button className="primary-button" disabled={Boolean(busy) || dirty || editing} onClick={() => void onGenerate()}><Play size={14} />{automation === "failed" ? "重新生成 E2E" : "生成此条 E2E"}</button>}
      </div>
    </footer>}
    </div>
  </div>;
}

function ReviewEditor({ item, value, editable, onChange, onValidity }: { item: CaseReviewItem; value: CaseReviewContent; editable: boolean; onChange: (value: CaseReviewContent) => void; onValidity: (invalid: boolean) => void }) {
  const [jsonError, setJsonError] = useState("");
  const field = <K extends keyof CaseReviewContent>(key: K, next: CaseReviewContent[K]) => onChange({ ...value, [key]: next });
  const [testDataText, setTestDataText] = useState(() => JSON.stringify(value.testData, null, 2));
  return <div className="review-editor">
    {item.status === "approved" && <p className="review-version-note">修改已批准项会创建新的待审修订；当前正式版本会继续生效，直到新版本获批。</p>}
    <div className="review-form-grid"><label>标题<input disabled={!editable} value={value.title} onChange={event => field("title", event.target.value)} /></label><label>Suite<input disabled={!editable} value={value.suitePath} onChange={event => field("suitePath", event.target.value)} /></label><label>优先级<select disabled={!editable} value={value.priority} onChange={event => field("priority", event.target.value as CaseReviewContent["priority"])}>{["P0", "P1", "P2", "P3"].map(priority => <option key={priority}>{priority}</option>)}</select></label><label>用户标签<input disabled={!editable} value={value.tags.join(",")} onChange={event => field("tags", event.target.value.split(","))} /></label></div>
    <label>描述<textarea aria-label="描述" disabled={!editable} value={value.description} onChange={event => field("description", event.target.value)} /></label>
    <label>前置条件<textarea aria-label="前置条件" disabled={!editable} value={value.preconditions.join("\n")} onChange={event => field("preconditions", lines(event.target.value))} placeholder="每行一条" /></label>
    <div className="review-steps"><div><strong>步骤与预期</strong>{editable && <button type="button" className="text-button" onClick={() => field("steps", [...value.steps, { action: "", expected: [""] }])}><Plus size={14} />添加步骤</button>}</div>{value.steps.map((step, index) => <div className="review-step-edit" key={`${item.id}:${index}`}><span>{index + 1}</span><label>操作<textarea aria-label={`步骤 ${index + 1} 操作`} disabled={!editable} value={step.action} onChange={event => field("steps", value.steps.map((candidate, position) => position === index ? { ...candidate, action: event.target.value } : candidate))} /></label><label>预期<textarea aria-label={`步骤 ${index + 1} 预期`} disabled={!editable} value={step.expected.join("\n")} onChange={event => field("steps", value.steps.map((candidate, position) => position === index ? { ...candidate, expected: lines(event.target.value) } : candidate))} /></label>{editable && <div><button type="button" aria-label={`上移步骤 ${index + 1}`} disabled={index === 0} onClick={() => field("steps", move(value.steps, index, index - 1))}><ChevronUp size={14} /></button><button type="button" aria-label={`下移步骤 ${index + 1}`} disabled={index === value.steps.length - 1} onClick={() => field("steps", move(value.steps, index, index + 1))}><ChevronDown size={14} /></button><button type="button" aria-label={`删除步骤 ${index + 1}`} disabled={value.steps.length === 1} onClick={() => field("steps", value.steps.filter((_, position) => position !== index))}><X size={14} /></button></div>}</div>)}</div>
    <label>测试数据（JSON）<textarea aria-label="测试数据（JSON）" className="review-json" disabled={!editable} value={testDataText} aria-invalid={Boolean(jsonError)} onChange={event => {
      setTestDataText(event.target.value);
      // Mark even invalid JSON edits as a draft, so navigation cannot silently discard them.
      onChange({ ...value });
      try {
        const parsed: unknown = JSON.parse(event.target.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        field("testData", parsed as Record<string, unknown>); setJsonError(""); onValidity(false);
      } catch { setJsonError("测试数据必须是有效的 JSON 对象，修正后才能保存。"); onValidity(true); }
    }} /></label>{jsonError && <p className="review-inline-error">{jsonError}</p>}
  </div>;
}

function lines(value: string): string[] { return value.split("\n"); }
function move<T>(items: T[], from: number, to: number): T[] { const next = [...items]; const [item] = next.splice(from, 1); if (item !== undefined) next.splice(to, 0, item); return next; }

function ReviewReadView({ content }: { content: CaseReviewContent }) {
  return <div className="review-read-view">
    <dl><div><dt>描述</dt><dd>{content.description || "无补充描述"}</dd></div><div><dt>前置条件</dt><dd>{content.preconditions.length ? <ul>{content.preconditions.map((line, index) => <li key={index}>{line}</li>)}</ul> : "无前置条件"}</dd></div></dl>
    <h4>步骤与预期</h4><ol className="review-read-steps">{content.steps.map((step, index) => <li key={index}><div><strong>操作</strong><p>{step.action}</p></div><div><strong>预期</strong><ul>{step.expected.map((line, position) => <li key={position}>{line}</li>)}</ul></div></li>)}</ol>
    <details><summary>测试数据</summary><pre>{JSON.stringify(content.testData, null, 2)}</pre></details>
  </div>;
}
