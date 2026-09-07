import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, FileText, ChevronRight } from "lucide-react";
import { api, ApiError } from "../api";
import type { Artifact, QaseyRun } from "../types";

export function evidenceType(artifact: Artifact): "image" | "video" | "trace" | "internal" {
  const name = artifact.name.toLowerCase();
  if (/\.(png|jpe?g|webp)$/.test(name) || artifact.contentType?.startsWith("image/") && !name.endsWith(".svg")) return "image";
  if (/\.(webm|mp4)$/.test(name) || artifact.contentType?.startsWith("video/")) return "video";
  if (/(^|\/)trace\.zip$/.test(name) || artifact.kind === "trace" && name.endsWith(".zip")) return "trace";
  return "internal";
}

export function runConclusion(run: QaseyRun): { title: string; detail: string } {
  if (run.status === "failed") {
    if (/heartbeat|recovery window/i.test(run.error ?? "")) return { title: "运行中断，尚未取得完整结论", detail: "执行进程未在规定时间内报告进度。本次运行不能作为测试通过的依据，请结合已有证据排查后重新运行。" };
    if (/mirror|TLS|handshake|repo.install/i.test(run.error ?? "")) return { title: "测试环境准备失败", detail: "代码获取或依赖准备遇到错误。需要先恢复环境，再验证产品行为。" };
    if (/did not pass/i.test(run.error ?? "")) return { title: "自动验证未通过", detail: "多轮验证和修复后仍有检查失败。请核对失败画面与用例预期，再判断是产品问题、测试脚本还是环境问题。" };
    return { title: "本次运行未完成", detail: "执行过程中发生错误，尚不能确认测试通过。可展开下方技术详情查看原始错误。" };
  }
  if (run.status === "succeeded") return { title: "本次运行已完成", detail: "请按用例核对执行结果与证据，具体结论以各条用例的记录为准。" };
  if (run.status === "awaiting_qa") return { title: "自动验证通过，等待人工审核", detail: "请对照用例步骤查看执行画面，再进入审核页提交结论。" };
  if (run.status === "cancelled") return { title: "本次运行已取消", detail: "取消前的证据仍可查看，本次运行不代表测试已通过。" };
  return { title: "测试正在进行", detail: "用例结果和执行画面将在验证过程中陆续出现。" };
}

function artifactUrl(run: QaseyRun, artifact: Artifact) {
  return `/v1/case-hub/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`;
}

export function RunReport({ run, onClose }: { run: QaseyRun; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getChangeSet>>>();
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let active = true;
    setData(undefined); setLoadError("");
    void api.getChangeSet(run.changeSetId).then(value => { if (active) setData(value); }).catch(error => {
      if (active) setLoadError(error instanceof ApiError && error.status === 404 ? "未找到关联用例，历史运行记录仍可查看。" : "用例结果暂时无法读取，请稍后重新打开。" );
    });
    return () => { active = false; };
  }, [run.changeSetId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", close);
    return () => { document.body.style.overflow = overflow; window.removeEventListener("keydown", close); previous?.focus(); };
  }, [onClose]);
  const conclusion = runConclusion(run);
  const results = data?.results.filter(result => result.runId === run.id) ?? [];
  const latest = data?.versions.map(version => ({ version, result: results.filter(result => result.caseVersionId === version.id).sort((a, b) => b.attempt - a.attempt)[0] })) ?? [];
  const artifacts = [...new Map([...run.artifacts, ...results.flatMap(result => result.artifacts)].map(artifact => [artifact.id, artifact])).values()];
  const visual = artifacts.filter(artifact => ["image", "video"].includes(evidenceType(artifact)));
  const traces = artifacts.filter(artifact => evidenceType(artifact) === "trace");
  const raw = artifacts.filter(artifact => evidenceType(artifact) === "internal");
  return createPortal(<div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="run-dialog run-report" role="dialog" aria-modal="true" aria-labelledby="run-dialog-title">
      <header className="run-report-head"><div><p>测试运行 · {new Date(run.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</p><h2 id="run-dialog-title">{data?.changeSet.requirement.goal || `${run.repository.repository} 测试结果`}</h2><span>{run.repository.repository} · {run.framework === "playwright" ? "浏览器测试" : "应用测试"} · {run.repository.baseRef}</span></div><button autoFocus className="icon-button bordered" onClick={onClose} aria-label="关闭运行详情"><X size={18} /></button></header>
      <div className="run-report-body">
        <section className={`run-verdict run-verdict--${run.status}`}><span>运行结论</span><h3>{conclusion.title}</h3><p>{conclusion.detail}</p>{run.status === "awaiting_qa" && <a href="/admin/apps/qasey/reviews">审核用例结果 <ChevronRight size={16} /></a>}{run.pullRequestUrl && <a href={run.pullRequestUrl} target="_blank" rel="noreferrer">查看测试代码变更 <ChevronRight size={16} /></a>}</section>
        <section className="run-report-section"><h3>测试了什么 <span>{latest.length ? `${latest.length} 条用例` : ""}</span></h3>{loadError ? <p role="status">{loadError}</p> : !data ? <p role="status">正在读取用例结果…</p> : !latest.length ? <p>这次运行没有关联的文字用例。</p> : <ol className="run-case-results">{latest.map(({ version, result }) => <li key={version.id}><div><small>{version.caseId} · {version.priority}</small><strong>{version.title}</strong>{result?.feedback && <p>{result.feedback}</p>}</div><span className={`result-pill result-pill--${result?.executionStatus ?? "unknown"}`}>{!result ? "未取得结果" : ({ passed: "通过", failed: "未通过", skipped: "未执行", blocked: "受阻", error: "执行异常" }[result.executionStatus] ?? "等待结果")}</span></li>)}</ol>}</section>
        <section className="run-report-section"><h3>执行画面 <span>{visual.length ? `${visual.length} 项` : ""}</span></h3><p className="run-section-hint">对照用例步骤核对实际行为；失败画面不代表用例通过。</p>{visual.length ? <div className="run-visual-evidence">{visual.map((artifact, index) => <figure key={artifact.id}>{evidenceType(artifact) === "image" ? <a href={artifactUrl(run, artifact)} target="_blank" rel="noreferrer" aria-label={`查看截图 ${index + 1}`}><img loading="lazy" src={artifactUrl(run, artifact)} alt={`执行截图 ${index + 1}`} /></a> : <video controls preload="none" src={artifactUrl(run, artifact)} />}<figcaption>{evidenceType(artifact) === "image" ? "截图" : "执行录像"} {index + 1}<small>{latest.find(({ result }) => result?.artifacts.some(item => item.id === artifact.id))?.version.title ?? "本次运行采集 · 未关联具体用例"}</small></figcaption></figure>)}</div> : <div className="run-no-evidence"><FileText size={24} /><strong>没有可查看的截图或录像</strong><p>本次记录未包含可直接核对产品行为的画面。日志和内部文件不能替代这些证据。</p></div>}{traces.length > 0 && <details className="run-technical"><summary>交互追踪 · {traces.length} 份</summary><p>供排查使用，下载后需用 Playwright Trace Viewer 打开。</p>{traces.map((artifact, index) => <a key={artifact.id} href={artifactUrl(run, artifact)} target="_blank" rel="noreferrer">下载交互追踪 {index + 1}</a>)}</details>}</section>
        <details className="run-technical"><summary>技术详情与原始文件 · {raw.length} 项</summary><p>供开发人员排查。包括执行日志、内部上下文和报告资源，不作为人工审核结论。</p><dl><dt>运行编号</dt><dd>{run.id}</dd></dl>{run.error && <pre className="run-error-log">{run.error}</pre>}<div className="run-raw-files">{raw.map(artifact => <a key={artifact.id} href={artifactUrl(run, artifact)} target="_blank" rel="noreferrer">{artifact.name}<ChevronRight size={14} /></a>)}</div></details>
      </div>
    </section>
  </div>, document.body);
}
