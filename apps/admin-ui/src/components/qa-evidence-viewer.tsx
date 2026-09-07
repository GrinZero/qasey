import { CircleAlert, Maximize2, MonitorPlay, Play, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { EvidenceTimeline, EvidenceStepTiming } from "../../../../packages/e2e/src/evidence-timeline";
import type { CaseHubCaseVersion, CaseHubResult } from "../types";
import { selectTraceStep } from "./evidence-step-selection";

type Mode = "video" | "trace";
type Selection = { timing: EvidenceStepTiming; revision: number };

export function QaEvidenceViewer({ result, steps = [] }: { result: CaseHubResult; steps?: CaseHubCaseVersion["steps"] }) {
  const videos = result.artifacts.filter(artifact => artifact.kind === "video");
  const traces = result.artifacts.filter(artifact => artifact.kind === "trace" && /(?:^|\/)trace\.zip$/iu.test(artifact.name.replaceAll("\\", "/")));
  const [preferredMode, setMode] = useState<Mode>(videos.length ? "video" : "trace");
  const mode: Mode = preferredMode === "video" && !videos.length ? "trace" : preferredMode === "trace" && !traces.length ? "video" : preferredMode;
  const [expanded, setExpanded] = useState(false);
  const [timeline, setTimeline] = useState<EvidenceTimeline>({ steps: [] });
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState(-1);
  const [selection, setSelection] = useState<Selection>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setTimeline({ steps: [] }); setSelection(undefined); setActiveStep(-1);
    void fetch(`/v1/case-hub/results/${encodeURIComponent(result.id)}/evidence-timeline`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Timeline unavailable"); return await response.json() as EvidenceTimeline; })
      .then(setTimeline)
      .catch(() => { if (!controller.signal.aborted) setTimeline({ steps: [], unavailableReason: "步骤索引暂不可用，可以手动播放视频或查看 Trace。" }); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [result.id]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [expanded]);
  const artifact = mode === "video" ? videos.find(item => item.id === timeline.videoArtifactId) ?? videos[0] : traces.find(item => item.id === timeline.traceArtifactId) ?? traces[0];
  const passed = result.executionStatus === "passed";
  const chooseStep = (timing: EvidenceStepTiming) => { setActiveStep(timing.index); setSelection(current => ({ timing, revision: (current?.revision ?? 0) + 1 })); };
  const followTime = (time: number) => {
    const current = timeline.steps.filter(item => item.videoStartMs !== undefined && item.videoStartMs <= time * 1_000).at(-1);
    if (current) setActiveStep(current.index);
  };
  if (!artifact) return <MissingEvidence message="本次运行没有生成 E2E 视频或 Playwright Trace。日志和报告文件不能替代人工验收。" />;
  const navigator = <section className="evidence-steps" aria-label="按验收步骤核对"><header><div><h3>按验收步骤核对</h3><p>{loading ? "正在读取真实执行时间…" : timeline.unavailableReason ?? (mode === "video" ? "按执行时间定位，视频以 Trace 首帧对齐，可能有首帧偏差；缺少映射时请手动核对。" : "点击步骤会在 Trace 中选中并展开对应执行分组。")}</p></div></header><ol>{steps.map((step, index) => {
    const timing = timeline.steps.find(item => item.index === index);
    const available = timing && (mode === "trace" || timing.videoStartMs !== undefined);
    return <li key={index}><button type="button" disabled={!available} className={activeStep === index ? "active" : ""} aria-current={activeStep === index ? "step" : undefined} aria-label={`验收步骤 ${index + 1}：${step.action}`} onClick={() => timing && chooseStep(timing)}><span className="evidence-step-index">{String(index + 1).padStart(2, "0")}</span><span className="evidence-step-copy"><strong>{step.action}</strong><small>{step.expected.join("；")}</small></span><span className="evidence-step-anchor">{!available ? "无时间映射" : mode === "video" ? formatMediaTime(timing.videoStartMs! / 1_000) : `Step ${String(index + 1).padStart(2, "0")}`}</span></button></li>;
  })}</ol></section>;
  const controls = <div className="evidence-modes">{videos.length > 0 && <button type="button" className={mode === "video" ? "active" : ""} onClick={() => setMode("video")}><Play size={14} />播放视频</button>}{traces.length > 0 && <button type="button" className={mode === "trace" ? "active" : ""} onClick={() => setMode("trace")}><MonitorPlay size={14} />调试 Trace</button>}</div>;
  const stage = <EvidenceStage key={`${result.id}:${artifact.id}:${expanded}`} result={result} mode={mode} artifact={artifact} selection={selection} onTimeChange={followTime} expanded={expanded} />;
  return <><section className={`qa-evidence${passed ? "" : " qa-evidence--failed"}`}><header><div><span className={passed ? "evidence-live" : "evidence-live evidence-live--failed"}><i />{passed ? "QA 有效证据" : "失败诊断 · 不可批准"}</span><strong>{mode === "video" ? "E2E 运行录像" : "Playwright 调试器"}</strong></div><div className="evidence-view-controls">{controls}<button className="evidence-expand" type="button" onClick={() => setExpanded(true)} aria-label={mode === "video" ? "放大视频" : "放大 Trace"}><Maximize2 size={15} /></button></div></header>{!expanded && stage}<footer><span>{passed ? "本次验证证据" : `执行${executionStatusLabel(result.executionStatus)}`}</span><code>{artifact.name.split("/").at(-1)}</code></footer></section>{!expanded && steps.length > 0 && navigator}{expanded && <dialog ref={dialogRef} className="evidence-lightbox" aria-labelledby={titleId} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }} onCancel={event => { event.preventDefault(); event.stopPropagation(); event.currentTarget.close(); }} onClose={event => { if (!event.currentTarget.open) setExpanded(false); }}><header><strong id={titleId}>{result.caseId} · {mode === "video" ? "E2E 运行录像" : "Playwright 调试器"}</strong><div className="evidence-view-controls">{controls}<button className="evidence-expand" type="button" onClick={() => dialogRef.current?.close()} aria-label="关闭放大查看"><X size={17} /></button></div></header>{stage}{steps.length > 0 && navigator}</dialog>}</>;
}

function EvidenceStage({ result, mode, artifact, expanded, selection, onTimeChange }: { result: CaseHubResult; mode: Mode; artifact: CaseHubResult["artifacts"][number]; expanded: boolean; selection: Selection | undefined; onTimeChange: (time: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(0);
  const [traceStatus, setTraceStatus] = useState("");
  const url = `/v1/case-hub/runs/${encodeURIComponent(result.runId)}/artifacts/${encodeURIComponent(artifact.id)}`;
  const traceUrl = typeof window === "undefined" ? url : new URL(url, window.location.origin).href;
  useEffect(() => {
    if (!selection) return;
    if (mode === "video") {
      const video = videoRef.current;
      if (!video || video.readyState < 1 || selection.timing.videoStartMs === undefined) return;
      video.currentTime = Math.min(selection.timing.videoStartMs / 1_000, Math.max(0, video.duration - .04));
      void video.play().catch(() => undefined);
      return;
    }
    const document = frameRef.current?.contentDocument;
    if (!document) return;
    setTraceStatus("正在定位 Trace 步骤…");
    let done = false;
    const attempt = () => {
      if (done || !selectTraceStep(document, selection.timing.title)) return;
      done = true; observer.disconnect(); clearTimeout(timeout);
      setTraceStatus(`Trace 已定位 Step ${String(selection.timing.index + 1).padStart(2, "0")}`);
    };
    const observer = new MutationObserver(attempt);
    const timeout = window.setTimeout(() => { observer.disconnect(); if (!done) setTraceStatus("未找到对应执行分组，请在 Trace 中手动定位。"); }, 15_000);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "aria-expanded"] });
    attempt();
    return () => { done = true; observer.disconnect(); clearTimeout(timeout); };
  }, [selection, mode, loaded]);
  return <div className={expanded ? "evidence-stage evidence-stage--expanded" : "evidence-stage"}>{mode === "video" ? <video ref={videoRef} controls playsInline preload="metadata" src={url} onLoadedMetadata={() => setLoaded(value => value + 1)} onTimeUpdate={event => onTimeChange(event.currentTarget.currentTime)}>当前浏览器无法播放该 E2E 视频。</video> : <iframe ref={frameRef} onLoad={() => setLoaded(value => value + 1)} title={`${result.caseId} Playwright Trace Viewer`} sandbox="allow-scripts allow-same-origin" src={`/v1/case-hub/trace-viewer/index.html?trace=${encodeURIComponent(traceUrl)}`} />}{mode === "trace" && traceStatus && <p className="evidence-selection-status" role="status">{traceStatus}</p>}</div>;
}

export function MissingEvidence({ message }: { message: string }) {
  return <div className="missing-evidence"><CircleAlert size={23} /><strong>没有可审阅证据</strong><p>{message}</p></div>;
}
function formatMediaTime(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}.${String(Math.floor((seconds - rounded) * 100)).padStart(2, "0")}`;
}
function executionStatusLabel(status: string): string {
  return ({ passed: "通过", failed: "失败", blocked: "阻塞", skipped: "跳过" } as Record<string, string>)[status] ?? status;
}
