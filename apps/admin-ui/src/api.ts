import { QaseyUIMessageSchema, type AgentApplication, type ApiTokenRecord, type AuditRecord, type AuthConfig, type AuthRedirect, type CaseHubCase, type CaseHubCaseVersion, type CaseHubChangeSet, type CaseHubResult, type CatalogEntry, type OrganizationSelection, type QaseyConversation, type QaseyRun, type QaseyUIMessage, type Session, type TriggerConnection, type TriggerProvider, type TriggerTarget } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  options: { broadcastUnauthorized?: boolean } = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401 && options.broadcastUnauthorized !== false) {
      window.dispatchEvent(new Event("qasey:unauthorized"));
    }
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

async function streamEvents(
  url: string,
  init: RequestInit,
  onEvent: (event: { type: "snapshot"; payload: { run: QaseyRun } }) => void,
): Promise<void> {
  const response = await fetch(url, { ...init, headers: { accept: "text/event-stream", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 401) window.dispatchEvent(new Event("qasey:unauthorized"));
    throw new ApiError(typeof body.message === "string" ? body.message : "实时连接未能建立。", response.status);
  }
  if (!response.body) throw new ApiError("浏览器不支持实时响应。", 500);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const eventName = block.split("\n").find(line => line.startsWith("event: "))?.slice(7);
      const data = block.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
      if (!eventName || !data) continue;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (eventName === "snapshot") onEvent({ type: "snapshot", payload: parsed as { run: QaseyRun } });
    }
    if (done) break;
  }
}

export const api = {
  session: () => requestJson<Session>(
    "/admin/api/session",
    undefined,
    { broadcastUnauthorized: false },
  ),
  catalog: () => requestJson<CatalogEntry[]>("/admin/api/catalog"),
  applications: () => requestJson<AgentApplication[]>("/admin/api/applications"),
  listConversations: () => requestJson<{ conversations: QaseyConversation[] }>("/v1/qasey/conversations?limit=50"),
  createConversation: () => requestJson<{ conversation: QaseyConversation }>("/v1/qasey/conversations", { method: "POST" }),
  getConversation: async (id: string) => {
    const response = await requestJson<{ conversation: QaseyConversation; messages: unknown[] }>(`/v1/qasey/conversations/${encodeURIComponent(id)}`);
    return {
      conversation: response.conversation,
      messages: response.messages.map((message, index) => {
        const parsed = QaseyUIMessageSchema.safeParse(message);
        if (!parsed.success) throw new ApiError(`会话消息 ${index + 1} 的格式无效。`, 502);
        return parsed.data as QaseyUIMessage;
      }),
    };
  },
  streamRun: (runId: string, onRun: (run: QaseyRun) => void, signal?: AbortSignal) =>
    streamEvents(`/v1/case-hub/runs/${encodeURIComponent(runId)}/events`, signal ? { signal } : {}, event => { if (event.type === "snapshot") onRun(event.payload.run); }),
  listRuns: () => requestJson<{ runs: QaseyRun[] }>("/v1/case-hub/runs?limit=100"),
  listCases: (query = "") => requestJson<{ cases: CaseHubCase[] }>(`/v1/case-hub/cases?q=${encodeURIComponent(query)}`),
  getCase: (id: string) => requestJson<{ case: CaseHubCase; versions: CaseHubCaseVersion[]; changeSets: CaseHubChangeSet[]; results: CaseHubResult[] }>(`/v1/case-hub/cases/${encodeURIComponent(id)}`),
  listChangeSets: () => requestJson<{ changeSets: CaseHubChangeSet[] }>("/v1/case-hub/change-sets?limit=100"),
  getChangeSet: (id: string) => requestJson<{ changeSet: CaseHubChangeSet; versions: CaseHubCaseVersion[]; results: CaseHubResult[] }>(`/v1/case-hub/change-sets/${encodeURIComponent(id)}`),
  reviewCaseResult: (id: string, verdict: "approve" | "request_changes" | "product_bug" | "environment_issue", feedback?: string) => requestJson<{ result: CaseHubResult; changeSet: CaseHubChangeSet }>(`/v1/case-hub/results/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({ verdict, ...(feedback ? { feedback } : {}) }) }),
  cancelRun: (runId: string) => requestJson<QaseyRun>(`/v1/case-hub/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
  rerun: (runId: string) => requestJson<QaseyRun>(`/v1/case-hub/runs/${encodeURIComponent(runId)}/rerun`, { method: "POST" }),
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
  authConfig: () => requestJson<AuthConfig>(
    "/auth/config",
    undefined,
    { broadcastUnauthorized: false },
  ),
  passwordLogin: (input: { email: string; password: string; redirectUri: string }) => requestJson<AuthRedirect>(
    "/auth/password/login",
    { method: "POST", body: JSON.stringify(input) },
    { broadcastUnauthorized: false },
  ),
  passwordRegister: (input: { displayName: string; email: string; password: string; redirectUri: string }) => requestJson<AuthRedirect>(
    "/auth/password/register",
    { method: "POST", body: JSON.stringify(input) },
    { broadcastUnauthorized: false },
  ),
  organizationSelection: () => requestJson<{ selection: OrganizationSelection | null }>("/auth/organization-selection"),
  selectOrganization: (organizationId: string) => requestJson<{ redirectTo: string }>("/auth/organization-selection", {
    method: "POST",
    body: JSON.stringify({ organizationId }),
  }),
  logout: () => requestJson<{ success: boolean }>("/auth/logout", { method: "POST" }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.requestId ? `${error.message} 请求 ID：${error.requestId}` : error.message;
  return error instanceof Error ? error.message : "发生了未知错误。";
}
