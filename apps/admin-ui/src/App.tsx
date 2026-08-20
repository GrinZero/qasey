import {
  Activity,
  AppWindow,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileSearch,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
  MonitorPlay,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TestTube2,
  Terminal,
  UserRound,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { AgentApplication, AuditRecord, CatalogEntry, QaseyRun, RunStatus, SandboxSessionState, Session } from "./types";

type View = "platform-home" | "inbox" | "activity" | "qasey-overview" | "qasey-runs" | "qasey-review" | "qasey-cua" | "access";
type AuthState = { kind: "loading" } | { kind: "anonymous"; message?: string } | { kind: "authenticated"; session: Session };

const statusMeta: Record<RunStatus, { label: string; tone: string; step: number }> = {
  queued: { label: "等待开始", tone: "neutral", step: 0 },
  preparing_workspace: { label: "准备环境", tone: "progress", step: 1 },
  authoring: { label: "设计测试", tone: "progress", step: 2 },
  author_running: { label: "执行测试", tone: "progress", step: 3 },
  repairing: { label: "修复重试", tone: "warning", step: 3 },
  clean_verifying: { label: "验证结果", tone: "progress", step: 4 },
  awaiting_qa: { label: "等待审阅", tone: "review", step: 5 },
  succeeded: { label: "已通过", tone: "success", step: 6 },
  failed: { label: "未通过", tone: "danger", step: 6 },
  cancelled: { label: "已取消", tone: "neutral", step: 6 },
};

const activeStatuses: RunStatus[] = ["queued", "preparing_workspace", "authoring", "author_running", "repairing", "clean_verifying"];
const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" });
const evidenceStages = [
  [FileSearch, "需求"], [Settings2, "环境"], [Bot, "设计"], [Play, "执行"], [ShieldCheck, "验证"], [ClipboardCheck, "审阅"],
] as const;

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [view, setView] = useState<View>(() => window.location.hash === "#apps/qasey" ? "qasey-overview" : "platform-home");
  const [menuOpen, setMenuOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [applications, setApplications] = useState<AgentApplication[]>([]);
  const [runs, setRuns] = useState<QaseyRun[]>([]);
  const [dataError, setDataError] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(false);

  const loadWorkspace = useCallback(async () => {
    setLoadingRuns(true);
    setDataError("");
    try {
      const [catalogResponse, applicationsResponse, runsResponse] = await Promise.all([api.catalog(), api.applications(), api.listRuns()]);
      setCatalog(catalogResponse);
      setApplications(applicationsResponse);
      setRuns(runsResponse.runs);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) setDataError(errorMessage(error));
    } finally {
      setLoadingRuns(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const error = new URLSearchParams(window.location.search).get("error");
    api.session()
      .then(session => {
        if (!active) return;
        setAuth({ kind: "authenticated", session });
        window.history.replaceState({}, "", window.location.hash === "#apps/qasey" ? "/admin#apps/qasey" : "/admin");
      })
      .catch(() => {
        if (active) setAuth({ kind: "anonymous", ...(error ? { message: friendlySsoError(error) } : {}) });
      });
    const unauthorized = () => setAuth({ kind: "anonymous", message: "登录已过期。重新登录后，你的草稿仍会保留。" });
    window.addEventListener("qasey:unauthorized", unauthorized);
    return () => {
      active = false;
      window.removeEventListener("qasey:unauthorized", unauthorized);
    };
  }, []);

  useEffect(() => {
    if (auth.kind !== "authenticated") return;
    void loadWorkspace();
  }, [auth.kind, loadWorkspace]);

  useEffect(() => {
    if (auth.kind !== "authenticated" || !runs.some(run => activeStatuses.includes(run.status))) return;
    const id = window.setInterval(() => void loadWorkspace(), 8000);
    return () => window.clearInterval(id);
  }, [auth.kind, loadWorkspace, runs]);

  if (auth.kind === "loading") return <BootScreen />;
  if (auth.kind === "anonymous") return <LoginScreen message={auth.message} />;

  const activeCount = runs.filter(run => activeStatuses.includes(run.status)).length;
  const reviewCount = runs.filter(run => run.status === "awaiting_qa").length;
  const platformNav: Array<{ id: View; label: string; icon: typeof Gauge; badge?: number }> = [
    { id: "platform-home", label: "平台首页", icon: LayoutDashboard },
    { id: "inbox", label: "待处理", icon: Inbox, badge: reviewCount },
    { id: "activity", label: "活动", icon: Activity, badge: activeCount },
  ];
  const qaseyNav: Array<{ id: View; label: string; icon: typeof Gauge; badge?: number }> = [
    { id: "qasey-overview", label: "工作台", icon: MessageSquareText },
    { id: "qasey-runs", label: "测试运行", icon: Activity, badge: activeCount },
    { id: "qasey-review", label: "待我审阅", icon: ClipboardCheck, badge: reviewCount },
    { id: "qasey-cua", label: "Ubuntu 工作台", icon: MonitorPlay },
  ];
  const qaseyActive = view.startsWith("qasey-");
  const currentLabel = [...platformNav, ...qaseyNav, { id: "access" as View, label: "访问与审计", icon: ShieldCheck }].find(item => item.id === view)?.label ?? "平台首页";

  const logout = async () => {
    try { await api.logout(); } finally { setAuth({ kind: "anonymous" }); }
  };
  const openApplication = (application: AgentApplication) => {
    setMenuOpen(false);
    if (application.id === "qasey") {
      window.history.replaceState({}, "", application.homePath);
      setView("qasey-overview");
      return;
    }
    window.location.assign(application.homePath);
  };

  return (
    <div className="app-shell">
      <aside className={menuOpen ? "sidebar sidebar--open" : "sidebar"}>
        <div className="brand">
          <BrandMark />
          <div><strong>MoeGo Agents</strong><span>Application platform</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMenuOpen(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>
        <button className="new-task" onClick={() => { setView("qasey-overview"); setMenuOpen(false); }}>
          <Plus size={17} /> 发起工作 <span>⌘ K</span>
        </button>
        <nav className="nav-list" aria-label="主导航">
          <p className="nav-label">平台</p>
          {platformNav.map(item => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => { setView(item.id); setMenuOpen(false); }} />)}
          <p className="nav-label application-label">Applications</p>
          {applications.map(application => <button key={application.id} className={application.id === "qasey" && qaseyActive ? "application-nav active" : "application-nav"} onClick={() => openApplication(application)}><span className={`app-glyph ${application.id === "qasey" ? "qasey" : "generic"}`}>{application.id === "qasey" ? <TestTube2 size={16} /> : <Bot size={16} />}</span><span><strong>{application.name}</strong><small>{application.category}</small></span><ChevronRight size={15} /></button>)}
          {qaseyActive && <div className="application-subnav">{qaseyNav.map(item => <NavButton key={item.id} item={item} active={view === item.id} onClick={() => { setView(item.id); setMenuOpen(false); }} />)}</div>}
          {auth.session.isAdmin && <><p className="nav-label application-label">管理</p><NavButton item={{ label: "访问与审计", icon: ShieldCheck }} active={view === "access"} onClick={() => { setView("access"); setMenuOpen(false); }} /></>}
        </nav>
        <div className="sidebar-spacer" />
        <div className="environment-card">
          <span className="health-dot" />
          <div><strong>Agent Runtime</strong><span>{applications.length} 个 Application 在线</span></div>
        </div>
        <div className="sidebar-user">
          <Avatar label={auth.session.email ?? auth.session.subjectId} />
          <div><strong>{displayName(auth.session)}</strong><span>{auth.session.tenantId}</span></div>
          <button className="icon-button" onClick={logout} aria-label="退出登录" title="退出登录"><LogOut size={17} /></button>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" onClick={() => setMenuOpen(false)} aria-label="关闭导航" />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="打开导航"><Menu size={21} /></button>
          <div className="breadcrumbs"><span>MoeGo Agents</span><ChevronRight size={14} />{qaseyActive && <><span>Qasey</span><ChevronRight size={14} /></>}<strong>{currentLabel}</strong></div>
          <div className="topbar-actions">
            <div className="search-box"><Search size={16} /><span>搜索 Agent、任务或运行</span><kbd>⌘ /</kbd></div>
            <button className="avatar-button" aria-label="账户菜单"><Avatar label={auth.session.email ?? auth.session.subjectId} /></button>
          </div>
        </header>
        <div className="page">
          {dataError && <InlineError message={dataError} action="重新加载" onAction={loadWorkspace} />}
          {view === "platform-home" && <PlatformHome applications={applications} runs={runs} loading={loadingRuns} onOpenApplication={openApplication} onOpenInbox={() => setView("inbox")} />}
          {view === "inbox" && <UnifiedInbox runs={runs} onOpenQaseyReview={() => setView("qasey-review")} />}
          {view === "activity" && <ActivityView runs={runs} loading={loadingRuns} onRefresh={loadWorkspace} />}
          {view === "qasey-overview" && <Overview catalog={catalog} runs={runs} loading={loadingRuns} onRefresh={loadWorkspace} onOpenRuns={() => setView("qasey-runs")} />}
          {view === "qasey-runs" && <RunsView runs={runs} loading={loadingRuns} onRefresh={loadWorkspace} />}
          {view === "qasey-review" && <ReviewView runs={runs} onChanged={loadWorkspace} />}
          {view === "qasey-cua" && <CuaView subjectId={auth.session.subjectId} />}
          {view === "access" && auth.session.isAdmin && <AccessView session={auth.session} />}
        </div>
      </main>
    </div>
  );
}

function BootScreen() {
  return <div className="boot-screen"><BrandMark /><LoaderCircle className="spin" size={22} /><span>正在进入 Agent Platform…</span></div>;
}

function LoginScreen({ message }: { message: string | undefined }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(message ?? "");
  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const { url } = await api.loginUrl();
      window.location.assign(url);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setLoading(false); }
  };
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand"><BrandMark /><strong>MoeGo Agents</strong><span>Application platform</span></div>
        <div className="story-copy">
          <p className="eyebrow">Agent applications, one place</p>
          <h1>让每一个 Agent，<br />都有自己的工作方式。</h1>
          <p>统一发现、委派和审阅不同领域的 Agent 工作，同时保留每个 Application 独有的业务体验。</p>
        </div>
        <div className="login-rail" aria-label="Agent Platform 工作流程">
          {[
            [Boxes, "发现", "找到适合当前工作的 Agent"],
            [Sparkles, "委派", "用业务语言发起一项工作"],
            [Inbox, "交接", "集中处理需要人工判断的事项"],
            [ShieldCheck, "治理", "权限、运行与审计保持可追溯"],
          ].map(([Icon, title, text], index) => {
            const RailIcon = Icon as typeof FileSearch;
            return <div className="login-rail-step" key={String(title)}><span><RailIcon size={17} /></span><div><strong>{String(title)}</strong><small>{String(text)}</small></div>{index < 3 && <i />}</div>;
          })}
        </div>
        <div className="story-foot">MoeGo Agent Platform · Protected workspace</div>
      </section>
      <section className="login-panel">
        <div className="login-box">
          <p className="eyebrow">欢迎回来</p>
          <h2>登录 Agent Platform</h2>
          <p className="login-note">使用你的 MoeGo Google Workspace 账户继续。</p>
          {error && <div className="login-error" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
          <button className="google-button" onClick={login} disabled={loading}>
            {loading ? <LoaderCircle className="spin" size={19} /> : <GoogleGlyph />}
            {loading ? "正在前往 Google…" : "使用 Google 登录"}
            {!loading && <ArrowRight size={18} />}
          </button>
          <div className="security-note"><ShieldCheck size={16} /><span>仅允许已获授权的组织账户。MoeGo Agents 不会存储你的 Google 密码。</span></div>
        </div>
      </section>
    </main>
  );
}

function PlatformHome({ applications, runs, loading, onOpenApplication, onOpenInbox }: { applications: AgentApplication[]; runs: QaseyRun[]; loading: boolean; onOpenApplication: (application: AgentApplication) => void; onOpenInbox: () => void }) {
  const active = runs.filter(run => activeStatuses.includes(run.status));
  const review = runs.filter(run => run.status === "awaiting_qa");
  return <>
    <PageHeading eyebrow="MoeGo Agent Platform" title="工作交给 Agent，判断留给人" description="从一个入口找到合适的 Agent Application，并集中处理所有需要你介入的工作。" />
    <section className="surface handoff-runway" aria-label="Agent 工作流概览">
      <div className="runway-copy"><span className="platform-kicker">Live workstream</span><h2>每项工作都进入正确的 Application</h2><p>平台负责路由、身份和交接；Application 保留自己的业务流程。</p></div>
      <div className="runway-flow">
        <div className="runway-node source"><span><Inbox size={17} /></span><div><strong>新工作</strong><small>需求与任务入口</small></div></div>
        <i><ArrowRight size={15} /></i>
        <div className="runway-apps">{applications.length ? applications.slice(0,3).map(application => <span className={`mini-app ${application.accent}`} key={application.id} title={application.name}>{application.name.slice(0,1)}</span>) : <span className="mini-app neutral">—</span>}</div>
        <i><ArrowRight size={15} /></i>
        <button className="runway-node handoff" onClick={onOpenInbox}><span><UserRound size={17} /></span><div><strong>{review.length ? `${review.length} 项待处理` : "无需介入"}</strong><small>统一人工交接</small></div></button>
      </div>
    </section>
    <div className="platform-grid">
      <section>
        <div className="platform-section-head"><div><h2>Applications</h2><p>已为你启用的 Agent 工作空间</p></div><span>{applications.length} online</span></div>
        <div className="application-grid">
          {applications.map(application => <article className={`surface application-card accent-${application.accent}`} key={application.id}>
            <div className="application-card-head"><span className={`app-glyph ${application.id === "qasey" ? "qasey" : "generic"}`}>{application.id === "qasey" ? <TestTube2 size={19} /> : <Bot size={19} />}</span><span className="online-badge"><i />在线</span></div>
            <p className="app-category">{application.category}</p><h3>{application.name}</h3><p className="app-description">{application.description}</p>
            <div className="capability-list">{application.capabilities.map(capability => <span key={capability}>{capability}</span>)}</div>
            <div className="application-metrics"><div><strong>{application.id === "qasey" ? active.length : 0}</strong><span>进行中</span></div><div><strong>{application.id === "qasey" ? review.length : 0}</strong><span>待处理</span></div><button onClick={() => onOpenApplication(application)}>打开工作空间 <ArrowRight size={15} /></button></div>
          </article>)}
          {!loading && applications.length === 0 && <EmptyState icon={AppWindow} title="没有可用的 Application" text="请联系平台管理员分配访问权限。" />}
        </div>
      </section>
      <section className="surface handoff-panel">
        <div className="list-heading"><div><h2>需要你的判断</h2><p>跨 Application 的统一 Inbox</p></div><button className="text-button" onClick={onOpenInbox}>全部 <ArrowRight size={15} /></button></div>
        {review.length ? <div className="handoff-list">{review.slice(0,4).map(run => <button key={run.id} onClick={onOpenInbox}><span className="app-glyph qasey"><TestTube2 size={15} /></span><div><strong>{run.repository.owner}/{run.repository.repository}</strong><small>Qasey · 等待 QA 审阅 · {formatRelative(run.updatedAt)}</small></div><ChevronRight size={16} /></button>)}</div> : <div className="handoff-empty"><CheckCircle2 size={22} /><strong>当前没有待处理事项</strong><span>Agent 需要人工判断时会汇总到这里。</span></div>}
      </section>
    </div>
    <section className="surface platform-activity-preview"><div className="list-heading"><div><h2>最近活动</h2><p>所有 Application 的运行记录</p></div><span className="live-label"><i />实时更新</span></div><RunTable runs={runs.slice(0,4)} loading={loading} /></section>
  </>;
}

function UnifiedInbox({ runs, onOpenQaseyReview }: { runs: QaseyRun[]; onOpenQaseyReview: () => void }) {
  const pending = runs.filter(run => run.status === "awaiting_qa");
  return <><PageHeading eyebrow="Unified Inbox" title="需要你的判断" description="不同 Agent Application 的人工交接集中在这里，同时保留原始上下文和业务动作。" />
    <div className="inbox-layout"><section className="surface inbox-list"><div className="inbox-toolbar"><div className="segmented"><button className="active">待处理 <span>{pending.length}</span></button><button>已完成</button></div><button className="filter-button"><ListFilter size={15} />筛选 Application</button></div>{pending.length ? pending.map(run => <button className="inbox-item" key={run.id} onClick={onOpenQaseyReview}><span className="app-glyph qasey"><TestTube2 size={17} /></span><div className="inbox-item-body"><span className="app-category">Qasey · QA approval</span><strong>{run.repository.owner}/{run.repository.repository} 等待审阅</strong><p>{run.artifacts.length} 项证据已就绪，需要决定批准或要求修改。</p><small><Clock3 size={13} />{formatRelative(run.updatedAt)} · <code>{compactId(run.id)}</code></small></div><span className="status-badge review"><ClipboardCheck size={14} />等待审阅</span><ChevronRight size={17} /></button>) : <div className="handoff-empty tall"><CheckCircle2 size={24} /><strong>Inbox 已清空</strong><span>暂时没有 Agent 需要你的判断。</span></div>}</section><aside className="inbox-guide"><span><Inbox size={20} /></span><h2>一个 Inbox，保留不同动作</h2><p>Qasey 请求 QA 结论；未来 Code Review 可以请求接受 Finding，CS Investigator 可以请求确认根因。平台只统一交接，不统一业务。</p></aside></div>
  </>;
}

function ActivityView({ runs, loading, onRefresh }: { runs: QaseyRun[]; loading: boolean; onRefresh: () => Promise<void> }) {
  return <><PageHeading eyebrow="Platform activity" title="所有 Agent 的工作轨迹" description="跨 Application 查看进行中、等待人工处理和已完成的工作。" action={<button className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} />刷新</button>} /><section className="surface runs-surface platform-runs"><div className="filter-row"><div className="segmented"><button className="active">全部 <span>{runs.length}</span></button><button>进行中 <span>{runs.filter(run => activeStatuses.includes(run.status)).length}</span></button><button>需介入 <span>{runs.filter(run => run.status === "awaiting_qa").length}</span></button></div><button className="filter-button"><Boxes size={15} />全部 Applications</button></div><RunTable runs={runs} loading={loading} expanded /></section></>;
}

function Overview({ catalog, runs, loading, onRefresh, onOpenRuns }: { catalog: CatalogEntry[]; runs: QaseyRun[]; loading: boolean; onRefresh: () => Promise<void>; onOpenRuns: () => void }) {
  const [prompt, setPrompt] = useState(() => localStorage.getItem("qasey:draft") ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const taskEntry = catalog.find(item => item.resourceType === "route" && item.resourceId === "qasey-task");
  const current = runs.find(run => activeStatuses.includes(run.status)) ?? runs[0];

  useEffect(() => { localStorage.setItem("qasey:draft", prompt); }, [prompt]);

  const submit = async () => {
    const value = prompt.trim();
    if (!value) { setError("先描述需要分析的需求或问题。"); return; }
    if (!taskEntry) { setError("当前账户没有可用的 QA 助手，请联系平台管理员。"); return; }
    setSubmitting(true); setError(""); setResult("");
    try {
      const response = await api.runQaseyTask(value);
      setResult(extractAgentText(response));
      setPrompt("");
      localStorage.removeItem("qasey:draft");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSubmitting(false); }
  };

  return (
    <>
      <PageHeading eyebrow="QA 工作台" title="把需求变成可验证的结论" description="描述测试目标，Qasey 会读取相关上下文、识别风险并组织下一步。" />
      <div className="overview-grid">
        <section className="surface composer-card">
          <div className="section-title"><div><span className="section-icon"><MessageSquareText size={18} /></span><div><h2>开始一项 QA 任务</h2><p>可以粘贴 Jira 链接、飞书文档或直接描述问题。</p></div></div><span className="availability"><i /> Qasey 就绪</span></div>
          <label className="sr-only" htmlFor="qa-prompt">QA 任务描述</label>
          <textarea id="qa-prompt" value={prompt} onChange={event => { setPrompt(event.target.value); setError(""); }} placeholder="例如：请分析预约改期功能的需求，重点检查跨时区、员工冲突和通知补发…" rows={7} aria-describedby={error ? "prompt-error" : undefined} />
          <div className="prompt-suggestions">
            {[
              "分析需求风险",
              "设计测试场景",
              "检查遗漏边界",
            ].map(item => <button key={item} onClick={() => setPrompt(current => current ? `${current}\n${item}` : item)}>{item}</button>)}
          </div>
          <div className="composer-footer">
            <span>{prompt.length > 0 ? `已输入 ${prompt.length} 字` : "草稿会自动保存在此设备"}</span>
            <button className="primary-button" onClick={submit} disabled={submitting || !prompt.trim()}>{submitting ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{submitting ? "正在分析…" : "开始分析"}</button>
          </div>
          {error && <p className="field-error" id="prompt-error" role="alert"><CircleAlert size={15} />{error}</p>}
          {result && <div className="analysis-result" aria-live="polite"><div><CheckCircle2 size={17} /><strong>分析已完成</strong></div><p>{result}</p></div>}
        </section>
        <section className="surface evidence-card">
          <div className="section-title compact"><div><span className="section-icon"><Activity size={18} /></span><div><h2>{current ? "当前证据轨" : "证据轨"}</h2><p>{current ? `${current.repository.owner}/${current.repository.repository}` : "运行开始后在这里追踪"}</p></div></div>{current && <StatusBadge status={current.status} />}</div>
          {current ? <EvidenceRail run={current} /> : <EmptyRail />}
          {current && <button className="text-button rail-action" onClick={onOpenRuns}>查看运行详情 <ArrowRight size={15} /></button>}
        </section>
      </div>
      <section className="surface recent-section">
        <div className="list-heading"><div><h2>最近运行</h2><p>自动测试、修复与审阅进度</p></div><div><button className="icon-button bordered" onClick={() => void onRefresh()} disabled={loading} aria-label="刷新运行"><RefreshCw className={loading ? "spin" : ""} size={17} /></button><button className="text-button" onClick={onOpenRuns}>查看全部 <ArrowRight size={15} /></button></div></div>
        <RunTable runs={runs.slice(0, 5)} loading={loading} />
      </section>
    </>
  );
}

function RunsView({ runs, loading, onRefresh }: { runs: QaseyRun[]; loading: boolean; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<"all" | "active" | "review" | "done">("all");
  const filtered = useMemo(() => runs.filter(run => filter === "all" || filter === "active" && activeStatuses.includes(run.status) || filter === "review" && run.status === "awaiting_qa" || filter === "done" && ["succeeded", "failed", "cancelled"].includes(run.status)), [filter, runs]);
  return (
    <>
      <PageHeading eyebrow="测试运行" title="追踪每一次验证" description="查看执行阶段、证据产物和需要处理的异常。" action={<button className="secondary-button" onClick={() => void onRefresh()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} />刷新</button>} />
      <section className="surface runs-surface">
        <div className="filter-row"><div className="segmented" aria-label="筛选运行">{([['all','全部'],['active','进行中'],['review','待审阅'],['done','已结束']] as const).map(([id,label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}<span>{countFor(runs,id)}</span></button>)}</div><button className="filter-button"><ListFilter size={16} />更多筛选</button></div>
        <RunTable runs={filtered} loading={loading} expanded />
      </section>
    </>
  );
}

function ReviewView({ runs, onChanged }: { runs: QaseyRun[]; onChanged: () => Promise<void> }) {
  const reviewRuns = runs.filter(run => run.status === "awaiting_qa");
  return (
    <>
      <PageHeading eyebrow="人工关口" title="待我审阅" description="根据运行证据决定是否通过；要求修改时请留下可执行的反馈。" />
      {reviewRuns.length === 0 ? <EmptyState icon={ClipboardCheck} title="没有等待审阅的运行" text="新的运行进入人工关口后，会出现在这里。" /> : <div className="review-grid">{reviewRuns.map(run => <ReviewCard key={run.id} run={run} onChanged={onChanged} />)}</div>}
    </>
  );
}

function CuaView({ subjectId }: { subjectId: string }) {
  const [sessionId, setSessionId] = useState(`admin-${subjectId}`);
  const [targetUrl, setTargetUrl] = useState("https://example.com");
  const [mode, setMode] = useState<"desktop" | "browser">("desktop");
  const [state, setState] = useState<SandboxSessionState | null>(null);
  const [frameUrl, setFrameUrl] = useState("");
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const frameImage = useRef<HTMLImageElement>(null);
  const running = mode === "desktop" ? state?.desktop.running : state?.browser.running;

  const loadFrame = useCallback(async () => {
    if (!running) return;
    try {
      const frame = mode === "desktop" ? await api.desktopFrame(sessionId) : await api.browserFrame(sessionId);
      setFrameUrl(await blobDataUrl(frame.blob));
      if (mode === "browser") setState(current => current ? { ...current, browser: { ...current.browser, ...(frame.url ? { url: frame.url } : {}), ...(frame.title ? { title: frame.title } : {}) } } : current);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [mode, running, sessionId]);

  useEffect(() => {
    if (!running) return;
    void loadFrame();
    const timer = window.setInterval(() => void loadFrame(), 900);
    return () => window.clearInterval(timer);
  }, [loadFrame, running]);

  const start = async () => {
    setBusy(true); setError("");
    try {
      setState(mode === "desktop"
        ? await api.desktopStart(sessionId.trim(), { application: "browser", ...(targetUrl.trim() ? { url: targetUrl.trim() } : {}), recordVideo: true })
        : await api.browserStart(sessionId.trim(), targetUrl.trim() || undefined));
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const act = async (action: Record<string, unknown>) => {
    setError("");
    try {
      setState(mode === "desktop"
        ? await api.desktopAction(sessionId.trim(), action)
        : await api.browserAction(sessionId.trim(), action));
      await loadFrame();
    }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const stop = async () => {
    setBusy(true); setError("");
    try {
      if (mode === "desktop") setState(await api.desktopStop(sessionId.trim()));
      else { await api.sandboxStop(sessionId.trim()); setState(null); }
      setFrameUrl("");
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const launch = async (application: "browser" | "terminal" | "editor" | "files") => {
    setBusy(true); setError("");
    try {
      setState(await api.desktopApplication(sessionId.trim(), application, application === "browser" ? targetUrl.trim() || undefined : undefined));
      await loadFrame();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const clickFrame = (event: React.MouseEvent<HTMLButtonElement>) => {
    const image = frameImage.current;
    if (!image) return;
    const bounds = image.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * (image.naturalWidth / bounds.width);
    const y = (event.clientY - bounds.top) * (image.naturalHeight / bounds.height);
    void act({ action: "click", x, y });
  };
  const clickFrameCenter = () => {
    const image = frameImage.current;
    if (image) void act({ action: "click", x: image.naturalWidth / 2, y: image.naturalHeight / 2 });
  };

  return <>
    <PageHeading eyebrow="Computer use" title="Ubuntu 工作台" description="每个 sandbox Pod 是一台长期运行的 Ubuntu；会话独占 GUI 桌面，并使用自己的持久 workspace 与 home。" />
    {error && <InlineError message={error} />}
    <div className="segmented cua-mode" role="tablist" aria-label="控制模式">
      <button role="tab" aria-selected={mode === "desktop"} className={mode === "desktop" ? "active" : ""} disabled={Boolean(running)} onClick={() => { setMode("desktop"); setFrameUrl(""); }}>完整桌面</button>
      <button role="tab" aria-selected={mode === "browser"} className={mode === "browser" ? "active" : ""} disabled={Boolean(running)} onClick={() => { setMode("browser"); setFrameUrl(""); }}>Playwright 浏览器</button>
    </div>
    <section className="surface cua-toolbar">
      <label>会话 ID<input value={sessionId} disabled={Boolean(running)} onChange={event => setSessionId(event.target.value)} /></label>
      <label>浏览器地址<input value={targetUrl} onChange={event => setTargetUrl(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void (!running ? start() : mode === "browser" ? act({ action: "navigate", url: targetUrl }) : launch("browser")); }} /></label>
      {!running ? <button className="primary-button" disabled={busy || !sessionId.trim()} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}启动</button>
        : <button className="secondary-button danger-text" disabled={busy} onClick={() => void stop()}><Square size={15} />停止</button>}
    </section>
    <section className="surface cua-stage">
      <div className="cua-stage-head"><div><span className={running ? "health-dot" : "health-dot offline"} /><strong>{mode === "desktop" ? "Ubuntu Desktop" : state?.browser.title || "Sandbox browser"}</strong><small>{mode === "desktop" ? (state?.desktop.applications?.join(" · ") || "等待租用桌面") : state?.browser.url || "尚未启动"}</small></div>{state && <span>Pod {state.ordinal} · generation {state.generation}{mode === "desktop" && state.desktop.recording ? " · 正在录制" : ""}</span>}</div>
      {mode === "desktop" && running && <div className="cua-appbar" aria-label="Ubuntu 应用"><button onClick={() => void launch("browser")} disabled={busy}><MonitorPlay size={15} />浏览器</button><button onClick={() => void launch("terminal")} disabled={busy}><Terminal size={15} />终端</button><button onClick={() => void launch("editor")} disabled={busy}><FileText size={15} />编辑器</button><button onClick={() => void launch("files")} disabled={busy}><FolderOpen size={15} />文件</button></div>}
      <div className="cua-screen">{frameUrl ? <button className="cua-frame-button" onClick={clickFrame} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); clickFrameCenter(); } }} aria-label={`操作 Qasey sandbox ${mode === "desktop" ? "Ubuntu 桌面" : "浏览器"}画面`}><img ref={frameImage} src={frameUrl} alt={mode === "desktop" ? "Qasey Ubuntu desktop live view" : "Qasey sandbox browser live view"} /></button> : <div><MonitorPlay size={34} /><strong>启动后，实时画面会显示在这里</strong><span>{mode === "desktop" ? "可以操作浏览器、终端、编辑器和文件管理器。" : "点击画面可直接发送鼠标操作。"}</span></div>}</div>
      {running && <div className={`cua-controls ${mode === "desktop" ? "desktop" : ""}`}>{mode === "browser" && <><button className="icon-button bordered" onClick={() => void act({ action: "back" })} aria-label="后退">←</button><button className="icon-button bordered" onClick={() => void act({ action: "forward" })} aria-label="前进">→</button><button className="icon-button bordered" onClick={() => void act({ action: "reload" })} aria-label="刷新"><RefreshCw size={15} /></button></>}<label className="cua-type-field"><span>键盘输入</span><input value={typing} onChange={event => setTyping(event.target.value)} placeholder="输入发送到当前焦点…" onKeyDown={event => { if (event.key === "Enter" && typing) { void act({ action: "type", text: typing }); setTyping(""); } }} /></label><button className="secondary-button" disabled={!typing} onClick={() => { void act({ action: "type", text: typing }); setTyping(""); }}>发送</button></div>}
    </section>
  </>;
}

function ReviewCard({ run, onChanged }: { run: QaseyRun; onChanged: () => Promise<void> }) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decide = async (verdict: "approve" | "request_changes") => {
    if (verdict === "request_changes" && !feedback.trim()) { setError("要求修改时，请说明需要调整的内容。"); return; }
    if (verdict === "approve" && !window.confirm("确认批准这次运行？批准后将完成当前 QA 关口。")) return;
    setBusy(true); setError("");
    try { await api.verdict(run.id, verdict, feedback.trim()); await onChanged(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <section className="surface review-card"><div className="review-card-head"><div><span className="mono">{compactId(run.id)}</span><h2>{run.repository.owner}/{run.repository.repository}</h2><p>{run.framework === "playwright" ? "Web · Playwright" : "App · Maestro"} · {formatRelative(run.updatedAt)}</p></div><StatusBadge status={run.status} /></div><EvidenceRail run={run} compact /><div className="artifact-row">{run.artifacts.length ? run.artifacts.slice(0,4).map(item => <a key={item.id} href={`/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(item.id)}`} target="_blank" rel="noreferrer"><FileSearch size={15} />{item.name}</a>) : <span>此运行暂未上传证据产物</span>}</div><label htmlFor={`feedback-${run.id}`}>审阅反馈 <span>要求修改时必填</span></label><textarea id={`feedback-${run.id}`} rows={3} value={feedback} onChange={event => { setFeedback(event.target.value); setError(""); }} placeholder="指出需要修改的测试、证据或实现…" />{error && <p className="field-error" role="alert"><CircleAlert size={15} />{error}</p>}<div className="review-actions"><button className="secondary-button danger-text" disabled={busy} onClick={() => void decide("request_changes")}><RotateCcw size={16} />要求修改</button><button className="primary-button success-button" disabled={busy} onClick={() => void decide("approve")}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}批准运行</button></div></section>;
}

function AccessView({ session }: { session: Session }) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [role, setRole] = useState("");
  const [permission, setPermission] = useState("");
  const [subject, setSubject] = useState("");
  const [bindingRole, setBindingRole] = useState("");
  const load = useCallback(() => api.audit().then(response => setRecords(response.records)).catch(cause => setError(errorMessage(cause))), []);
  useEffect(() => { void load(); }, [load]);
  const grant = async () => {
    if (!role.trim() || !permission.trim()) { setError("角色和权限都不能为空。"); return; }
    if (!window.confirm(`确认在租户 ${session.tenantId} 中授予 ${role}：${permission}？`)) return;
    try { await api.grant(role.trim(), permission.trim()); setNotice("权限已授予，并已写入审计记录。"); setError(""); await load(); } catch (cause) { setError(errorMessage(cause)); }
  };
  const bind = async () => {
    if (!subject.trim() || !bindingRole.trim()) { setError("成员标识和角色都不能为空。"); return; }
    if (!window.confirm(`确认在租户 ${session.tenantId} 中为 ${subject} 绑定 ${bindingRole}？`)) return;
    try { await api.bind(subject.trim(), bindingRole.trim()); setNotice("成员角色已绑定，并已写入审计记录。"); setError(""); await load(); } catch (cause) { setError(errorMessage(cause)); }
  };
  return <><PageHeading eyebrow="平台管理" title="访问与审计" description={`所有变更仅作用于 ${session.tenantId}，并记录操作人与请求 ID。`} />{error && <InlineError message={error} />}{notice && <div className="success-notice"><CheckCircle2 size={17} />{notice}</div>}<div className="access-grid"><section className="surface access-card"><div className="section-title"><div><span className="section-icon"><KeyRound size={18} /></span><div><h2>角色权限</h2><p>为已有或新的角色授予一项权限。</p></div></div></div><label>角色<input value={role} onChange={event => setRole(event.target.value)} placeholder="例如 qa-lead" /></label><label>权限<input value={permission} onChange={event => setPermission(event.target.value)} placeholder="例如 qasey.runs.approve" /></label><button className="secondary-button" onClick={() => void grant()}>预览并授予</button></section><section className="surface access-card"><div className="section-title"><div><span className="section-icon"><UserRound size={18} /></span><div><h2>成员角色</h2><p>将组织成员绑定到一个角色。</p></div></div></div><label>成员标识<input value={subject} onChange={event => setSubject(event.target.value)} placeholder="Google subject ID" /></label><label>角色<input value={bindingRole} onChange={event => setBindingRole(event.target.value)} placeholder="例如 qa-lead" /></label><button className="secondary-button" onClick={() => void bind()}>预览并绑定</button></section></div><section className="surface audit-section"><div className="list-heading"><div><h2>最近审计</h2><p>访问判定与权限变更</p></div><button className="icon-button bordered" onClick={() => void load()} aria-label="刷新审计"><RefreshCw size={17} /></button></div>{records.length === 0 ? <p className="empty-row">暂无审计记录</p> : <div className="audit-list">{records.slice(0,50).map(record => <div key={`${record.requestId}-${record.resourceType}-${record.resourceId}-${record.action}`}><span className={`decision ${record.decision}`}>{record.decision === "allow" ? "允许" : "拒绝"}</span><div><strong>{record.action} · {record.resourceId}</strong><span>{record.subjectId ?? "匿名请求"} · {record.reason}</span></div><code>{compactId(record.requestId)}</code></div>)}</div>}</section></>;
}

function EvidenceRail({ run, compact = false }: { run: QaseyRun; compact?: boolean }) {
  const step = statusMeta[run.status].step;
  return <div className={compact ? "evidence-rail evidence-rail--compact" : "evidence-rail"}>{evidenceStages.map(([Icon,label],index) => { const done = index < step || run.status === "succeeded"; const active = index === Math.min(step,5) && !["succeeded","failed","cancelled"].includes(run.status); return <div className={`rail-step ${done ? "done" : ""} ${active ? "active" : ""}`} key={label}><span className="rail-node">{done ? <Check size={14} /> : <Icon size={15} />}</span><strong>{label}</strong>{!compact && <small>{railDetail(run,index)}</small>}{index < evidenceStages.length - 1 && <i />}</div>; })}</div>;
}

function EmptyRail() { return <div className="empty-rail"><div className="empty-rail-line" /><div><span><FileSearch size={17} /></span><span><Bot size={17} /></span><span><Play size={17} /></span><span><ClipboardCheck size={17} /></span></div><h3>证据会随运行逐步汇集</h3><p>从需求来源到最终结论，每个阶段都可以追溯。</p></div>; }

function RunTable({ runs, loading, expanded = false }: { runs: QaseyRun[]; loading: boolean; expanded?: boolean }) {
  const [busyId, setBusyId] = useState("");
  const [localRuns, setLocalRuns] = useState(runs);
  const [selectedRun, setSelectedRun] = useState<QaseyRun | null>(null);
  useEffect(() => setLocalRuns(runs), [runs]);
  const act = async (run: QaseyRun) => {
    setBusyId(run.id);
    try { const next = activeStatuses.includes(run.status) ? await api.cancelRun(run.id) : await api.rerun(run.id); setLocalRuns(current => current.map(item => item.id === run.id ? next : item)); }
    finally { setBusyId(""); }
  };
  if (loading && runs.length === 0) return <div className="table-loading"><LoaderCircle className="spin" size={20} />正在读取运行…</div>;
  if (runs.length === 0) return <div className="table-empty"><TestTube2 size={22} /><div><strong>还没有运行</strong><span>从一项 QA 任务开始，运行记录会出现在这里。</span></div></div>;
  return <><div className="run-table"><div className="run-row run-row--head"><span>运行</span><span>状态</span><span>证据</span><span>更新时间</span><span /></div>{localRuns.map(run => { const canCancel = activeStatuses.includes(run.status); const canRerun = ["succeeded", "failed", "cancelled"].includes(run.status); return <div className="run-row" key={run.id}><div className="run-name"><span className="run-icon">{run.framework === "playwright" ? <TestTube2 size={17} /> : <Gauge size={17} />}</span><div><strong>{run.repository.owner}/{run.repository.repository}</strong><span><code>{compactId(run.id)}</code> · {run.framework}</span></div></div><StatusBadge status={run.status} /><div className="artifact-count"><FileSearch size={15} />{run.artifacts.length} 项</div><span className="updated">{formatRelative(run.updatedAt)}</span><div className="row-actions">{expanded && run.pullRequestUrl && <a className="icon-button" href={run.pullRequestUrl} target="_blank" rel="noreferrer" aria-label="打开 Pull Request"><GitBranch size={16} /></a>}{(canCancel || canRerun) && <button className="icon-button" onClick={() => void act(run)} disabled={busyId === run.id} aria-label={canCancel ? "取消运行" : "重新运行"}>{busyId === run.id ? <LoaderCircle className="spin" size={16} /> : canCancel ? <Square size={15} /> : <RotateCcw size={16} />}</button>}<button className="icon-button" onClick={() => setSelectedRun(run)} aria-label="查看运行"><ChevronRight size={17} /></button></div></div>; })}</div>{selectedRun && <RunDetailDialog run={selectedRun} onClose={() => setSelectedRun(null)} />}</>;
}

function RunDetailDialog({ run, onClose }: { run: QaseyRun; onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}><section className="run-dialog" role="dialog" aria-modal="true" aria-labelledby="run-dialog-title"><div className="dialog-head"><div><p className="eyebrow">运行详情 · <span className="mono">{compactId(run.id)}</span></p><h2 id="run-dialog-title">{run.repository.owner}/{run.repository.repository}</h2><p>{run.framework === "playwright" ? "Web · Playwright" : "App · Maestro"} · 基于 {run.repository.baseRef}</p></div><button className="icon-button bordered" onClick={onClose} aria-label="关闭运行详情"><X size={18} /></button></div><div className="dialog-status"><StatusBadge status={run.status} /><span>更新于 {formatRelative(run.updatedAt)}</span>{run.pullRequestUrl && <a href={run.pullRequestUrl} target="_blank" rel="noreferrer"><GitBranch size={14} />打开 Pull Request</a>}</div><div className="dialog-section"><h3>证据轨</h3><EvidenceRail run={run} compact /></div><div className="dialog-section"><h3>证据产物 <span>{run.artifacts.length}</span></h3>{run.artifacts.length ? <div className="dialog-artifacts">{run.artifacts.map(artifact => <a key={artifact.id} href={`/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}`} target="_blank" rel="noreferrer"><span><FileSearch size={17} /></span><div><strong>{artifact.name}</strong><small>{artifact.kind}</small></div><ArrowRight size={15} /></a>)}</div> : <p className="dialog-empty">当前还没有证据产物。</p>}</div>{run.error && <div className="dialog-error"><CircleAlert size={17} /><div><strong>运行未完成</strong><p>{run.error}</p></div></div>}</section></div>;
}

function StatusBadge({ status }: { status: RunStatus }) { const meta = statusMeta[status]; const Icon = status === "succeeded" ? CheckCircle2 : status === "failed" ? XCircle : status === "awaiting_qa" ? ClipboardCheck : activeStatuses.includes(status) ? LoaderCircle : Clock3; return <span className={`status-badge ${meta.tone}`}><Icon className={activeStatuses.includes(status) ? "spin-slow" : ""} size={14} />{meta.label}</span>; }

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) { return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action}</div>; }

function EmptyState({ icon: Icon, title, text }: { icon: typeof ClipboardCheck; title: string; text: string }) { return <section className="surface empty-state"><span><Icon size={24} /></span><h2>{title}</h2><p>{text}</p></section>; }

function InlineError({ message, action, onAction }: { message: string; action?: string; onAction?: () => void | Promise<void> }) { return <div className="inline-error" role="alert"><CircleAlert size={18} /><span>{message}</span>{action && onAction && <button onClick={() => void onAction()}>{action}</button>}</div>; }

function NavButton({ item, active, onClick }: { item: { label: string; icon: typeof Gauge; badge?: number }; active: boolean; onClick: () => void }) { const Icon = item.icon; return <button className={active ? "nav-button active" : "nav-button"} onClick={onClick}><Icon size={18} /><span>{item.label}</span>{Boolean(item.badge) && <i>{item.badge}</i>}</button>; }

function BrandMark() { return <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>; }
function Avatar({ label }: { label: string }) { return <span className="avatar">{label.slice(0,1).toUpperCase()}</span>; }
function GoogleGlyph() { return <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4h5.4a4.6 4.6 0 0 1-2 3v2.6h3.2c1.9-1.7 3-4.3 3-7.4Z"/><path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4L15.4 17c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.7A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.5 14a6 6 0 0 1 0-3.9V7.4H3.2a10 10 0 0 0 0 9.2L6.5 14Z"/><path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 3.2 7.4l3.3 2.7A5.8 5.8 0 0 1 12 6Z"/></svg>; }

function displayName(session: Session): string { return session.email?.split("@")[0] ?? "QA Member"; }
function compactId(value: string): string { return value.length > 12 ? `${value.slice(0,8)}…${value.slice(-4)}` : value; }
function formatRelative(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; return shortDateFormatter.format(new Date(value)); }
function blobDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("浏览器画面格式无效。")); reader.onerror = () => reject(reader.error ?? new Error("无法读取浏览器画面。")); reader.readAsDataURL(blob); }); }
function friendlySsoError(error: string): string { let decoded = error; try { decoded = decodeURIComponent(error); } catch { /* malformed OAuth errors remain safe to display generically */ } if (/domain|hosted/iu.test(decoded)) return "此 Google 账户不属于允许的组织，请切换工作账户。"; if (/expired|state/iu.test(decoded)) return "登录链接已失效，请重新开始登录。"; return "Google 登录未完成，请重试；如果问题持续出现，请联系平台管理员。"; }
function extractAgentText(response: Record<string, unknown>): string { if (typeof response.text === "string") return response.text; const message = response.message; if (message && typeof message === "object" && "content" in message && typeof message.content === "string") return message.content; return "Qasey 已完成处理。打开运行记录查看后续进度与证据。"; }
function railDetail(run: QaseyRun, index: number): string { if (index === 0) return `${run.sourceCaseIds.length} 个来源`; if (index === 3) return run.framework === "playwright" ? "Playwright" : "Maestro"; if (index === 4) return `${run.artifacts.length} 项证据`; return index < statusMeta[run.status].step ? "已完成" : index === statusMeta[run.status].step ? statusMeta[run.status].label : "等待中"; }
function countFor(runs: QaseyRun[], id: "all" | "active" | "review" | "done"): number { if (id === "all") return runs.length; if (id === "active") return runs.filter(run => activeStatuses.includes(run.status)).length; if (id === "review") return runs.filter(run => run.status === "awaiting_qa").length; return runs.filter(run => ["succeeded","failed","cancelled"].includes(run.status)).length; }
