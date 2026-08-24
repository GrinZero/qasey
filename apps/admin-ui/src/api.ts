import type { AgentApplication, ApiTokenRecord, AuditRecord, CatalogEntry, QaseyRun, SandboxSessionState, Session, TriggerConnection, TriggerProvider, TriggerTarget } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401) window.dispatchEvent(new Event("qasey:unauthorized"));
    const message = typeof body.message === "string"
      ? body.message
      : response.status === 401
        ? "登录已过期，请重新登录。"
        : response.status === 403 || response.status === 404
          ? "你没有执行此操作的权限。"
          : "请求未完成，请稍后重试。";
    throw new ApiError(message, response.status, typeof body.requestId === "string" ? body.requestId : undefined);
  }
  return await response.json() as T;
}

async function requestBlob(url: string): Promise<{ blob: Blob; url?: string; title?: string }> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("qasey:unauthorized"));
    throw new ApiError("无法读取实时画面。", response.status);
  }
  return {
    blob: await response.blob(),
    ...(response.headers.get("x-qasey-browser-url") ? { url: decodeURIComponent(response.headers.get("x-qasey-browser-url") ?? "") } : {}),
    ...(response.headers.get("x-qasey-browser-title") ? { title: decodeURIComponent(response.headers.get("x-qasey-browser-title") ?? "") } : {}),
  };
}

export const api = {
  session: () => requestJson<Session>("/admin/api/session"),
  catalog: () => requestJson<CatalogEntry[]>("/admin/api/catalog"),
  applications: () => requestJson<AgentApplication[]>("/admin/api/applications"),
  listRuns: () => requestJson<{ runs: QaseyRun[] }>("/v1/runs?limit=100"),
  runQaseyTask: (prompt: string) => requestJson<Record<string, unknown>>(
    "/v1/qasey/tasks",
    { method: "POST", body: JSON.stringify({ prompt }) },
  ),
  cancelRun: (runId: string) => requestJson<QaseyRun>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  rerun: (runId: string) => requestJson<QaseyRun>(`/v1/runs/${encodeURIComponent(runId)}/rerun`, { method: "POST" }),
  sandboxState: (sessionId: string) => requestJson<SandboxSessionState>(`/v1/sandbox-sessions/${encodeURIComponent(sessionId)}`),
  browserStart: (sessionId: string, url?: string) => requestJson<SandboxSessionState>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/browser/start`,
    { method: "POST", body: JSON.stringify({ ...(url ? { url } : {}) }) },
  ),
  browserAction: (sessionId: string, action: Record<string, unknown>) => requestJson<SandboxSessionState>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/browser/action`,
    { method: "POST", body: JSON.stringify(action) },
  ),
  browserFrame: (sessionId: string) => requestBlob(`/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/browser/frame`),
  desktopStart: (sessionId: string, input: { application?: "none" | "browser" | "terminal" | "editor" | "files"; url?: string; recordVideo?: boolean } = {}) => requestJson<SandboxSessionState>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/desktop/start`,
    { method: "POST", body: JSON.stringify(input) },
  ),
  desktopAction: (sessionId: string, action: Record<string, unknown>) => requestJson<SandboxSessionState & { result?: unknown }>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/desktop/action`,
    { method: "POST", body: JSON.stringify(action) },
  ),
  desktopApplication: (sessionId: string, application: "browser" | "terminal" | "editor" | "files", url?: string) => requestJson<SandboxSessionState>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/desktop/app`,
    { method: "POST", body: JSON.stringify({ application, ...(url ? { url } : {}) }) },
  ),
  desktopFrame: (sessionId: string) => requestBlob(`/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/desktop/frame`),
  desktopStop: (sessionId: string) => requestJson<SandboxSessionState>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/desktop/stop`, { method: "POST" },
  ),
  sandboxStop: (sessionId: string) => requestJson<{ stopped: true }>(
    `/v1/sandbox-sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST" },
  ),
  verdict: (runId: string, verdict: "approve" | "request_changes", feedback?: string) => requestJson<QaseyRun>(
    `/v1/runs/${encodeURIComponent(runId)}/qa-verdict`,
    { method: "POST", body: JSON.stringify({ verdict, ...(feedback ? { feedback } : {}) }) },
  ),
  audit: () => requestJson<{ records: AuditRecord[] }>("/admin/api/audit"),
  apiTokens: () => requestJson<{ tokens: ApiTokenRecord[]; availableScopes: string[] }>("/admin/api/tokens"),
  createApiToken: (input: { name: string; scopes: string[]; expiresAt?: string }) =>
    requestJson<{ token: string; record: ApiTokenRecord }>("/admin/api/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeApiToken: (tokenId: string) => requestJson<{ revoked: true }>(
    `/admin/api/tokens/${encodeURIComponent(tokenId)}`,
    { method: "DELETE" },
  ),
  grant: (role: string, permission: string) => requestJson<{ granted: boolean }>("/admin/api/permissions/grants", {
    method: "POST",
    body: JSON.stringify({ role, permission }),
  }),
  bind: (subjectId: string, role: string) => requestJson<{ bound: boolean }>("/admin/api/permissions/bindings", {
    method: "POST",
    body: JSON.stringify({ subjectId, role }),
  }),
  triggerProviders: () => requestJson<{ providers: TriggerProvider[] }>("/admin/api/triggers/providers"),
  triggerConnections: () => requestJson<{ connections: TriggerConnection[] }>("/admin/api/triggers/connections"),
  triggerTargets: (providerId: string) => requestJson<{ targets: TriggerTarget[] }>(
    `/admin/api/triggers/providers/${encodeURIComponent(providerId)}/targets`,
  ),
  createTriggerConnection: (input: { providerId: string; displayName: string; targetId: string; configuration: Record<string, string> }) =>
    requestJson<{ connection: TriggerConnection }>("/admin/api/triggers/connections", { method: "POST", body: JSON.stringify(input) }),
  updateTriggerConfiguration: (providerId: string, id: string, revision: number, configuration: Record<string, string>) =>
    requestJson<{ connection: TriggerConnection }>(`/admin/api/triggers/connections/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/configuration`, {
      method: "PATCH", body: JSON.stringify({ revision, configuration }),
    }),
  rebindTriggerConnection: (providerId: string, id: string, revision: number, targetId: string) =>
    requestJson<{ connection: TriggerConnection }>(`/admin/api/triggers/connections/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/rebind`, {
      method: "POST", body: JSON.stringify({ revision, targetId }),
    }),
  setTriggerConnectionEnabled: (providerId: string, id: string, revision: number, enabled: boolean) =>
    requestJson<{ connection: TriggerConnection }>(`/admin/api/triggers/connections/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}/status`, {
      method: "POST", body: JSON.stringify({ revision, enabled }),
    }),
  deleteTriggerConnection: (providerId: string, id: string, revision: number) =>
    requestJson<{ deleted: boolean }>(`/admin/api/triggers/connections/${encodeURIComponent(providerId)}/${encodeURIComponent(id)}`, {
      method: "DELETE", body: JSON.stringify({ revision }),
    }),
  loginUrl: (redirectUri = "/admin") => requestJson<{ url: string }>(
    `/auth/google/login?${new URLSearchParams({ redirect_uri: redirectUri })}`,
  ),
  logout: () => requestJson<{ success: boolean }>("/auth/logout", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message} 请求 ID：${error.requestId}` : error.message;
  return error instanceof Error ? error.message : "发生了未知错误。";
}
