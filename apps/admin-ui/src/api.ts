import type { AgentApplication, AuditRecord, CatalogEntry, QaseyRun, Session } from "./types";

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
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
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
  return body as T;
}

export const api = {
  session: () => requestJson<Session>("/admin/api/session"),
  catalog: () => requestJson<CatalogEntry[]>("/admin/api/catalog"),
  applications: () => requestJson<AgentApplication[]>("/admin/api/applications"),
  listRuns: () => requestJson<{ runs: QaseyRun[] }>("/v1/runs?limit=100"),
  runAgent: (agentId: string, prompt: string) => requestJson<Record<string, unknown>>(
    `/studio/api/agents/${encodeURIComponent(agentId)}/generate`,
    { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }) },
  ),
  cancelRun: (runId: string) => requestJson<QaseyRun>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  rerun: (runId: string) => requestJson<QaseyRun>(`/v1/runs/${encodeURIComponent(runId)}/rerun`, { method: "POST" }),
  verdict: (runId: string, verdict: "approve" | "request_changes", feedback?: string) => requestJson<QaseyRun>(
    `/v1/runs/${encodeURIComponent(runId)}/qa-verdict`,
    { method: "POST", body: JSON.stringify({ verdict, ...(feedback ? { feedback } : {}) }) },
  ),
  audit: () => requestJson<{ records: AuditRecord[] }>("/admin/api/audit"),
  grant: (role: string, permission: string) => requestJson<{ granted: boolean }>("/admin/api/permissions/grants", {
    method: "POST",
    body: JSON.stringify({ role, permission }),
  }),
  bind: (subjectId: string, role: string) => requestJson<{ bound: boolean }>("/admin/api/permissions/bindings", {
    method: "POST",
    body: JSON.stringify({ subjectId, role }),
  }),
  loginUrl: () => requestJson<{ url: string }>("/auth/google/login?redirect_uri=%2Fadmin"),
  logout: () => requestJson<{ success: boolean }>("/auth/logout", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message} 请求 ID：${error.requestId}` : error.message;
  return error instanceof Error ? error.message : "发生了未知错误。";
}
